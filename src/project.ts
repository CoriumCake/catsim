/* CatSim — project model: validation of untrusted projects and share-link encoding. */
import type { PartDef, Project, Wire, Component } from './types.ts';

export const PROJECT_VERSION = 1;
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const MAX_CODE = 200_000;

const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function cleanProps(d: PartDef, src: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d.props };
  if (!src || typeof src !== 'object') return out;
  const s = src as Record<string, unknown>;
  for (const k of Object.keys(d.props)) {
    if (!has(s, k)) continue;
    const ct = (d.controls || []).find((x) => x.key === k);
    if (!ct) continue;
    const v = s[k];
    if (ct.type === 'range') out[k] = Math.min(ct.max, Math.max(ct.min, num(v, d.props[k] as number)));
    else if (ct.type === 'select') {
      if (ct.options.map(String).includes(String(v))) out[k] = typeof d.props[k] === 'number' ? Number(v) : String(v);
    } else if (ct.type === 'toggle') out[k] = v === true;
    else if (ct.type === 'spice') out[k] = typeof v === 'string' && v.length <= ct.maxLength ? v : '';
  }
  return out;
}

/**
 * Projects come from share links and imported files, i.e. untrusted input. Rebuild them field by
 * field with strict types so nothing unexpected can reach the SVG/HTML templates.
 */
export function normalizeProject(p: unknown, defs: Record<string, PartDef>): Project {
  const src = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const comps: Component[] = [];
  for (const c of Array.isArray(src.components) ? src.components : []) {
    if (!c || typeof c !== 'object') continue;
    const { id, type } = c as Record<string, unknown>;
    if (typeof type !== 'string' || !has(defs, type) || typeof id !== 'string' || !ID.test(id) || seen.has(id)) continue;
seen.add(id);
    const cc = c as Record<string, unknown>;
    comps.push({ id, type, x: Math.round(num(cc.x)), y: Math.round(num(cc.y)), props: cleanProps(defs[type], cc.props) });
  }
  if (!comps.some((c) => defs[c.type].board)) comps.unshift({ id: seen.has('esp') ? 'esp32' : 'esp', type: 'esp32', x: 300, y: 80, props: {} });

  const byId = new Map(comps.map((c) => [c.id, c]));
  const validPin = (ref: unknown): ref is string => {
    if (typeof ref !== 'string') return false;
    const i = ref.indexOf(':');
    const c = byId.get(ref.slice(0, i));
    return !!c && defs[c.type].pins.some((pin) => pin.id === ref.slice(i + 1));
  };
  const wids = new Set<string>();
  const wires: Wire[] = [];
  let n = 0;
  for (const w of Array.isArray(src.wires) ? src.wires : []) {
    if (!w || typeof w !== 'object') continue;
    const ww = w as Record<string, unknown>;
    if (!validPin(ww.from) || !validPin(ww.to) || ww.from === ww.to) continue;
    let id = typeof ww.id === 'string' && ID.test(ww.id) && !wids.has(ww.id) ? ww.id : null;
    while (!id || wids.has(id)) id = 'w' + ++n;
    wids.add(id);
    const wire: Wire = { id, from: ww.from, to: ww.to };
    if (typeof ww.color === 'string' && COLOR.test(ww.color)) wire.color = ww.color;
    wires.push(wire);
  }
  const out: Project = {
    name: String(typeof src.name === 'string' && src.name ? src.name : 'Untitled project').slice(0, 120),
    code: typeof src.code === 'string' ? src.code.slice(0, MAX_CODE) : '',
    components: comps,
    wires,
  };
  if (src.wireStyle === 'tidy') out.wireStyle = 'tidy';
  // (old projects may carry compiled Uno firmware: it is dropped, the board runs its sketch)
  // programs of the other boards
  const boards = comps.filter((c) => defs[c.type].board);
  const progs = src.programs && typeof src.programs === 'object' ? src.programs as Record<string, unknown> : {};
  for (const b of boards.slice(1)) {
    const pr = progs[b.id] as Record<string, unknown> | undefined;
    if (!pr || typeof pr !== 'object' || !Object.prototype.hasOwnProperty.call(progs, b.id)) continue;
    const entry: { code?: string } = {};
    if (typeof pr.code === 'string') entry.code = pr.code.slice(0, MAX_CODE);
    (out.programs ??= {})[b.id] = entry;
  }
  return out;
}

// ---------- share links ----------
// #z=<base64url(deflate-raw(JSON))> with a schema version inside. Old #p=<base64(JSON)> links still load.

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('Shared project is too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function encodeShare(project: Project): Promise<string> {
  const json = JSON.stringify({ v: PROJECT_VERSION, ...project });
  const packed = await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return '#z=' + b64url(packed);
}

/** Returns the raw (still untrusted) project from a location hash, or null if there is none. */
export async function decodeShare(hash: string): Promise<unknown | null> {
  let m = /^#z=([A-Za-z0-9_-]+)$/.exec(hash);
  if (m) {
    const json = await pipe(unb64url(m[1]), new DecompressionStream('deflate-raw'), 2_000_000);
    const p = JSON.parse(new TextDecoder().decode(json));
    if (p && typeof p === 'object' && typeof p.v === 'number' && p.v > PROJECT_VERSION) {
      throw new Error('This link was made with a newer version of CatSim');
    }
    return p;
  }
  m = /^#p=(.+)$/.exec(hash);
  if (m) {
    const bin = atob(decodeURIComponent(m[1]));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  return null;
}
