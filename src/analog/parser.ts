/* SPICE netlist parser → Circuit.
 *
 * Supported: R C L V I D Q M E G X elements; DC / PULSE / SIN sources; .model for D, NPN, PNP, NMOS,
 * PMOS (level 1); .subckt/.ends (nested, no parameters); '+' continuation lines; '*' and ';' comments;
 * engineering suffixes (T G MEG K M MIL U N P F) with trailing units ("10kOhm", "4.7uF").
 * Analysis commands (.tran, .op, .options, .control blocks…) are ignored. Input is untrusted: every
 * error reports its line number, and sizes are capped. */
import { Circuit, type DiodeModel } from './circuit.ts';
import { Bjt, Mosfet, Vcvs, Vccs, type BjtModel, type MosModel } from './devices.ts';
import { dc, type Waveform } from './waveform.ts';

export class SpiceError extends Error {
  constructor(message: string, public line: number) { super(`line ${line}: ${message}`); }
}

const SUFFIX: Array<[RegExp, number]> = [
  [/^meg/, 1e6], [/^mil/, 25.4e-6], [/^t/, 1e12], [/^g/, 1e9], [/^k/, 1e3],
  [/^m/, 1e-3], [/^u|^µ/, 1e-6], [/^n/, 1e-9], [/^p/, 1e-12], [/^f/, 1e-15],
];

/** Parse a SPICE number like "4.7k", "10uF", "1e-3", "2MEG". Returns NaN if it is not a number. */
export function spiceNumber(s: string): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-zµ]*)$/i.exec(s.trim());
  if (!m) return NaN;
  const base = parseFloat(m[1]);
  const rest = m[2].toLowerCase();
  for (const [re, k] of SUFFIX) if (re.test(rest)) return base * k;
  return base; // trailing unit only (e.g. "5V", "100ohm")
}

interface Line { n: number; text: string }
interface Subckt { name: string; ports: string[]; body: Line[] }

const MAX_LINES = 20_000, MAX_DEPTH = 10, MAX_ELEMENTS = 5_000;

function logicalLines(src: string): Line[] {
  const raw = src.replace(/\r/g, '').split('\n');
  if (raw.length > MAX_LINES) throw new SpiceError(`netlist too long (over ${MAX_LINES} lines)`, MAX_LINES);
  const out: Line[] = [];
  raw.forEach((l, i) => {
    const t = l.replace(/[;$].*$/, '').trim(); // inline comments
    if (!t || t.startsWith('*')) return;
    if (t.startsWith('+') && out.length) out[out.length - 1].text += ' ' + t.slice(1).trim();
    else out.push({ n: i + 1, text: t });
  });
  return out;
}

/** Split "PULSE(0 5 1u)" style arguments and key=value pairs into tokens. */
function tokens(s: string): string[] {
  return s.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').replace(/=/g, ' = ').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
}

function parseParams(toks: string[], line: number): Record<string, number> {
  const p: Record<string, number> = {};
  const t = toks.filter((x) => x !== '(' && x !== ')');
  for (let i = 0; i < t.length; i++) {
    if (t[i + 1] === '=') {
      const v = spiceNumber(t[i + 2] ?? '');
      if (Number.isNaN(v)) throw new SpiceError(`bad value for ${t[i]}`, line);
      p[t[i].toLowerCase()] = v; i += 2;
    }
  }
  return p;
}

function parseSource(toks: string[], line: number): Waveform {
  const up = toks.map((t) => t.toUpperCase());
  const fn = up.findIndex((t) => t === 'PULSE' || t === 'SIN');
  const nums = (from: number) => {
    const out: number[] = [];
    for (let i = from; i < toks.length && toks[i] !== ')'; i++) if (toks[i] !== '(') out.push(spiceNumber(toks[i]));
    if (out.some(Number.isNaN)) throw new SpiceError('bad source value', line);
    return out;
  };
  if (fn >= 0) {
    const a = nums(fn + 1);
    if (up[fn] === 'PULSE') {
      const [v1 = 0, v2 = 0, td = 0, tr = 1e-9, tf = 1e-9, pw = Infinity, per = 0] = a;
      return { kind: 'pulse', v1, v2, td, tr: tr || 1e-9, tf: tf || 1e-9, pw, per };
    }
    const [vo = 0, va = 0, freq = 0, td = 0] = a;
    return { kind: 'sin', vo, va, freq, td };
  }
  const di = up.indexOf('DC');
  const v = spiceNumber(toks[di >= 0 ? di + 1 : 0] ?? '0');
  if (Number.isNaN(v)) throw new SpiceError('bad source value', line);
  return dc(v);
}

export interface ParsedNetlist {
  circuit: Circuit;
  /** node name (lower case) → node index; "0" and "gnd" are ground */
  nodes: Map<string, number>;
  title: string;
}

export function parseNetlist(src: string, opts: { firstLineIsTitle?: boolean } = {}): ParsedNetlist {
  let lines = logicalLines(src);
  let title = '';
  // A .cir file's first line is its title (SPICE convention); model libraries have none.
  if (opts.firstLineIsTitle && lines.length) { title = lines[0].text; lines = lines.slice(1); }
  // collect .model and .subckt definitions, skip .control blocks, stop at .end
  const models = new Map<string, { type: string; p: Record<string, number> }>();
  const subckts = new Map<string, Subckt>();
  const top: Line[] = [];
  let cur: Subckt | null = null, inControl = false;
  for (const l of lines) {
    const t = l.text, low = t.toLowerCase();
    if (inControl) { if (low.startsWith('.endc')) inControl = false; continue; }
    if (low.startsWith('.control')) { inControl = true; continue; }
    if (low === '.end') break;
    if (low.startsWith('.model')) {
      const tk = tokens(t);
      if (tk.length < 3) throw new SpiceError('.model needs a name and a type', l.n);
      models.set(tk[1].toLowerCase(), { type: tk[2].toLowerCase(), p: parseParams(tk.slice(3), l.n) });
      continue;
    }
    if (low.startsWith('.subckt')) {
      if (cur) throw new SpiceError('nested .subckt definitions are not supported', l.n);
      const tk = t.split(/\s+/);
      if (tk.length < 2) throw new SpiceError('.subckt needs a name', l.n);
      cur = { name: tk[1].toLowerCase(), ports: tk.slice(2).filter((x) => !x.includes('=')).map((x) => x.toLowerCase()), body: [] };
      continue;
    }
    if (low.startsWith('.ends')) { if (!cur) throw new SpiceError('.ends without .subckt', l.n); subckts.set(cur.name, cur); cur = null; continue; }
    if (low.startsWith('.')) continue; // analysis / option cards
    (cur ? cur.body : top).push(l);
  }
  if (cur) throw new SpiceError(`.subckt ${cur.name} is missing .ends`, lines[lines.length - 1]?.n ?? 0);

  const c = new Circuit();
  const nodes = new Map<string, number>([['0', 0], ['gnd', 0]]);
  const node = (name: string) => {
    const k = name.toLowerCase();
    let n = nodes.get(k);
    if (n === undefined) { n = c.node(k); nodes.set(k, n); }
    return n;
  };

  const expand = (body: Line[], map: (n: string) => string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new SpiceError('subcircuits nested too deeply', body[0]?.n ?? 0);
    for (const l of body) {
      if (c.elements.length > MAX_ELEMENTS) throw new SpiceError(`too many elements (over ${MAX_ELEMENTS})`, l.n);
      const tk = tokens(l.text);
      const name = prefix + tk[0];
      const kind = tk[0][0].toUpperCase();
      const nd = (i: number) => { if (!tk[i] || tk[i] === '(' || tk[i] === '=') throw new SpiceError(`${tk[0]}: missing node`, l.n); return node(map(tk[i])); };
      const val = (i: number) => { const v = spiceNumber(tk[i] ?? ''); if (Number.isNaN(v)) throw new SpiceError(`${tk[0]}: bad value "${tk[i] ?? ''}"`, l.n); return v; };
      const model = (name: string, kinds: string[]) => {
        const m = models.get((name ?? '').toLowerCase());
        if (!m) throw new SpiceError(`${tk[0]}: unknown model "${name}"`, l.n);
        if (!kinds.includes(m.type)) throw new SpiceError(`${tk[0]}: model "${name}" is a ${m.type}, expected ${kinds.join('/')}`, l.n);
        return m;
      };
      switch (kind) {
        case 'R': c.resistor(nd(1), nd(2), val(3), name); break;
        case 'C': c.capacitor(nd(1), nd(2), val(3), name); break;
        case 'L': c.inductor(nd(1), nd(2), val(3), name); break;
        case 'V': c.vsource(nd(1), nd(2), parseSource(tk.slice(3), l.n), 0, name); break;
        case 'I': c.isource(nd(1), nd(2), parseSource(tk.slice(3), l.n), name); break;
        case 'D': {
          const m = model(tk[3], ['d']).p;
          const dm: DiodeModel = { is: m.is ?? 1e-14, n: m.n ?? 1, rs: m.rs ?? 0 };
          c.diode(nd(1), nd(2), dm, name); break;
        }
        case 'Q': {
          // Q c b e [substrate] model
          const mi = models.has((tk[5] ?? '').toLowerCase()) ? 5 : 4;
          const m = model(tk[mi], ['npn', 'pnp']);
          const bm: BjtModel = { type: m.type as 'npn' | 'pnp', is: m.p.is ?? 1e-16, bf: m.p.bf ?? 100, br: m.p.br ?? 1, nf: m.p.nf ?? 1, nr: m.p.nr ?? 1, vaf: m.p.vaf || m.p.va || Infinity };
          c.add(new Bjt(nd(1), nd(2), nd(3), bm), name); break;
        }
        case 'M': {
          // M d g s b model [W= L=]
          const m = model(tk[5], ['nmos', 'pmos']);
          if ((m.p.level ?? 1) !== 1) throw new SpiceError(`${tk[0]}: only LEVEL=1 MOSFET models are supported`, l.n);
          const inst = parseParams(tk.slice(6), l.n);
          const mm: MosModel = { type: m.type as 'nmos' | 'pmos', vto: m.p.vto ?? 0, kp: m.p.kp ?? 2e-5, lambda: m.p.lambda ?? 0, w: inst.w ?? 1, l: inst.l ?? 1 };
          if (nd(4) !== nd(3)) throw new SpiceError(`${tk[0]}: the bulk must be tied to the source`, l.n);
          c.add(new Mosfet(nd(1), nd(2), nd(3), mm), name); break;
        }
        case 'E': c.add(new Vcvs(nd(1), nd(2), nd(3), nd(4), val(5)), name); break;
        case 'G': c.add(new Vccs(nd(1), nd(2), nd(3), nd(4), val(5)), name); break;
        case 'X': {
          const sub = subckts.get(tk[tk.length - 1].toLowerCase());
          if (!sub) throw new SpiceError(`${tk[0]}: unknown subcircuit "${tk[tk.length - 1]}"`, l.n);
          const args = tk.slice(1, -1);
          if (args.length !== sub.ports.length) throw new SpiceError(`${tk[0]}: ${sub.name} has ${sub.ports.length} pins, got ${args.length}`, l.n);
          const outer = args.map((a) => map(a));
          const inner = (n: string) => {
            const k = n.toLowerCase();
            const i = sub.ports.indexOf(k);
            if (i >= 0) return outer[i];
            return k === '0' || k === 'gnd' ? '0' : `${name}.${k}`;
          };
          expand(sub.body, inner, `${name}.`, depth + 1);
          break;
        }
        default: throw new SpiceError(`unsupported element "${tk[0]}"`, l.n);
      }
    }
  };
  expand(top, (n) => n, '', 0);
  return { circuit: c, nodes, title };
}
