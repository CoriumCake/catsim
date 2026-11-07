/* Electrical nets of a project: pins joined by wires only (unlike the logic-level net solver in
 * runtime.js, which also merges pins connected *inside* parts, e.g. both ends of a resistor). */
import type { Project, PartDef } from '../types.ts';

export interface WireNets {
  /** pin key "compId:pinId" → root key of its net */
  rootOf: Map<string, string>;
  /** root key → pin keys on that net */
  members: Map<string, string[]>;
}

export function wireNets(p: Project, defs: Record<string, PartDef>): WireNets {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k; while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(k) !== r) { const n = parent.get(k)!; parent.set(k, r); k = n; }
    return r;
  };
  for (const c of p.components) for (const pin of defs[c.type]?.pins ?? []) parent.set(`${c.id}:${pin.id}`, `${c.id}:${pin.id}`);
  const union = (a: string, b: string) => { if (!parent.has(a) || !parent.has(b)) return; const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const w of p.wires) union(w.from, w.to);
  // pins joined on a board itself (ESP32 GND.L/GND.R, Uno GND pins and A4=SDA/A5=SCL)
  for (const c of p.components) {
    const d = defs[c.type];
    if (!d?.board || !d.internal) continue;
    for (const [a, b] of d.internal(c, {} as never)) union(`${c.id}:${a}`, `${c.id}:${b}`);
  }
  const rootOf = new Map<string, string>(), members = new Map<string, string[]>();
  for (const k of parent.keys()) {
    const r = find(k); rootOf.set(k, r);
    const m = members.get(r); if (m) m.push(k); else members.set(r, [k]);
  }
  return { rootOf, members };
}
