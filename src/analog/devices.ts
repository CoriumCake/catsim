/* Semiconductor and controlled-source devices for the analog engine.
 *
 * BJT: SPICE Gummel–Poon with default (zero) leakage/high-injection terms, i.e. the transport model
 * with forward Early effect — this matches ngspice's Q model for the parameters we use.
 * MOSFET: SPICE level 1 (Shichman–Hodges), bulk tied to source.
 * Op-amp: behavioural, single pole-free gain stage with smooth (tanh) limiting to its output swing. */
import { Element, type StampCtx, iv, volt, VT, pnjlim } from './circuit.ts';
import type { DenseSolver } from './matrix.ts';

const GMIN = 1e-12;

/**
 * Stamp a linearised device current I(v) leaving node `row` into the device:
 * I ≈ i0 + Σ g_k (v_k − v_k0).
 */
function stampNL(s: DenseSolver, row: number, i0: number, terms: Array<[number, number]>, x: Float64Array) {
  const r = iv(row);
  if (r < 0) return;
  let rhs = -i0;
  for (const [node, g] of terms) { s.add(r, iv(node), g); rhs += g * volt(x, node); }
  s.addRhs(r, rhs);
}

// ---------- BJT ----------
export interface BjtModel {
  type: 'npn' | 'pnp';
  is: number; bf: number; br: number;
  nf?: number; nr?: number;
  /** forward Early voltage (Infinity = none) */
  vaf?: number;
}

export class Bjt extends Element {
  private vbeLast = 0; private vbcLast = 0;
  readonly pol: number;
  constructor(public c: number, public b: number, public e: number, public m: BjtModel) {
    super();
    this.pol = m.type === 'pnp' ? -1 : 1;
  }
  get nodes() { return [this.c, this.b, this.e]; }
  isNonlinear() { return true; }
  resetNewton() { this.vbeLast = 0; this.vbcLast = 0; }

  /** Collector and base currents (into the device) and their partial derivatives. */
  private eval(vbe: number, vbc: number) {
    const { is, bf, br } = this.m;
    const nf = this.m.nf ?? 1, nr = this.m.nr ?? 1, vaf = this.m.vaf ?? Infinity;
    const ef = Math.exp(Math.min(vbe / (nf * VT), 700)), er = Math.exp(Math.min(vbc / (nr * VT), 700));
    const If = is * (ef - 1), Ir = is * (er - 1);
    const gif = (is * ef) / (nf * VT), gir = (is * er) / (nr * VT);
    const q = Number.isFinite(vaf) ? 1 - vbc / vaf : 1;
    const dq = Number.isFinite(vaf) ? -1 / vaf : 0;
    // gmin across both junctions (as SPICE): base→emitter and base→collector
    const ic = (If - Ir) * q - Ir / br - GMIN * vbc;
    const ib = If / bf + Ir / br + GMIN * vbe + GMIN * vbc;
    return {
      ic, ib,
      dic_dvbe: gif * q,
      dic_dvbc: -gir * q + (If - Ir) * dq - gir / br - GMIN,
      dib_dvbe: gif / bf + GMIN,
      dib_dvbc: gir / br + GMIN,
    };
  }

  stamp(ctx: StampCtx) {
    const { x, s } = ctx, p = this.pol;
    let vbe = p * (volt(x, this.b) - volt(x, this.e));
    let vbc = p * (volt(x, this.b) - volt(x, this.c));
    const nvt = (this.m.nf ?? 1) * VT;
    const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * this.m.is));
    let l1: boolean, l2: boolean;
    [vbe, l1] = pnjlim(vbe, this.vbeLast, nvt, vcrit);
    [vbc, l2] = pnjlim(vbc, this.vbcLast, (this.m.nr ?? 1) * VT, vcrit);
    if (l1 || l2) ctx.limited = true;
    this.vbeLast = vbe; this.vbcLast = vbc;
    const d = this.eval(vbe, vbc);
    // Linearise in the (possibly limited) junction voltages, expressed with actual node voltages.
    // Terminal currents are pol·I; d(pol·I)/dV_node = dI/dvbe·∂vbe/∂V + … and pol² = 1.
    const vbeN = volt(x, this.b) - volt(x, this.e), vbcN = volt(x, this.b) - volt(x, this.c);
    const lin = (i: number, gbe: number, gbc: number) => {
      // value at the limited point, shifted to the node-voltage linearisation point
      const i0 = p * i + (gbe * (vbeN - p * vbe) + gbc * (vbcN - p * vbc));
      return { i0, terms: [[this.b, gbe + gbc], [this.e, -gbe], [this.c, -gbc]] as Array<[number, number]> };
    };
    const C = lin(d.ic, d.dic_dvbe, d.dic_dvbc);
    const B = lin(d.ib, d.dib_dvbe, d.dib_dvbc);
    stampNL(s, this.c, C.i0, C.terms, x);
    stampNL(s, this.b, B.i0, B.terms, x);
    // emitter current = −(ic + ib)
    stampNL(s, this.e, -(C.i0 + B.i0), [
      [this.b, -(C.terms[0][1] + B.terms[0][1])], [this.e, -(C.terms[1][1] + B.terms[1][1])], [this.c, -(C.terms[2][1] + B.terms[2][1])],
    ], x);
  }

  /** Collector current into the device at solution x (positive for an NPN conducting normally). */
  collectorCurrent(x: Float64Array): number {
    const p = this.pol;
    return p * this.eval(p * (volt(x, this.b) - volt(x, this.e)), p * (volt(x, this.b) - volt(x, this.c))).ic;
  }
  baseCurrent(x: Float64Array): number {
    const p = this.pol;
    return p * this.eval(p * (volt(x, this.b) - volt(x, this.e)), p * (volt(x, this.b) - volt(x, this.c))).ib;
  }
}

// ---------- MOSFET (level 1) ----------
export interface MosModel {
  type: 'nmos' | 'pmos';
  vto: number;
  kp: number;
  lambda?: number;
  w?: number;
  l?: number;
}

export class Mosfet extends Element {
  private vgsLast = 0; private vdsLast = 0;
  readonly pol: number;
  constructor(public d: number, public g: number, public s: number, public m: MosModel) {
    super();
    this.pol = m.type === 'pmos' ? -1 : 1;
  }
  get nodes() { return [this.d, this.g, this.s]; }
  isNonlinear() { return true; }
  resetNewton() { this.vgsLast = 0; this.vdsLast = 0; }

  /** Drain current (forward orientation, vds ≥ 0) and its derivatives gm = ∂Id/∂vgs, gds = ∂Id/∂vds. */
  private ids(vgs: number, vds: number) {
    const beta = this.m.kp * ((this.m.w ?? 1) / (this.m.l ?? 1));
    // threshold in the device's normalised orientation (a PMOS VTO is negative in SPICE)
    const lam = this.m.lambda ?? 0, vt = this.pol * this.m.vto;
    const vov = vgs - vt;
    if (vov <= 0) return { id: 0, gm: 0, gds: 0 };
    const cl = 1 + lam * vds;
    if (vds < vov) {
      const core = (vov - vds / 2) * vds;
      return { id: beta * core * cl, gm: beta * vds * cl, gds: beta * (vov - vds) * cl + beta * core * lam };
    }
    const core = 0.5 * vov * vov;
    return { id: beta * core * cl, gm: beta * vov * cl, gds: beta * core * lam };
  }

  stamp(ctx: StampCtx) {
    const { x, s } = ctx, p = this.pol;
    let vgs = p * (volt(x, this.g) - volt(x, this.s));
    let vds = p * (volt(x, this.d) - volt(x, this.s));
    // simple step limiting (SPICE fetlim/limvds in spirit)
    const lim = (v: number, last: number, max: number): [number, boolean] => (Math.abs(v - last) > max ? [last + Math.sign(v - last) * max, true] : [v, false]);
    let a: boolean, b: boolean;
    [vgs, a] = lim(vgs, this.vgsLast, 0.5 + Math.abs(this.vgsLast) * 0.5);
    [vds, b] = lim(vds, this.vdsLast, 2 + Math.abs(this.vdsLast));
    if (a || b) ctx.limited = true;
    this.vgsLast = vgs; this.vdsLast = vds;
    // reverse mode: swap drain and source
    const rev = vds < 0;
    const [dN, sN] = rev ? [this.s, this.d] : [this.d, this.s];
    const vgsF = rev ? vgs - vds : vgs, vdsF = rev ? -vds : vds;
    const { id, gm, gds } = this.ids(vgsF, vdsF);
    // current pol·Id flows from dN to sN through the channel
    const vg = volt(x, this.g), vd = volt(x, dN), vs = volt(x, sN);
    const i0 = p * id + gm * ((vg - vs) - p * vgsF) + gds * ((vd - vs) - p * vdsF);
    const terms: Array<[number, number]> = [[this.g, gm], [dN, gds], [sN, -(gm + gds)]];
    stampNL(s, dN, i0 + GMIN * (vd - vs), [...terms, [dN, GMIN], [sN, -GMIN]], x);
    stampNL(s, sN, -(i0 + GMIN * (vd - vs)), terms.map(([n, g]) => [n, -g] as [number, number]).concat([[dN, -GMIN], [sN, GMIN]]), x);
  }

  /** Drain current (into the drain terminal) at solution x. */
  drainCurrent(x: Float64Array): number {
    const p = this.pol;
    const vgs = p * (volt(x, this.g) - volt(x, this.s)), vds = p * (volt(x, this.d) - volt(x, this.s));
    if (vds >= 0) return p * this.ids(vgs, vds).id;
    return -p * this.ids(vgs - vds, -vds).id;
  }
}

// ---------- controlled sources ----------
/** Voltage-controlled voltage source: V(a,b) = gain · V(cp,cn). */
export class Vcvs extends Element {
  constructor(public a: number, public b: number, public cp: number, public cn: number, public gain: number) { super(); }
  get nodes() { return [this.a, this.b, this.cp, this.cn]; }
  needsBranch() { return true; }
  stamp(ctx: StampCtx) {
    const s = ctx.s, j = this.branch;
    s.add(iv(this.a), j, 1); s.add(iv(this.b), j, -1);
    s.add(j, iv(this.a), 1); s.add(j, iv(this.b), -1);
    s.add(j, iv(this.cp), -this.gain); s.add(j, iv(this.cn), this.gain);
  }
}

/** Voltage-controlled current source: I(a→b) = gm · V(cp,cn). */
export class Vccs extends Element {
  constructor(public a: number, public b: number, public cp: number, public cn: number, public gm: number) { super(); }
  get nodes() { return [this.a, this.b, this.cp, this.cn]; }
  stamp(ctx: StampCtx) {
    const s = ctx.s, g = this.gm;
    s.add(iv(this.a), iv(this.cp), g); s.add(iv(this.a), iv(this.cn), -g);
    s.add(iv(this.b), iv(this.cp), -g); s.add(iv(this.b), iv(this.cn), g);
  }
}

// ---------- op-amp ----------
export interface OpAmpModel {
  /** open-loop DC gain */
  gain: number;
  /** output resistance */
  rout: number;
  /** how close the output gets to the negative / positive supply */
  swingLo: number;
  swingHi: number;
}

/** LM358-like: output reaches ~0 V but only VCC − 1.5 V on top. */
export const LM358: OpAmpModel = { gain: 1e5, rout: 50, swingLo: 0.02, swingHi: 1.5 };

/**
 * Behavioural op-amp: Vout = lo + (hi − lo)·(1 + tanh(u))/2 with u = 2·A·(V+ − V−)/(hi − lo), so the
 * small-signal gain is A and the output saturates smoothly at the supply-dependent swing limits.
 * The differential input is step-limited between Newton iterations (like junction limiting), which keeps
 * negative-feedback circuits from bouncing between the rails while converging.
 */
export class OpAmp extends Element {
  private vdLast = 0;
  constructor(public inp: number, public inn: number, public out: number, public vcc: number, public vee: number, public m: OpAmpModel = LM358) { super(); }
  get nodes() { return [this.inp, this.inn, this.out, this.vcc, this.vee]; }
  needsBranch() { return true; }
  isNonlinear() { return true; }
  resetNewton() { this.vdLast = 0; }

  private f(vd: number, vcc: number, vee: number) {
    const lo = vee + this.m.swingLo, hi = Math.max(lo + 1e-3, vcc - this.m.swingHi);
    const span = hi - lo, u = (2 * this.m.gain * vd) / span;
    const th = Math.tanh(u), sech2 = 1 - th * th;
    return { v: lo + span * (1 + th) / 2, dvd: this.m.gain * sech2, dvcc: (1 + th) / 2, dvee: (1 - th) / 2, u };
  }

  stamp(ctx: StampCtx) {
    const { x, s } = ctx;
    const vcc = volt(x, this.vcc), vee = volt(x, this.vee);
    let vd = volt(x, this.inp) - volt(x, this.inn);
    const uOf = (v: number) => this.f(v, vcc, vee).u;
    const deep = Math.abs(uOf(vd)) > 3 && Math.abs(uOf(this.vdLast)) > 3 && Math.sign(vd) === Math.sign(this.vdLast);
    const step = 0.2;
    if (!deep && Math.abs(vd - this.vdLast) > step) { vd = this.vdLast + Math.sign(vd - this.vdLast) * step; ctx.limited = true; }
    this.vdLast = vd;
    const r = this.f(vd, vcc, vee);
    // branch equation: V(out) + rout·j_out… expressed like a source with series resistance:
    // V(out) − rout·j − [f0 + dvd·(vd − vd0) + dvcc·(vcc − vcc0) + dvee·(vee − vee0)] = 0
    const j = this.branch, o = iv(this.out);
    s.add(o, j, 1); s.add(j, o, 1); s.add(j, j, -this.m.rout);
    s.add(j, iv(this.inp), -r.dvd); s.add(j, iv(this.inn), r.dvd);
    s.add(j, iv(this.vcc), -r.dvcc); s.add(j, iv(this.vee), -r.dvee);
    s.addRhs(j, r.v - r.dvd * vd - r.dvcc * vcc - r.dvee * vee);
  }
}
