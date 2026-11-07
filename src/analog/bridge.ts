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
import { MODELS, R_OUT, R_PULL, R_FLOAT, V_LOGIC, LED_FULL, type PartModel } from './models.ts';
import type { Component, Project, PinDef } from '../types.ts';
import { DEFS } from '../components.js';
import { INPUT_PULLUP, INPUT_PULLDOWN, OUTPUT } from '../pins.js';
import { wireNets } from './nets.ts';

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
}

const VIH = 0.75 * V_LOGIC, VIL = 0.25 * V_LOGIC;
const LED_TAU = 0.02; // brightness averaging time constant (s), roughly what the eye integrates
const MAX_PROBE_POINTS = 50_000;

type Drive = { wave: Waveform; rs: number; key: string };

function topologyKey(p: Project): string {
  return JSON.stringify([p.components.map((c) => [c.id, c.type]), p.wires.map((w) => [w.from, w.to])]);
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
  private leds = new Map<string, { d: Diode; avg: number }>();
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
    this.leds.clear(); this.lastLevel.clear();
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
    const groundRoot = esp ? rootOf.get(`${esp.id}:GND.L`) : null;
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
    this.models = [];
    const prevLeds = this.leds; this.leds = new Map();
    for (const c of p.components) {
      const fn = MODELS[c.type]; if (!fn) continue;
      const m = fn(ckt, c, nodeOf(c), () => this.s.ui[c.id], () => this.comps.get(c.id) ?? c);
      this.models.push({ c, m });
      if (m.led) this.leds.set(c.id, { d: m.led, avg: prevLeds.get(c.id)?.avg ?? 0 });
    }
    const t = this.now();
    this.sim = new Simulation(ckt, { dtMax: this.dtMax });
    try { this.sim.dcOp(t); } catch (e) { this.fail(e); return; }
    this.resolveProbes();
    this.record();
  }

  private drive(g: number): Drive {
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
      const a = 1 - Math.exp(-dt / LED_TAU);
      for (const l of this.leds.values()) l.avg += (Math.max(0, l.d.current(this.sim.x)) - l.avg) * a;
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
      if (t > sim.t) sim.advanceTo(t, this.onStep);
      let changed = false;
      for (const [g, src] of this.gpioSrc) {
        const d = this.drive(g);
        if (d.key !== this.gpioDrive.get(g)) { src.wave = d.wave; src.rs = d.rs; this.gpioDrive.set(g, d.key); changed = true; }
      }
      for (const { m } of this.models) if (m.update?.()) changed = true;
      if (changed) { sim.refresh(); this.record(); }
    } catch (e) {
      if (e instanceof ConvergenceError) { this.fail(e); return; }
      throw e;
    } finally {
      const w = performance.now() - w0;
      this.workMs += w;
      if (w > 0.05) this.s.clock.stall(w);
    }
  }

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
    for (const [id, l] of this.leds) out[id] = Math.min(1, Math.sqrt(Math.max(0, l.avg) / LED_FULL));
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
