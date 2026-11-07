/* Independent source waveforms (SPICE semantics for DC, PULSE and SIN). */

export type Waveform =
  | { kind: 'dc'; v: number }
  /** PULSE(v1 v2 td tr tf pw per) */
  | { kind: 'pulse'; v1: number; v2: number; td: number; tr: number; tf: number; pw: number; per: number }
  /** SIN(vo va freq td) */
  | { kind: 'sin'; vo: number; va: number; freq: number; td: number };

export const dc = (v: number): Waveform => ({ kind: 'dc', v });

/** Square wave for a digital output: `duty` of `period` at `hi`, otherwise 0, with short edges. */
export function square(hi: number, freq: number, duty: number, lo = 0): Waveform {
  if (!(freq > 0) || duty <= 0) return dc(lo);
  if (duty >= 1) return dc(hi);
  const per = 1 / freq;
  const edge = Math.min(1e-6, per / 200);
  return { kind: 'pulse', v1: lo, v2: hi, td: 0, tr: edge, tf: edge, pw: Math.max(0, duty * per - edge), per };
}

export function valueAt(w: Waveform, t: number): number {
  switch (w.kind) {
    case 'dc': return w.v;
    case 'sin': return t < w.td ? w.vo : w.vo + w.va * Math.sin(2 * Math.PI * w.freq * (t - w.td));
    case 'pulse': {
      if (t < w.td) return w.v1;
      const tt = w.per > 0 ? (t - w.td) % w.per : t - w.td;
      if (tt < w.tr) return w.v1 + (w.v2 - w.v1) * (tt / w.tr);
      if (tt < w.tr + w.pw) return w.v2;
      if (tt < w.tr + w.pw + w.tf) return w.v2 + (w.v1 - w.v2) * ((tt - w.tr - w.pw) / w.tf);
      return w.v1;
    }
  }
}

/** The first corner of the waveform strictly after `t` (Infinity if none). */
export function nextBreak(w: Waveform, t: number): number {
  if (w.kind !== 'pulse') return w.kind === 'sin' && t < w.td ? w.td : Infinity;
  const eps = 1e-15 + Math.abs(t) * 1e-12;
  if (t + eps < w.td) return w.td;
  // corners within one period, relative to its start: 0, tr, tr+pw, tr+pw+tf (no allocation: hot path)
  const c1 = w.tr, c2 = w.tr + w.pw, c3 = c2 + w.tf;
  if (!(w.per > 0)) {
    if (w.td + c1 > t + eps) return w.td + c1;
    if (w.td + c2 > t + eps) return w.td + c2;
    if (w.td + c3 > t + eps) return w.td + c3;
    return Infinity;
  }
  const k = Math.floor((t - w.td) / w.per);
  for (let m = k; m <= k + 1; m++) {
    const base = w.td + m * w.per;
    if (base > t + eps) return base;
    if (base + c1 > t + eps) return base + c1;
    if (base + c2 > t + eps) return base + c2;
    if (base + c3 > t + eps) return base + c3;
  }
  return Infinity;
}

/** Largest step that still resolves the waveform's shape (Infinity if it is piecewise linear). */
export function maxStep(w: Waveform): number {
  return w.kind === 'sin' && w.freq > 0 ? 1 / (w.freq * 40) : Infinity;
}

/** True if the source value is constant on [t0, t1]. */
export function constantOn(w: Waveform, t0: number, t1: number): boolean {
  if (w.kind === 'dc') return true;
  if (w.kind === 'sin') return t1 <= w.td || w.va === 0;
  // A pulse is constant between consecutive corners only on its flat parts.
  const nb = nextBreak(w, t0);
  if (nb < t1) return false;
  const mid = (t0 + Math.min(t1, nb)) / 2;
  const v = valueAt(w, mid);
  return v === w.v1 || v === w.v2;
}

export function toSpice(w: Waveform): string {
  const f = (x: number) => (Number.isFinite(x) ? x.toPrecision(12) : '0');
  switch (w.kind) {
    case 'dc': return `DC ${f(w.v)}`;
    case 'sin': return `SIN(${f(w.vo)} ${f(w.va)} ${f(w.freq)} ${f(w.td)})`;
    case 'pulse': return `PULSE(${f(w.v1)} ${f(w.v2)} ${f(w.td)} ${f(w.tr)} ${f(w.tf)} ${f(w.pw)} ${f(w.per)})`;
  }
}
