/* CatSim analog engine: modified nodal analysis (MNA).
 *
 * Unknowns are node voltages (node 0 is ground) followed by branch currents of voltage sources and
 * inductors. Nonlinear devices are solved with Newton–Raphson using SPICE-style junction limiting;
 * DC falls back to gmin stepping, then source stepping. Transient analysis uses the trapezoidal rule
 * (backward Euler for the first step after a discontinuity), with step size controlled by an estimate
 * of the local truncation error of capacitors and inductors, and steps land exactly on source corners. */
import { DenseSolver } from './matrix.ts';
import { type Waveform, valueAt, nextBreak, maxStep, constantOn, dc } from './waveform.ts';

export const VT = 0.025852; // thermal voltage at 300 K
const GMIN = 1e-12;

export type Method = 'be' | 'trap';

export interface StampCtx {
  s: DenseSolver;
  /** current Newton guess */
  x: Float64Array;
  /** 'dc' or transient */
  dc: boolean;
  t: number;
  dt: number;
  method: Method;
  /** scale for independent sources (source stepping) */
  srcScale: number;
  /** set by nonlinear devices when they had to limit their step */
  limited: boolean;
}

export const iv = (n: number) => n - 1; // node → unknown index (ground → -1)
export const volt = (x: Float64Array, n: number) => (n === 0 ? 0 : x[n - 1]);

export function stampG(s: DenseSolver, a: number, b: number, g: number) {
  const ia = iv(a), ib = iv(b);
  s.add(ia, ia, g); s.add(ib, ib, g); s.add(ia, ib, -g); s.add(ib, ia, -g);
}
/** Constant current `i` flowing from node a through the element to node b. */
export function stampI(s: DenseSolver, a: number, b: number, i: number) {
  s.addRhs(iv(a), -i); s.addRhs(iv(b), i);
}

export abstract class Element {
  name = '';
  /** branch unknown index (voltage sources, inductors), assigned by Circuit */
  branch = -1;
  abstract readonly nodes: number[];
  needsBranch(): boolean { return false; }
  abstract stamp(c: StampCtx): void;
  /** called once a transient step (or the DC point) is accepted */
  accept(_x: Float64Array, _dt: number, _method: Method, _dc: boolean): void {}
  /** reactive elements: the quantity whose truncation error limits the step */
  isReactive(): boolean { return false; }
  /** nonlinear devices need Newton iterations */
  isNonlinear(): boolean { return false; }
  /** for diodes etc.: reset Newton state */
  resetNewton(): void {}
  current(_x: Float64Array): number { return 0; }
}

export class Resistor extends Element {
  constructor(public a: number, public b: number, public r: number) { super(); }
  get nodes() { return [this.a, this.b]; }
  stamp(c: StampCtx) { stampG(c.s, this.a, this.b, 1 / Math.max(this.r, 1e-9)); }
  current(x: Float64Array) { return (volt(x, this.a) - volt(x, this.b)) / Math.max(this.r, 1e-9); }
}

/** Two-state resistor (push button, relay contact). */
export class Switch extends Element {
  constructor(public a: number, public b: number, public closed = false, public ron = 0.05, public roff = 1e9) { super(); }
  get nodes() { return [this.a, this.b]; }
  stamp(c: StampCtx) { stampG(c.s, this.a, this.b, 1 / (this.closed ? this.ron : this.roff)); }
}

export class Capacitor extends Element {
  vPrev = 0; iPrev = 0;
  /** history of accepted (t, v) for the truncation-error estimate */
  hist: Array<[number, number]> = [];
  constructor(public a: number, public b: number, public c: number) { super(); }
  get nodes() { return [this.a, this.b]; }
  isReactive() { return true; }
  geq(dt: number, m: Method) { return (m === 'trap' ? 2 : 1) * this.c / dt; }
  stamp(c: StampCtx) {
    if (c.dc) return; // open circuit at DC (gmin to ground keeps nodes defined)
    const g = this.geq(c.dt, c.method);
    const ieq = c.method === 'trap' ? g * this.vPrev + this.iPrev : g * this.vPrev;
    stampG(c.s, this.a, this.b, g);
    stampI(c.s, this.a, this.b, -ieq);
  }
  accept(x: Float64Array, dt: number, m: Method, isDc: boolean) {
    const v = volt(x, this.a) - volt(x, this.b);
    if (isDc) { this.iPrev = 0; }
    else { const g = this.geq(dt, m); this.iPrev = m === 'trap' ? g * (v - this.vPrev) - this.iPrev : g * (v - this.vPrev); }
    this.vPrev = v;
  }
  current() { return this.iPrev; }
  state() { return this.vPrev; }
}

export class Inductor extends Element {
  iPrev = 0; vPrev = 0;
  hist: Array<[number, number]> = [];
  constructor(public a: number, public b: number, public l: number) { super(); }
  get nodes() { return [this.a, this.b]; }
  needsBranch() { return true; }
  isReactive() { return true; }
  stamp(c: StampCtx) {
    const s = c.s, ia = iv(this.a), ib = iv(this.b), j = this.branch;
    s.add(ia, j, 1); s.add(ib, j, -1); s.add(j, ia, 1); s.add(j, ib, -1);
    if (c.dc) return; // short circuit at DC: va - vb = 0
    const req = (c.method === 'trap' ? 2 : 1) * this.l / c.dt;
    s.add(j, j, -req);
    s.addRhs(j, c.method === 'trap' ? -req * this.iPrev - this.vPrev : -req * this.iPrev);
  }
  accept(x: Float64Array) {
    this.iPrev = x[this.branch];
    this.vPrev = volt(x, this.a) - volt(x, this.b);
  }
  current(x: Float64Array) { return x[this.branch]; }
  state() { return this.iPrev; }
}

/** Independent voltage source with optional series resistance (models a driver's output impedance). */
export class VSource extends Element {
  constructor(public a: number, public b: number, public wave: Waveform = dc(0), public rs = 0) { super(); }
  get nodes() { return [this.a, this.b]; }
  needsBranch() { return true; }
  value(t: number) { return valueAt(this.wave, t); }
  stamp(c: StampCtx) {
    const s = c.s, ia = iv(this.a), ib = iv(this.b), j = this.branch;
    s.add(ia, j, 1); s.add(ib, j, -1); s.add(j, ia, 1); s.add(j, ib, -1);
    if (this.rs) s.add(j, j, -this.rs);
    s.addRhs(j, this.value(c.t) * c.srcScale);
  }
  /** current flowing out of the + terminal into the circuit */
  current(x: Float64Array) { return -x[this.branch]; }
}

export class ISource extends Element {
  constructor(public a: number, public b: number, public wave: Waveform = dc(0)) { super(); }
  get nodes() { return [this.a, this.b]; }
  stamp(c: StampCtx) { stampI(c.s, this.a, this.b, valueAt(this.wave, c.t) * c.srcScale); }
}

export interface DiodeModel { is: number; n: number; rs?: number; bv?: number }

/** Shockley diode (anode a, cathode k). Series resistance is added by Circuit as a separate resistor. */
export class Diode extends Element {
  private vdLast = 0;
  vcrit = 0;
  constructor(public a: number, public k: number, public m: DiodeModel) {
    super();
    this.setModel(m);
  }
  setModel(m: DiodeModel) {
    this.m = { is: m.is, n: m.n };
    const nvt = m.n * VT;
    this.vcrit = nvt * Math.log(nvt / (Math.SQRT2 * m.is));
  }
  get nodes() { return [this.a, this.k]; }
  resetNewton() { this.vdLast = 0; }
  isNonlinear() { return true; }
  private static pnjlim = pnjlim;
  stamp(c: StampCtx) {
    const nvt = this.m.n * VT;
    let vd = volt(c.x, this.a) - volt(c.x, this.k);
    const [lim, limited] = Diode.pnjlim(vd, this.vdLast, nvt, this.vcrit);
    vd = lim; if (limited) c.limited = true;
    this.vdLast = vd;
    const e = Math.exp(Math.min(vd / nvt, 700));
    const id = this.m.is * (e - 1) + GMIN * vd;
    const gd = (this.m.is * e) / nvt + GMIN;
    stampG(c.s, this.a, this.k, gd);
    stampI(c.s, this.a, this.k, id - gd * vd);
  }
  current(x: Float64Array) {
    const vd = volt(x, this.a) - volt(x, this.k);
    return this.m.is * (Math.exp(Math.min(vd / (this.m.n * VT), 700)) - 1) + GMIN * vd;
  }
}

/** SPICE junction voltage limiting: keeps Newton from overshooting into exp() overflow. */
export function pnjlim(vnew: number, vold: number, nvt: number, vcrit: number): [number, boolean] {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * nvt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / nvt;
      return [arg > 0 ? vold + nvt * Math.log(arg) : vcrit, true];
    }
    return [nvt * Math.log(vnew / nvt), true];
  }
  return [vnew, false];
}

export class ConvergenceError extends Error {}

export interface TranOptions {
  reltol?: number;
  vntol?: number;
  abstol?: number;
  trtol?: number;
  dtMax?: number;
  dtMin?: number;
  maxIterDc?: number;
  maxIterTran?: number;
}

export class Circuit {
  /** number of nodes including ground */
  nodeCount = 1;
  readonly nodeNames: string[] = ['0'];
  readonly elements: Element[] = [];

  node(name?: string): number { this.nodeNames.push(name ?? `n${this.nodeCount}`); return this.nodeCount++; }

  add<E extends Element>(e: E, name = ''): E { e.name = name || `${e.constructor.name[0]}${this.elements.length + 1}`; this.elements.push(e); return e; }
  resistor(a: number, b: number, r: number, name?: string) { return this.add(new Resistor(a, b, r), name); }
  capacitor(a: number, b: number, c: number, name?: string) { return this.add(new Capacitor(a, b, c), name); }
  inductor(a: number, b: number, l: number, name?: string) { return this.add(new Inductor(a, b, l), name); }
  vsource(a: number, b: number, w: Waveform, rs = 0, name?: string) { return this.add(new VSource(a, b, w, rs), name); }
  isource(a: number, b: number, w: Waveform, name?: string) { return this.add(new ISource(a, b, w), name); }
  switch(a: number, b: number, closed = false, name?: string) { return this.add(new Switch(a, b, closed), name); }
  /** Diode with optional series resistance (an internal node is created for it). */
  diode(a: number, k: number, m: DiodeModel, name?: string) {
    let anode = a;
    if (m.rs && m.rs > 0) { anode = this.node(`${name ?? 'd'}#int`); this.resistor(a, anode, m.rs, `${name ?? 'D'}_rs`); }
    return this.add(new Diode(anode, k, { is: m.is, n: m.n }), name);
  }
}

/** Runs DC and transient analysis on a Circuit. The circuit's element list must not change afterwards. */
export class Simulation {
  readonly c: Circuit;
  readonly size: number;
  x: Float64Array;
  t = 0;
  dt = 1e-6;
  private readonly s: DenseSolver;
  private readonly xNew: Float64Array;
  private readonly xSave: Float64Array;
  private readonly o: Required<TranOptions>;
  private readonly reactive: Array<Capacitor | Inductor>;
  private readonly sources: Array<VSource | ISource>;
  private readonly nonlinear: boolean;
  /** next transient step uses backward Euler from a small dt (after a discontinuity) */
  private broke = true;
  /** time of the last source corner we landed on */
  private lastBreak = 0;
  stats = { steps: 0, rejected: 0, newton: 0, cacheHits: 0 };
  /**
   * Resistive circuits only: solutions keyed by the source values. The solution is then a pure function
   * of those values, so a PWM signal flipping between the same two states needs no Newton iterations.
   * Cleared by refresh() whenever any element value changes.
   */
  private cache = new Map<string, Float64Array>();

  constructor(c: Circuit, opts: TranOptions = {}) {
    this.c = c;
    let branches = 0;
    for (const e of c.elements) if (e.needsBranch()) e.branch = c.nodeCount - 1 + branches++;
    this.size = c.nodeCount - 1 + branches;
    this.s = new DenseSolver(this.size);
    this.x = new Float64Array(this.size);
    this.xNew = new Float64Array(this.size);
    this.xSave = new Float64Array(this.size);
    this.o = { reltol: 1e-3, vntol: 1e-6, abstol: 1e-12, trtol: 7, dtMax: 1e-3, dtMin: 1e-14, maxIterDc: 150, maxIterTran: 40, ...opts };
    this.reactive = c.elements.filter((e): e is Capacitor | Inductor => e.isReactive());
    this.sources = c.elements.filter((e): e is VSource | ISource => e instanceof VSource || e instanceof ISource);
    this.nonlinear = c.elements.some((e) => e.isNonlinear());
  }

  get dtMax() { return this.o.dtMax; }
  set dtMax(v: number) { this.o.dtMax = v; }

  nodeV(n: number): number { return volt(this.x, n); }

  // ---------- Newton ----------
  private newton(ctx: Omit<StampCtx, 's' | 'x' | 'limited'>, maxIter: number, gshunt = 0): boolean {
    const { s, x, xNew, size } = this;
    const nNodes = this.c.nodeCount - 1;
    for (let it = 0; it < maxIter; it++) {
      this.stats.newton++;
      s.clear();
      const c: StampCtx = { ...ctx, s, x, limited: false };
      for (const e of this.c.elements) e.stamp(c);
      for (let i = 0; i < nNodes; i++) s.add(i, i, GMIN + gshunt);
      if (!s.solve(xNew)) return false;
      let ok = !c.limited;
      for (let i = 0; i < size; i++) {
        const d = Math.abs(xNew[i] - x[i]);
        const tol = this.o.reltol * Math.max(Math.abs(xNew[i]), Math.abs(x[i])) + (i < nNodes ? this.o.vntol : this.o.abstol * 1e3);
        if (d > tol) ok = false;
        x[i] = xNew[i];
      }
      if (!this.nonlinear) return true; // linear: one solve is exact
      if (ok && it > 0) return true;
    }
    return false;
  }

  /** DC operating point at time t (sources evaluated at t). */
  dcOp(t = this.t): void {
    this.t = t;
    for (const e of this.c.elements) e.resetNewton();
    const base = { dc: true, t, dt: 0, method: 'be' as Method };
    const save = Float64Array.from(this.x);
    let ok = this.newton({ ...base, srcScale: 1 }, this.o.maxIterDc);
    if (!ok) { // gmin stepping
      this.x.set(save);
      ok = true;
      for (let g = 1e-2; g >= 1e-13; g /= 10) {
        if (!this.newton({ ...base, srcScale: 1 }, this.o.maxIterDc, g > 1e-12 ? g : 0)) { ok = false; break; }
      }
    }
    if (!ok) { // source stepping
      this.x.fill(0);
      for (const e of this.c.elements) e.resetNewton();
      ok = true;
      for (let k = 1; k <= 20; k++) {
        if (!this.newton({ ...base, srcScale: k / 20 }, this.o.maxIterDc)) { ok = false; break; }
      }
    }
    if (!ok) throw new ConvergenceError('The DC operating point did not converge');
    for (const e of this.c.elements) e.accept(this.x, 0, 'be', true);
    for (const r of this.reactive) r.hist = [[t, r.state()]];
    this.broke = true;
  }

  /** Call when a source or switch changed at the current time (e.g. digitalWrite). */
  markDiscontinuity(): void { this.broke = true; for (const r of this.reactive) r.hist = [[this.t, r.state()]]; }

  private nextBreakpoint(): number {
    let nb = Infinity;
    for (const s of this.sources) if (s.wave.kind !== 'dc') nb = Math.min(nb, nextBreak(s.wave, this.t));
    return nb;
  }

  private sourcesConstant(t0: number, t1: number): boolean {
    for (const s of this.sources) if (s.wave.kind !== 'dc' && !constantOn(s.wave, t0, t1)) return false;
    return true;
  }

  private stepLimit(): number {
    let m = this.o.dtMax;
    for (const s of this.sources) m = Math.min(m, maxStep(s.wave));
    return m;
  }

  /** Truncation-error estimate → suggested next step (or 0 when the step must be rejected). */
  private lteFactor(tNew: number, dt: number): number {
    let worst = 0;
    for (const r of this.reactive) {
      const h = r.hist;
      if (h.length < 3) continue;
      const v = r instanceof Capacitor ? volt(this.x, r.a) - volt(this.x, r.b) : this.x[r.branch];
      const p = [...h.slice(-3), [tNew, v]] as Array<[number, number]>;
      // third divided difference ≈ x'''/6
      const d1 = (i: number) => (p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]);
      const d2 = (i: number) => (d1(i + 1) - d1(i)) / (p[i + 2][0] - p[i][0]);
      const d3 = (d2(1) - d2(0)) / (p[3][0] - p[0][0]);
      const err = (dt ** 3 / 12) * Math.abs(6 * d3);
      const scale = r instanceof Capacitor ? this.o.vntol * 1e3 : 1e-9;
      const tol = this.o.trtol * (this.o.reltol * Math.max(Math.abs(v), Math.abs(h[h.length - 1][1])) + scale);
      worst = Math.max(worst, err / tol);
    }
    return worst;
  }

  /** set when the last advanceTo() stopped early at a threshold crossing */
  stoppedOnCrossing = false;

  /**
   * Advance the transient solution to time `tEnd`. `onStep` is called after every accepted step.
   * `crossing(xOld, xNew)` may report that a step crossed a threshold (digital input) at fraction
   * 0..1 of the step: the step is then redone to land just past the crossing, and advanceTo returns
   * early with `stoppedOnCrossing` set, so the caller can react (update logic outputs) and continue.
   * Returns the number of accepted steps.
   */
  advanceTo(tEnd: number, onStep?: (t: number, x: Float64Array, dt: number) => void, crossing?: (xOld: Float64Array, xNew: Float64Array) => number | null): number {
    let n = 0;
    this.stoppedOnCrossing = false;
    const eps = 1e-15 + tEnd * 1e-12;
    while (this.t < tEnd - eps) {
      const nb = this.nextBreakpoint();
      const target = Math.min(tEnd, nb);
      // Purely resistive circuit: the solution only depends on the sources at that instant, so while
      // they are constant the solution is static and we can jump straight to the next corner.
      if (!this.reactive.length) {
        if (this.broke) { this.solveAt(this.t); this.broke = false; }
        if (this.sourcesConstant(this.t, target)) {
          const dt = target - this.t;
          this.t = target;
          if (Math.abs(target - nb) <= eps) this.lastBreak = nb;
          onStep?.(this.t, this.x, dt); n++;
          continue;
        }
      }
      // After a discontinuity restart with a small step: inductive spikes happen in the first microseconds.
      let dt = this.broke ? Math.min(this.dt, 1e-6, (target - this.t)) : this.dt;
      dt = Math.min(dt, this.stepLimit(), target - this.t);
      // Nonlinear resistive circuits: resolve the inside of a source ramp (a PWM edge) in 8 steps, since
      // the response is not a straight line. After the first period these come from the solution cache.
      if (!this.reactive.length && this.nonlinear && Number.isFinite(nb)) dt = Math.min(dt, Math.max((nb - this.lastBreak) / 8, this.o.dtMin));
      if (dt < this.o.dtMin) dt = Math.min(this.o.dtMin, target - this.t);
      const method: Method = this.broke ? 'be' : 'trap';
      const save = this.xSave; save.set(this.x);
      const tNew = this.t + dt;
      let ok: boolean;
      const key = this.reactive.length ? '' : this.sourceKey(tNew);
      const hit = key ? this.cache.get(key) : undefined;
      if (hit) { this.x.set(hit); ok = true; this.stats.cacheHits++; }
      else {
        ok = this.newton({ dc: false, t: tNew, dt, method, srcScale: 1 }, this.o.maxIterTran);
        if (ok && key) { if (this.cache.size > 256) this.cache.clear(); this.cache.set(key, Float64Array.from(this.x)); }
      }
      if (!ok) {
        this.x.set(save); this.stats.rejected++;
        this.dt = dt / 8;
        if (this.dt < this.o.dtMin) throw new ConvergenceError(`Transient analysis failed to converge at t = ${this.t.toExponential(3)} s`);
        this.broke = true;
        continue;
      }
      const f = method === 'trap' ? this.lteFactor(tNew, dt) : 0;
      if (f > 1 && dt > this.o.dtMin * 10) {
        this.x.set(save); this.stats.rejected++;
        this.dt = dt * Math.max(0.1, 0.9 * Math.cbrt(1 / f));
        continue;
      }
      let stopHere = false;
      if (crossing) {
        const fr = crossing(save, this.x);
        if (fr !== null) {
          if (fr < 0.98 && dt * fr > 1e-9) { // land just past the crossing instead of overshooting it
            this.x.set(save);
            this.dt = Math.max(dt * Math.max(fr, 0) * 1.002, 1e-10);
            continue;
          }
          stopHere = true;
        }
      }
      // accept
      for (const e of this.c.elements) e.accept(this.x, dt, method, false);
      for (const r of this.reactive) { r.hist.push([tNew, r.state()]); if (r.hist.length > 4) r.hist.shift(); }
      this.t = tNew; this.stats.steps++; n++;
      const grow = f > 0 ? Math.min(2, Math.max(0.3, 0.9 * Math.cbrt(1 / f))) : 2;
      this.dt = Math.min(dt * grow, this.stepLimit());
      const landedOnBreak = Math.abs(this.t - nb) <= eps;
      if (landedOnBreak) this.lastBreak = nb;
      // Restart integration (backward Euler) at source corners; resistive circuits have no state to reset.
      this.broke = landedOnBreak && this.reactive.length > 0;
      if (landedOnBreak) this.dt = Math.max(this.dt, 1e-9);
      onStep?.(this.t, this.x, dt);
      if (stopHere) { this.stoppedOnCrossing = true; break; }
      }
      return n;
  }

  /** Static solve at time t (used for resistive circuits). */
  private solveAt(t: number): void {
    const ok = this.newton({ dc: true, t, dt: 0, method: 'be', srcScale: 1 }, this.o.maxIterDc);
    if (!ok) this.dcOp(t);
    else for (const e of this.c.elements) e.accept(this.x, 0, 'be', true);
  }

  private sourceKey(t: number): string {
    let k = '';
    // Only time-varying sources: DC values cannot change without refresh(), which clears the cache.
    // Rounded to 1 µV: values at PWM corners differ by float rounding from period to period.
    for (const s of this.sources) if (s.wave.kind !== 'dc') k += Math.round(valueAt(s.wave, t) * 1e6) + ',';
    return k;
  }

  /** Re-solve the present instant after a parameter change in a resistive circuit. */
  refresh(): void {
    this.cache.clear();
    if (!this.reactive.length) this.solveAt(this.t);
    this.markDiscontinuity();
  }
}
