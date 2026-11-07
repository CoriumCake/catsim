/* Couples the sketch runtime (src/runtime.js) to the analog engine.
 *
 * - The circuit is rebuilt from the project when the wiring changes; property changes (pot position,
 *   button press, LED colour) only update element values.
 * - Every ESP32 GPIO is a Thevenin source whose voltage and resistance follow the pin mode, so mode
 *   changes never rebuild the circuit. PWM, tone() and servo pulses are real square waves.
 * - The analog solution is advanced to the sketch's simulated time whenever the sketch reads or writes a
 *   pin, and on every UI tick. Analog compute time is taken out of simulated time (the clock "stalls"),
 *   so heavy circuits make the simulation run slower than real time rather than fall behind. */
import { Circuit, Simulation, ConvergenceError, VSource, type Diode } from './circuit.ts';
import { dc, square, type Waveform } from './waveform.ts';
import { MODELS, R_OUT, R_PULL, R_FLOAT, V_LOGIC, LED_FULL, RELAY, modelLog, type PartModel } from './models.ts';
import type { Component, Project, PinDef } from '../types.ts';
import { DEFS } from '../components.js';
import { INPUT_PULLUP, INPUT_PULLDOWN, OUTPUT } from '../pins.js';
import { wireNets } from './nets.ts';
import { CHIPS, type ChipDef, type ChipCtx, type Level, type Out } from '../digital/chips.ts';
import { volt } from './circuit.ts';

/** A logic chip instance during simulation. */
interface ChipRun {
  id: string;
  def: ChipDef;
  st: Record<string, unknown>;
  outs: Map<string, VSource>;
  node: (pin: string) => number;
  levels: Map<string, Level>;
  /** current input thresholds [falling, rising] per input pin, relative to the chip GND */
  thr: Map<string, [number, number]>;
  outKey: Map<string, string>;
}
const GATE_DELAY = 1e-8; // 10 ns: roughly a 74HC propagation delay
const MAX_LOGIC_EVENTS = 4000; // per sync: beyond this a circuit is oscillating absurdly fast

/** What the bridge needs from the Simulator (runtime.js). */
export interface SimState {
  app: { project: Project; log(msg: string, level?: string): void };
  running: boolean;
  ui: Record<string, { pressed?: boolean } | undefined>;
  mode: Record<number, number>;
  out: Record<number, number>;
  pwm: Record<number, number>;
  tone: Record<number, number>;
  servo: Record<number, number>;
  dac: Record<number, number>;
  ledcPin: Record<number, { freq?: number; ch?: number; direct?: boolean } | undefined>;
  ledcCh: Record<number, { freq?: number } | undefined>;
  millis(): number;
  clock: { stall(realMs: number): void };
  /** boards that run real firmware (Uno): pin drivers come from the emulated chip's port registers */
  board?: { drive(pin: number): { wave: Waveform; rs: number; key: string }; name: string };
  }

const VIH = 0.75 * V_LOGIC, VIL = 0.25 * V_LOGIC;
/** An LED burns out when its thermally averaged current exceeds this (typical abs. max 30 mA). */
export const LED_BURN_A = 0.03;
const LED_THERMAL_TAU = 0.3;
/** ESP32 absolute maximum source/sink current per GPIO. */
export const GPIO_MAX_A = 0.04;
const OPEN_JUNCTION = { is: 1e-30, n: 2 };
/** Voltage across a coil/motor above which we explain the inductive kick (and the missing flyback diode). */
const KICK_V = 30;
const LED_TAU = 0.02; // brightness averaging time constant (s), roughly what the eye integrates
const MAX_PROBE_POINTS = 50_000;

type Drive = { wave: Waveform; rs: number; key: string };

function topologyKey(p: Project): string {
  // pasted SPICE models change a part's internal structure, so they count as topology
  return JSON.stringify([p.components.map((c) => [c.id, c.type, typeof c.props.spice === 'string' ? c.props.spice : '']), p.wires.map((w) => [w.from, w.to])]);
}

export class AnalogBridge {
  sim: Simulation | null = null;
  error: string | null = null;
  private topo = '';
  private gpioSrc = new Map<number, VSource>();
  private gpioDrive = new Map<number, string>();
  private models: Array<{ c: Component; m: PartModel }> = [];
  private project: Project | null = null;
  private comps = new Map<string, Component>();
  private pinNode = new Map<string, number>();
  private leds = new Map<string, { d: Diode; avg: number; heat: number }>();
  /** LEDs destroyed by overcurrent in this run (they stay open-circuit) */
  readonly burnt = new Set<string>();
  private pendingBurn: string[] = [];
  private warnedPins = new Set<number>();
  private chips: ChipRun[] = [];
  private motors = new Map<string, { node: number; angle: number; kickNodes: [number, number] }>();
  private relays = new Map<string, NonNullable<PartModel['relay']>>();
  private kick = new Map<string, number>();
  private warnedKick = new Set<string>();
  /** true until the first circuit of a run is built: that one starts at t = 0, not at the first sync */
  private fresh = true;
  private logicEvents = 0;
  private warnedOscillation = false;
  private lastLevel = new Map<number, number>();
  private probes: Array<string | null> = [];
  private probeNodes: number[] = [];
  /** solver step limit (set from the scope timebase) */
  private dtMax = 1e-3;
  private rec = { t: [] as number[], v: [] as number[][] };
  /** real-time factor bookkeeping */
  private rtf = { simT: 0, realT: 0, value: 1 };
  workMs = 0;

  constructor(private readonly s: SimState) {}

  /** Forget everything (new run). The circuit is rebuilt on the next sync(). */
  reset(): void {
    this.sim = null; this.error = null; this.topo = '';
    this.leds.clear(); this.lastLevel.clear(); this.burnt.clear(); this.pendingBurn = []; this.warnedPins.clear();
    this.chips = []; this.warnedOscillation = false; this.fresh = true;
    this.motors.clear(); this.relays.clear(); this.kick.clear(); this.warnedKick.clear();
    this.rec = { t: [], v: this.probes.map(() => []) };
    this.rtf = { simT: 0, realT: 0, value: 1 }; this.workMs = 0;
  }

  // ---------- netlist ----------
  rebuild(): void {
    const p = this.s.app.project;
    this.topo = topologyKey(p);
    this.project = p; this.comps = new Map(p.components.map((c) => [c.id, c]));
    this.error = null;
    const ckt = new Circuit();
    // Nets from wires only (part-internal connections are modelled by the parts themselves).
    const { rootOf, members } = wireNets(p, DEFS);
    const esp = p.components.find((c) => c.type === 'esp32');
    const boardComp = p.components.find((c) => DEFS[c.type]?.board);
    const gndPin = boardComp && (DEFS[boardComp.type].pins as PinDef[]).find((pd) => pd.kind === 'gnd');
    const groundRoot = boardComp && gndPin ? rootOf.get(`${boardComp.id}:${gndPin.id}`) : null;
    const rootNode = new Map<string, number>();
    this.pinNode.clear();
    for (const [key, r] of rootOf) {
      let n = rootNode.get(r);
      if (n === undefined) { n = r === groundRoot ? 0 : ckt.node(r); rootNode.set(r, n); }
      this.pinNode.set(key, n);
    }
    // Board pins with nothing wired to them need no circuit elements (reads fall back to logic level).
    const wired = (key: string) => (members.get(rootOf.get(key) ?? '')?.length ?? 0) > 1;
    const nodeOf = (c: Component) => (pinId: string) => this.pinNode.get(`${c.id}:${pinId}`) ?? 0;

    // ESP32: supply rails and one Thevenin source per GPIO
    this.gpioSrc.clear(); this.gpioDrive.clear();
    if (esp) {
      const pin = nodeOf(esp);
      if (wired(`${esp.id}:3V3`)) ckt.vsource(pin('3V3'), 0, dc(V_LOGIC), 0.1, '3V3');
      if (wired(`${esp.id}:VIN`)) ckt.vsource(pin('VIN'), 0, dc(5), 0.1, 'VIN');
      for (const pd of DEFS.esp32.pins as PinDef[]) {
        if (pd.kind !== 'gpio' || pd.gpio == null || !wired(`${esp.id}:${pd.id}`)) continue;
        const d = this.drive(pd.gpio);
        this.gpioSrc.set(pd.gpio, ckt.vsource(pin(pd.id), 0, d.wave, d.rs, `GPIO${pd.gpio}`));
        this.gpioDrive.set(pd.gpio, d.key);
      }
    }
    const uno = p.components.find((c) => c.type === 'uno');
    if (uno) {
      const pin = nodeOf(uno);
      if (wired(`${uno.id}:5V`)) ckt.vsource(pin('5V'), 0, dc(5), 0.1, '5V');
      if (wired(`${uno.id}:3V3`)) ckt.vsource(pin('3V3'), 0, dc(3.3), 0.5, '3V3');
      for (const pd of DEFS.uno.pins as PinDef[]) {
        if (pd.kind !== 'gpio' || pd.gpio == null || !wired(`${uno.id}:${pd.id}`)) continue;
        const d = this.drive(pd.gpio);
        this.gpioSrc.set(pd.gpio, ckt.vsource(pin(pd.id), 0, d.wave, d.rs, `${pd.id}`));
        this.gpioDrive.set(pd.gpio, d.key);
      }
    }
    this.models = [];
    const prevMotors = this.motors, prevRelays = this.relays;
    this.motors = new Map(); this.relays = new Map();
    const prevChips = new Map(this.chips.map((ch) => [ch.id, ch]));
    this.chips = [];
    const prevLeds = this.leds; this.leds = new Map();
    const reported = new Set<string>();
    modelLog.fn = (msg) => { if (!reported.has(msg)) { reported.add(msg); this.s.app.log(msg, 'error'); } };
    for (const c of p.components) {
      const fn = MODELS[c.type]; if (!fn) continue;
      const m = fn(ckt, c, nodeOf(c), () => this.s.ui[c.id], () => this.comps.get(c.id) ?? c);
      this.models.push({ c, m });
      if (m.motor) this.motors.set(c.id, { node: m.motor.speedNode, angle: prevMotors.get(c.id)?.angle ?? 0, kickNodes: [nodeOf(c)('+'), nodeOf(c)('-')] });
      if (m.relay) {
        const was = prevRelays.get(c.id)?.closed ?? false;
        m.relay.closed = was; m.relay.contacts.forEach((s) => { s.closed = was; }); m.relay.nc.forEach((s) => { s.closed = !was; });
        this.relays.set(c.id, m.relay);
      }
      if (m.chip) {
        const old = prevChips.get(c.id); // keep flip-flop / counter state across rewiring
        this.chips.push({ id: c.id, def: CHIPS[c.type], st: old?.st ?? CHIPS[c.type].init(), outs: m.chip.outs, node: m.chip.node,
          levels: new Map(old?.levels ?? []), thr: new Map(), outKey: new Map() });
      }
      if (m.led) {
        this.leds.set(c.id, { d: m.led, avg: prevLeds.get(c.id)?.avg ?? 0, heat: prevLeds.get(c.id)?.heat ?? 0 });
        if (this.burnt.has(c.id)) m.led.setModel(OPEN_JUNCTION);
      }
    }
    const t = this.fresh ? 0 : this.now(); // a new run starts at 0 even if the first sync comes later
    this.fresh = false;
    this.sim = new Simulation(ckt, { dtMax: this.dtMax });
    try { this.sim.dcOp(t); } catch (e) { this.fail(e); return; }
    if (this.chips.length) { this.logicEvents = 0; this.evaluateLogic(); }
    this.resolveProbes();
    this.record();
  }

  private drive(g: number): Drive {
    if (this.s.board) return this.s.board.drive(g);
    const s = this.s, mode = s.mode[g];
    if (mode === OUTPUT) {
      if (s.dac[g] != null) { const v = s.dac[g] * V_LOGIC; return { wave: dc(v), rs: 1000, key: `dac${v}` }; }
      if (s.tone[g]) { const f = s.tone[g]; return { wave: square(V_LOGIC, f, 0.5), rs: R_OUT, key: `tone${f}` }; }
      if (s.servo[g] != null) {
        const us = 544 + (s.servo[g] / 180) * (2400 - 544);
        return { wave: square(V_LOGIC, 50, us * 50e-6), rs: R_OUT, key: `servo${us}` };
      }
      if (s.pwm[g] != null) {
        const lp = s.ledcPin[g];
        const freq = lp?.freq || (lp?.ch != null ? s.ledcCh[lp.ch]?.freq : undefined) || 1000;
        return { wave: square(V_LOGIC, freq, s.pwm[g]), rs: R_OUT, key: `pwm${freq}:${s.pwm[g]}` };
      }
      const v = s.out[g] ? V_LOGIC : 0;
      return { wave: dc(v), rs: R_OUT, key: `out${v}` };
    }
    const canPull = g < 34;
    if (mode === INPUT_PULLUP && canPull) return { wave: dc(V_LOGIC), rs: R_PULL, key: 'pu' };
    if (mode === INPUT_PULLDOWN && canPull) return { wave: dc(0), rs: R_PULL, key: 'pd' };
    return { wave: dc(0), rs: R_FLOAT, key: 'hiz' };
  }

  // ---------- time ----------
  now(): number { return this.s.millis() / 1000; }

  private fail(e: unknown): void {
    this.error = e instanceof Error ? e.message : String(e);
    this.sim = null;
    this.s.app.log(`Analog simulation stopped: ${this.error}. Check for short circuits or parts wired in impossible ways.`, 'error');
  }

  private onStep = (_t: number, _x: Float64Array, dt: number) => {
    if (this.leds.size && this.sim) {
      const a = 1 - Math.exp(-dt / LED_TAU), h = 1 - Math.exp(-dt / LED_THERMAL_TAU);
      for (const [id, l] of this.leds) {
        const i = Math.max(0, l.d.current(this.sim.x));
        l.avg += (i - l.avg) * a;
        l.heat += (i - l.heat) * h;
        if (l.heat > LED_BURN_A && !this.burnt.has(id) && !this.pendingBurn.includes(id)) this.pendingBurn.push(id);
      }
    }
    if (this.motors.size || this.relays.size) {
      const x = this.sim!.x, v = (n: number) => (n === 0 ? 0 : x[n - 1]);
      for (const [id, mo] of this.motors) {
        mo.angle = (mo.angle + v(mo.node) * dt) % (2 * Math.PI);
        const vv = Math.abs(v(mo.kickNodes[0]) - v(mo.kickNodes[1]));
        if (vv > (this.kick.get(id) ?? 0)) this.kick.set(id, vv);
      }
      for (const [id, r] of this.relays) {
        const vv = Math.abs(r.coilVolts(x));
        if (vv > (this.kick.get(id) ?? 0)) this.kick.set(id, vv);
      }
    }
    this.record();
    };

  /** Bring the analog solution up to the current simulated time and apply any pin/part changes. */
  sync(): void {
    if (!this.sim) {
      if (this.error) return;
      this.rebuild();
      if (!this.sim) return;
    }
    const proj = this.s.app.project;
    if (proj !== this.project) {
      if (topologyKey(proj) !== this.topo) { this.rebuild(); return; }
      this.project = proj; this.comps = new Map(proj.components.map((c) => [c.id, c])); // same wiring, new property values
    }
    const w0 = performance.now();
    const sim = this.sim;
    try {
      const t = this.now();
      this.logicEvents = 0;
      // Advance; whenever a chip input crosses its threshold the solver stops there so the logic can react.
      while (t > sim.t + 1e-12) {
        const useCross = (this.chips.length > 0 || this.relays.size > 0) && this.logicEvents < MAX_LOGIC_EVENTS;
        sim.advanceTo(t, this.onStep, useCross ? this.crossing : undefined);
        if (!sim.stoppedOnCrossing) break;
        if (this.updateRelays()) { sim.refresh(); this.record(); }
        this.evaluateLogic();
      }
      if (this.logicEvents >= MAX_LOGIC_EVENTS && !this.warnedOscillation) {
        this.warnedOscillation = true;
        this.s.app.log('A logic circuit is oscillating faster than the simulator can follow (thousands of edges per frame). Check for an output wired back to its own input without a delay.', 'warn');
      }
      let changed = false;
      for (const [g, src] of this.gpioSrc) {
        const d = this.drive(g);
        if (d.key !== this.gpioDrive.get(g)) { src.wave = d.wave; src.rs = d.rs; this.gpioDrive.set(g, d.key); changed = true; }
      }
      for (const { m } of this.models) if (m.update?.()) changed = true;
      // overcurrent damage (applied between solver runs, not inside a step)
      for (const id of this.pendingBurn) {
        const l = this.leds.get(id); if (!l) continue;
        const mA = Math.round(Math.max(l.heat, l.d.current(sim.x)) * 1000);
        this.burnt.add(id); changed = true;
        this.s.app.log(`${id} burned out: about ${mA} mA flowed through it (LEDs take 20–30 mA at most). Add a series resistor, e.g. 220 Ω. Restart to replace it.`, 'error');
      }
      this.pendingBurn = [];
      for (const id of this.burnt) this.leds.get(id)?.d.setModel(OPEN_JUNCTION);
      if (this.updateRelays()) changed = true;
      for (const [id, vmax] of this.kick) {
        if (vmax > KICK_V && !this.warnedKick.has(id)) {
          this.warnedKick.add(id);
          this.s.app.log(`Switching ${id} off made a ${vmax >= 1000 ? `${(vmax / 1000).toFixed(1)} kV` : `${Math.round(vmax)} V`} spike: the coil's inductance kicks back when its current is cut. A real transistor would break down. Put a flyback diode (1N4007) across ${id}, cathode to the + side.`, 'warn');
        }
      }
      for (const [g, src] of this.gpioSrc) {
        const i = Math.abs(src.current(sim.x));
        if (i > GPIO_MAX_A && !this.warnedPins.has(g)) {
          this.warnedPins.add(g);
          const where = this.s.board ? `Pin ${g < 14 ? `D${g}` : `A${g - 14}`}` : `GPIO${g}`;
          this.s.app.log(`${where} is carrying ${Math.round(i * 1000)} mA, above the ${this.s.board ? this.s.board.name : 'ESP32'}'s 40 mA limit per pin (keep it under 20 mA). Use a resistor or a transistor to drive the load.`, 'warn');
        }
      }
      if (changed) { sim.refresh(); this.record(); if (this.chips.length) this.evaluateLogic(); }
    } catch (e) {
      if (e instanceof ConvergenceError) { this.fail(e); return; }
      throw e;
    } finally {
      const w = performance.now() - w0;
      this.workMs += w;
      if (w > 0.05) this.s.clock.stall(w);
    }
  }

  // ---------- logic chips ----------
  private chipCtx(ch: ChipRun, x: Float64Array): ChipCtx {
    const g = volt(x, ch.node(ch.def.gnd));
    return { level: (p) => ch.levels.get(p) ?? 0, v: (p) => volt(x, ch.node(p)) - g, vcc: volt(x, ch.node(ch.def.vcc)) - g };
  }

  private thresholdsOf(ch: ChipRun, pin: string, ctx: ChipCtx): [number, number] {
    return ch.def.thresholds?.(pin, ctx) ?? [0.3 * ctx.vcc, 0.7 * ctx.vcc];
  }

  /** Re-read chip inputs, run their logic, and update output drivers until everything settles. */
  private evaluateLogic(): void {
    const sim = this.sim; if (!sim) return;
    for (let round = 0; round < 50; round++) {
      let changed = false;
      for (const ch of this.chips) {
        const ctx = this.chipCtx(ch, sim.x);
        const powered = ctx.vcc > 1.5;
        for (const p of ch.def.inputs) {
          const [lo, hi] = this.thresholdsOf(ch, p, ctx);
          ch.thr.set(p, [lo, hi]);
          const v = ctx.v(p), cur = ch.levels.get(p);
          const lvl: Level = cur === undefined ? (v > (lo + hi) / 2 ? 1 : 0) : cur === 0 ? (v > hi ? 1 : 0) : (v < lo ? 0 : 1);
          ch.levels.set(p, lvl);
        }
        const outs: Record<string, Out> = powered ? ch.def.evaluate(ctx, ch.st) : {};
        const rout = ch.def.rout ?? 30;
        for (const [pin, src] of ch.outs) {
          const o: Out = powered ? (outs[pin] ?? 'z') : 'z';
          const od = ch.def.openDrain?.includes(pin);
          const drive = o === 'z' || (od && o === 1) ? null : o;
          const key = drive === null ? 'z' : `${drive}:${ctx.vcc.toFixed(3)}`;
          if (ch.outKey.get(pin) === key) continue;
          ch.outKey.set(pin, key);
          src.wave = dc(drive ? ctx.vcc : 0); src.rs = drive === null ? 1e9 : rout;
          changed = true;
        }
      }
      if (!changed) return;
      this.logicEvents++;
      sim.markDiscontinuity();
      sim.refresh();
      sim.advanceTo(sim.t + GATE_DELAY, this.onStep); // let the new outputs propagate
    }
  }

  /** Relay armatures: pull in / drop out with hysteresis on the coil current. Returns true if any moved. */
  private updateRelays(): boolean {
    const sim = this.sim; if (!sim) return false;
    let moved = false;
    for (const r of this.relays.values()) {
      const i = Math.abs(r.coilCurrent(sim.x));
      const want = r.closed ? i > RELAY.dropOut * 0.999 : i > RELAY.pullIn * 0.999;
      if (want === r.closed) continue;
      r.closed = want; moved = true;
      r.contacts.forEach((s) => { s.closed = want; }); r.nc.forEach((s) => { s.closed = !want; });
    }
    return moved;
  }

  /** Fraction of a step at which the first chip input (or relay coil current) crosses its threshold. */
  private crossing = (xOld: Float64Array, xNew: Float64Array): number | null => {
    let first: number | null = null;
    for (const r of this.relays.values()) {
      const i0 = Math.abs(r.coilCurrent(xOld)), i1 = Math.abs(r.coilCurrent(xNew));
      const thr = r.closed ? RELAY.dropOut : RELAY.pullIn;
      const crosses = r.closed ? i0 >= thr && i1 < thr : i0 <= thr && i1 > thr;
      if (!crosses) continue;
      const f = i1 === i0 ? 1 : (thr - i0) / (i1 - i0);
      if (first === null || f < first) first = f;
    }
    for (const ch of this.chips) {
      const g0 = volt(xOld, ch.node(ch.def.gnd)), g1 = volt(xNew, ch.node(ch.def.gnd));
      for (const p of ch.def.inputs) {
        const thr = ch.thr.get(p); if (!thr) continue;
        const n = ch.node(p);
        const v0 = volt(xOld, n) - g0, v1 = volt(xNew, n) - g1;
        const lvl = ch.levels.get(p) ?? 0;
        const t = lvl === 0 ? thr[1] : thr[0];
        const crosses = lvl === 0 ? (v0 <= t && v1 > t) : (v0 >= t && v1 < t);
        if (!crosses) continue;
        const f = v1 === v0 ? 1 : (t - v0) / (v1 - v0);
        if (first === null || f < first) first = f;
      }
    }
    return first;
  };

  // ---------- readings ----------
  nodeVoltage(pinKey: string): number | null {
    const n = this.pinNode.get(pinKey);
    return n === undefined || !this.sim ? null : this.sim.nodeV(n);
  }

  gpioVoltage(g: number): number | null {
    const src = this.gpioSrc.get(g);
    return src && this.sim ? this.sim.nodeV(src.a) : null;
  }

  /** Digital input with Schmitt-trigger thresholds (VIL/VIH), remembering the last level in between. */
  readDigital(g: number): number | null {
    const v = this.gpioVoltage(g);
    if (v == null) return null;
    const last = this.lastLevel.get(g) ?? (v > V_LOGIC / 2 ? 1 : 0);
    const lvl = v >= VIH ? 1 : v <= VIL ? 0 : last;
    this.lastLevel.set(g, lvl);
    return lvl;
  }

  ledBrightness(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, l] of this.leds) out[id] = this.burnt.has(id) ? 0 : Math.min(1, Math.sqrt(Math.max(0, l.avg) / LED_FULL));
    return out;
  }

  /** Motors: [rpm, shaft angle]; relays: armature closed. */
  mechanics(): { motors: Record<string, [number, number]>; relays: Record<string, number> } {
    const motors: Record<string, [number, number]> = {}, relays: Record<string, number> = {};
    if (this.sim) for (const [id, m] of this.motors) motors[id] = [this.sim.nodeV(m.node) * 60 / (2 * Math.PI), m.angle];
    for (const [id, r] of this.relays) relays[id] = r.closed ? 1 : 0;
    return { motors, relays };
  }

  /** Per-part activity (transistors conducting), 0..1. */
  partActivity(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.sim) return out;
    for (const { c, m } of this.models) if (m.activity) out[c.id] = m.activity(this.sim.x);
    return out;
  }

  /** Real-time factor: simulated seconds per real second over the last ~0.5 s (1 = keeping up). */
  realTimeFactor(): number {
    const now = performance.now(), t = this.now();
    if (!this.rtf.realT) { this.rtf = { simT: t, realT: now, value: 1 }; return 1; }
    const dr = now - this.rtf.realT;
    if (dr > 500) { this.rtf.value = ((t - this.rtf.simT) * 1000) / dr; this.rtf.simT = t; this.rtf.realT = now; }
    return this.rtf.value;
  }

  // ---------- oscilloscope probes ----------
  setProbes(refs: Array<string | null>, dtMax = 1e-3): void {
    this.probes = refs.slice(0, 4);
    this.dtMax = Math.min(1e-3, Math.max(1e-7, dtMax || 1e-3));
    if (this.sim) this.sim.dtMax = this.dtMax;
    this.resolveProbes();
    this.rec = { t: [], v: this.probes.map(() => []) };
    this.record();
  }

  private resolveProbes(): void { this.probeNodes = this.probes.map((r) => (r ? this.pinNode.get(r) ?? -1 : -1)); }

  private record(): void {
    if (!this.sim || !this.probes.some(Boolean)) return;
    if (this.rec.t.length >= MAX_PROBE_POINTS) return;
    if (this.rec.v.length !== this.probes.length) this.rec.v = this.probes.map(() => []);
    this.rec.t.push(this.sim.t);
    this.probeNodes.forEach((n, i) => this.rec.v[i].push(n < 0 ? NaN : this.sim!.nodeV(n)));
  }

  /** Recorded probe samples since the last call (transferable typed arrays). */
  takeSamples(): { t: Float64Array; v: Float32Array[] } | null {
    if (!this.rec.t.length) return null;
    const out = { t: Float64Array.from(this.rec.t), v: this.rec.v.map((a) => Float32Array.from(a)) };
    this.rec = { t: [], v: this.probes.map(() => []) };
    return out;
  }
}
