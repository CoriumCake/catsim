/* Orthogonal wire router for the 2D diagram (like a schematic/PCB autorouter, much simpler).
 *
 * A* on a 10 px grid. Part bodies are obstacles; wires leave a pin in its direction for a short stub
 * before turning. Costs: distance, a penalty per bend (fewer, straighter wires), a penalty for running
 * along a track another wire already uses (parallel wires spread out instead of stacking), a small one
 * for crossing a wire, and for hugging a part outline. Routes are polylines in diagram coordinates. */

export interface Rect { x: number; y: number; w: number; h: number }
export interface PinEnd { x: number; y: number; dir: string }
export type Pt = [number, number];

const G = 10;              // grid pitch (px)
const BEND = 6;            // cost of a 90° turn (in grid steps)
const SHARE = 8;           // cost of a cell another wire already runs along in the same direction
const CROSS = 2;           // cost of crossing another wire
const NEAR = 1.5;          // cost of cells right next to a part
const MAX_EXPAND = 60_000; // safety valve for huge canvases
const DIRS: Record<string, Pt> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
const STEPS: Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Binary min-heap keyed on f. */
class Heap {
  private a: number[] = []; private f: number[] = [];
  get size() { return this.a.length; }
  push(v: number, f: number) {
    const a = this.a, fs = this.f; a.push(v); fs.push(f);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (fs[p] <= fs[i]) break; [a[p], a[i]] = [a[i], a[p]]; [fs[p], fs[i]] = [fs[i], fs[p]]; i = p; }
  }
  pop(): number {
    const a = this.a, fs = this.f, top = a[0], last = a.pop()!, lf = fs.pop()!;
    if (a.length) {
      a[0] = last; fs[0] = lf; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && fs[l] < fs[m]) m = l;
        if (r < a.length && fs[r] < fs[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; [fs[m], fs[i]] = [fs[i], fs[m]]; i = m;
      }
    }
    return top;
  }
}

/** Routing grid over the diagram: blocked cells (part bodies), "near" cells, and wire occupancy. */
export class RouteGrid {
  readonly x0: number; readonly y0: number; readonly cols: number; readonly rows: number;
  private blocked: Uint8Array; private near: Uint8Array;
  /** occupancy by direction: bit 1 = horizontal run, bit 2 = vertical run */
  private occ: Uint8Array;

  constructor(parts: Rect[], extra: Rect[] = []) {
    const all = [...parts, ...extra];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of all) { minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
    const pad = 120;
    this.x0 = Math.floor((minX - pad) / G) * G; this.y0 = Math.floor((minY - pad) / G) * G;
    this.cols = Math.ceil((maxX + pad - this.x0) / G) + 1; this.rows = Math.ceil((maxY + pad - this.y0) / G) + 1;
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n); this.near = new Uint8Array(n); this.occ = new Uint8Array(n);
    for (const r of parts) {
      // body (shrunk a little so pins on the edge stay reachable), plus a "near" halo
      this.mark(r.x + 3, r.y + 3, r.w - 6, r.h - 6, this.blocked);
      this.mark(r.x - G, r.y - G, r.w + 2 * G, r.h + 2 * G, this.near);
    }
  }

  private mark(x: number, y: number, w: number, h: number, arr: Uint8Array) {
    const c0 = Math.max(0, Math.ceil((x - this.x0) / G)), c1 = Math.min(this.cols - 1, Math.floor((x + w - this.x0) / G));
    const r0 = Math.max(0, Math.ceil((y - this.y0) / G)), r1 = Math.min(this.rows - 1, Math.floor((y + h - this.y0) / G));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) arr[r * this.cols + c] = 1;
  }

  cellOf(x: number, y: number): Pt {
    return [Math.min(this.cols - 1, Math.max(0, Math.round((x - this.x0) / G))), Math.min(this.rows - 1, Math.max(0, Math.round((y - this.y0) / G)))];
  }
  pos(c: number, r: number): Pt { return [this.x0 + c * G, this.y0 + r * G]; }

  /** Record a routed polyline so later wires avoid running on top of it. */
  occupy(pts: Pt[]) {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = this.cellOf(...pts[i - 1]), [bx, by] = this.cellOf(...pts[i]);
      const horiz = ay === by, bit = horiz ? 1 : 2;
      const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let k = 0; k <= n; k++) {
        const c = ax + Math.sign(bx - ax) * k, r = ay + Math.sign(by - ay) * k;
        this.occ[r * this.cols + c] |= bit;
      }
    }
  }

  /**
   * Route from pin a to pin b. Returns the polyline (starting at a, ending at b), or null if there is no
   * way through (then the caller falls back to a curve).
   */
  route(a: PinEnd, b: PinEnd): Pt[] | null {
    const { cols, rows } = this;
    const stub = (p: PinEnd): Pt => { const d = DIRS[p.dir] || [0, 0]; return [p.x + d[0] * 2 * G, p.y + d[1] * 2 * G]; };
    const sa = stub(a), sb = stub(b);
    const [sc, sr] = this.cellOf(...sa), [tc, tr] = this.cellOf(...sb);
    const N = cols * rows;
    // state = cell * 4 + direction of arrival (0..3), so bends can be costed
    const gScore = new Float64Array(N * 4).fill(Infinity);
    const from = new Int32Array(N * 4).fill(-1);
    const heap = new Heap();
    const h = (c: number, r: number) => Math.abs(c - tc) + Math.abs(r - tr);
    const startDir = STEPS.findIndex(([dx, dy]) => { const d = DIRS[a.dir]; return d && d[0] === dx && d[1] === dy; });
    const s0 = (sr * cols + sc) * 4 + (startDir < 0 ? 0 : startDir);
    gScore[s0] = 0; heap.push(s0, h(sc, sr));
    const endDir = (() => { const d = DIRS[b.dir]; return d ? STEPS.findIndex(([dx, dy]) => dx === -d[0] && dy === -d[1]) : -1; })();
    let found = -1, expanded = 0;
    while (heap.size && expanded++ < MAX_EXPAND) {
      const s = heap.pop();
      const cell = s >> 2, dir = s & 3, c = cell % cols, r = (cell / cols) | 0;
      if (c === tc && r === tr) { found = s; break; }
      const g0 = gScore[s];
      for (let nd = 0; nd < 4; nd++) {
        const [dx, dy] = STEPS[nd];
        if (dx === -STEPS[dir][0] && dy === -STEPS[dir][1] && s !== s0) continue; // no U-turns
        const nc = c + dx, nr = r + dy;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        const isEnd = nc === tc && nr === tr;
        if (this.blocked[ni] && !isEnd) continue;
        const bit = dy === 0 ? 1 : 2;
        let cost = 1 + (nd !== dir ? BEND : 0);
        if (this.occ[ni] & bit) cost += SHARE; else if (this.occ[ni]) cost += CROSS;
        if (this.near[ni]) cost += NEAR;
        if (isEnd && endDir >= 0 && nd !== endDir) cost += BEND; // arrive straight into the end stub
        const ns = ni * 4 + nd, g = g0 + cost;
        if (g < gScore[ns]) { gScore[ns] = g; from[ns] = s; heap.push(ns, g + h(nc, nr)); }
      }
    }
    if (found < 0) return null;
    const cells: Pt[] = [];
    for (let s = found; s >= 0; s = from[s]) cells.push(this.pos((s >> 2) % cols, ((s >> 2) / cols) | 0));
    cells.reverse();
    // pin → (elbow) → grid path → (elbow) → pin, then drop collinear points
    const last = cells[cells.length - 1];
    return simplify([[a.x, a.y], ...elbow([a.x, a.y], cells[0], a.dir), ...cells, ...elbow([b.x, b.y], last, b.dir), [b.x, b.y]]);
  }
}

/** Orthogonal connection from a pin to the first grid point, leaving in the pin's direction. */
function elbow(p: Pt, q: Pt, dir: string): Pt[] {
  if (p[0] === q[0] || p[1] === q[1]) return [];
  return dir === 'l' || dir === 'r' ? [[q[0], p[1]]] : [[p[0], q[1]]];
}

/** Remove duplicate and collinear points. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** SVG path for a polyline with rounded corners. */
export function roundedPath(pts: Pt[], radius = 6): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / l1) * r, ay = y - ((y - py) / l1) * r;
    const bx = x + ((nx - x) / l2) * r, by = y + ((ny - y) / l2) * r;
    d += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`;
  }
  const e = pts[pts.length - 1];
  return d + ` L${e[0]} ${e[1]}`;
}
