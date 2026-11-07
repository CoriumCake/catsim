/* Electrical models for the parts library. Each model adds elements to the circuit for one part and
 * returns an `update` function that re-reads the part's properties / UI state (pot position, button
 * press…) and reports whether anything changed. */
import { Circuit, Diode, Resistor, Switch, VSource, VT, type DiodeModel } from './circuit.ts';
import { dc } from './waveform.ts';
import { Bjt, Mosfet, OpAmp, LM358, Vcvs, Vccs, type BjtModel, type MosModel } from './devices.ts';
import { CHIPS, type ChipDef } from '../digital/chips.ts';
import { parseLibrary, instantiateSubckt, type SpiceLibrary } from './parser.ts';

/** The bridge sets this during a rebuild so models can report problems with pasted SPICE models. */
export const modelLog = { fn: (_msg: string) => {} };
const libCache = new Map<string, SpiceLibrary | Error>();
/** Parse pasted SPICE text (cached). Returns null when the text is empty, an Error when it is invalid. */
export function spiceLib(text: unknown): SpiceLibrary | Error | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let lib = libCache.get(text);
  if (!lib) {
    try { lib = parseLibrary(text); } catch (e) { lib = e as Error; }
    if (libCache.size > 50) libCache.clear();
    libCache.set(text, lib);
  }
  return lib;
}
/** The first .model of one of these types in pasted SPICE text, or null (logging why). */
function customModel(id: string, text: unknown, types: string[]): { type: string; p: Record<string, number> } | null {
  const lib = spiceLib(text);
  if (!lib) return null;
  if (lib instanceof Error) { modelLog.fn(`${id}: custom SPICE model not used (${lib.message}). Using the built-in model.`); return null; }
  for (const m of lib.models.values()) if (types.includes(m.type)) return m;
  return null;
}
/** The first .subckt with this many pins in pasted SPICE text, or null. */
function customSubckt(text: unknown, pins: number): { lib: SpiceLibrary; name: string } | null {
  const lib = spiceLib(text);
  if (!lib || lib instanceof Error) return null;
  for (const s of lib.subckts.values()) if (s.ports.length === pins) return { lib, name: s.name };
  return null;
}
const noModel = (id: string, what: string) => modelLog.fn(`${id}: the custom SPICE text has no ${what}. Using the built-in model.`);
import type { Component } from '../types.ts';

export const V_LOGIC = 3.3;
/** ESP32 GPIO output impedance at the default drive strength (≈ 40 mA into a short). */
export const R_OUT = 30;
export const R_PULL = 45_000;
export const R_FLOAT = 1e8;

/** LED model: forward voltage `vf` at 10 mA. */
export function ledModel(vf: number): DiodeModel {
  const n = 2, rs = 5;
  const vd = vf - 0.01 * rs;
  return { is: 0.01 / (Math.exp(vd / (n * VT)) - 1), n, rs };
}
export const LED_VF: Record<string, number> = { red: 1.95, orange: 2.0, yellow: 2.05, green: 2.2, blue: 3.0, white: 3.0 };
/** Current at which an LED is drawn at full brightness. */
export const LED_FULL = 0.01;

export interface ChipPins {
  /** driver source per output pin (referenced to the chip's GND pin) */
  outs: Map<string, VSource>;
  node: (pin: string) => number;
}

/** Electromechanical parts report their mechanical state to the bridge. */
export interface MotorState { speedNode: number; voltsAcross: () => number }
export interface RelayState { coilCurrent: (x: Float64Array) => number; contacts: Switch[]; nc: Switch[]; closed: boolean; coilVolts: (x: Float64Array) => number }

export interface PartModel {
  motor?: MotorState;
  relay?: RelayState;
  /** logic chips: their driver sources and pin nodes (evaluated by the bridge) */
  chip?: ChipPins;
  update?: () => boolean;
  /** LEDs: the junction whose current sets the brightness */
  led?: Diode;
  /** 0..1 activity shown on the part (transistor conducting) */
  activity?: (x: Float64Array) => number;
}

// Device parameters from the parts' published SPICE models (simplified to what the engine supports).
export const Q2N2222: BjtModel = { type: 'npn', is: 14.34e-15, bf: 255.9, br: 6.092, vaf: 74.03 };
export const Q2N2907: BjtModel = { type: 'pnp', is: 650.6e-18, bf: 231.7, br: 3.563, vaf: 115.7 };
/** 2N7000 as a level-1 model: Vth ≈ 2.1 V, Rds(on) ≈ 1.8 Ω at Vgs = 4.5 V. */
export const M2N7000: MosModel = { type: 'nmos', vto: 2.1, kp: 0.23, lambda: 0.01 };
export const DIODES: Record<string, DiodeModel> = {
  '1N4148': { is: 2.52e-9, n: 1.752, rs: 0.568 },
  '1N4007': { is: 7.03e-9, n: 1.808, rs: 0.0342 },
  '1N5819': { is: 3.17e-5, n: 1.373, rs: 0.051 }, // Schottky: low forward voltage
};
const bjtFrom = (type: 'npn' | 'pnp', p: Record<string, number>): BjtModel =>
  ({ type, is: p.is ?? 1e-16, bf: p.bf ?? 100, br: p.br ?? 1, nf: p.nf ?? 1, nr: p.nr ?? 1, vaf: p.vaf || p.va || Infinity });
const ACT_FULL = 0.005; // collector/drain current shown as "fully on" (5 mA)
/** Toy 3–6 V DC motor: ~9500 rpm and ~20 mA unloaded at 5 V, 0.5 A stall. */
export const MOTOR = { ra: 10, la: 0.5e-3, k: 0.005, j: 1e-6, b: 1e-7 };
/** 5 V relay: 70 Ω / 100 mH coil, pulls in above 35 mA, drops out below 15 mA. */
export const RELAY = { r: 70, l: 0.1, pullIn: 0.035, dropOut: 0.015 };
export const CAP_VALUES: Record<string, number> = { '100nF': 100e-9, '1µF': 1e-6, '10µF': 10e-6, '100µF': 100e-6, '470µF': 470e-6 };

/** Logic chip: driver source per output (initially high-impedance) and a small supply load. */
export function chipModel(def: ChipDef): ModelFn {
  return (ckt, c0, pin) => {
    ckt.resistor(pin(def.vcc), pin(def.gnd), 100_000, `${c0.id}_iq`);
    if (def.type === 'ne555') { // internal 5k-5k-5k divider: CTRL sits at 2/3 VCC
      const mid = ckt.node(`${c0.id}#div`);
      ckt.resistor(pin('VCC'), pin('CTRL'), 5000, `${c0.id}_r1`);
      ckt.resistor(pin('CTRL'), mid, 5000, `${c0.id}_r2`);
      ckt.resistor(mid, pin('GND'), 5000, `${c0.id}_r3`);
    }
    const outs = new Map<string, VSource>();
    for (const o of def.outputs) outs.set(o, ckt.vsource(pin(o), pin(def.gnd), dc(0), 1e9, `${c0.id}_${o}`));
    return { chip: { outs, node: pin } };
  };
}

export type PinNode = (pinId: string) => number;
/** `cur()` returns the part as it is now: the worker receives a fresh copy of the project on every edit. */
type ModelFn = (ckt: Circuit, c: Component, pin: PinNode, ui: () => { pressed?: boolean } | undefined, cur: () => Component) => PartModel;

const ldrOhms = (light: number) => 100_000 * Math.pow(0.01, Math.min(1, Math.max(0, light)));

export const MODELS: Record<string, ModelFn> = {
  resistor(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const r = ckt.resistor(pin('1'), pin('2'), Number(c.props.ohms) || 220, `${c.id}`);
    return { update: () => { const v = Number(c.props.ohms) || 220; if (v === r.r) return false; r.r = v; return true; } };
  },
  led(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const vfOf = () => LED_VF[String(c.props.color)] ?? LED_VF.red;
    let vf = vfOf();
    const d = ckt.diode(pin('A'), pin('C'), ledModel(vf), c.id);
    return {
      led: d,
      update: () => {
        const v = vfOf(); if (v === vf) return false;
        vf = v; d.setModel(ledModel(v)); // series resistance is unchanged across colours
        return true;
      },
    };
  },
  button(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const sw: Switch = ckt.switch(pin('1'), pin('2'), !!ui()?.pressed, c.id);
    return { update: () => { const on = !!ui()?.pressed; if (on === sw.closed) return false; sw.closed = on; return true; } };
  },
  pot(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const total = 10_000;
    const pos = () => Math.min(1, Math.max(0, Number(c.props.value)));
    let p = pos();
    const top = ckt.resistor(pin('VCC'), pin('SIG'), (1 - p) * total + 1, `${c.id}_top`);
    const bot = ckt.resistor(pin('SIG'), pin('GND'), p * total + 1, `${c.id}_bot`);
    return { update: () => { const q = pos(); if (q === p) return false; p = q; top.r = (1 - p) * total + 1; bot.r = p * total + 1; return true; } };
  },
  ldr(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    let l = Number(c.props.light);
    const r = ckt.resistor(pin('VCC'), pin('AO'), ldrOhms(l), `${c.id}_ldr`);
    ckt.resistor(pin('AO'), pin('GND'), 10_000, `${c.id}_load`);
    return { update: () => { const v = Number(c.props.light); if (v === l) return false; l = v; r.r = ldrOhms(l); return true; } };
  },
  pir(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    ckt.resistor(pin('VCC'), pin('GND'), 50_000, `${c.id}_supply`);
    const out: VSource = ckt.vsource(pin('OUT'), pin('GND'), dc(c.props.motion ? V_LOGIC : 0), 1000, `${c.id}_out`);
    return { update: () => { const v = c.props.motion ? V_LOGIC : 0; if (out.wave.kind === 'dc' && out.wave.v === v) return false; out.wave = dc(v); return true; } };
  },
  dht22(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    ckt.resistor(pin('VCC'), pin('GND'), 2200, `${c.id}_supply`);
    ckt.resistor(pin('DATA'), pin('VCC'), 10_000, `${c.id}_pullup`);
    return {};
  },
  buzzer(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } }; ckt.resistor(pin('+'), pin('-'), 100_000, c.id); return {}; },
  servo(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    ckt.resistor(pin('V+'), pin('GND'), 330, `${c.id}_motor`);
    ckt.resistor(pin('SIG'), pin('GND'), 100_000, `${c.id}_sig`);
    return {};
  },
  npn(ckt, c0, pin) {
    const m = customModel(c0.id, c0.props.spice, ['npn']);
    if (!m && spiceLib(c0.props.spice) && !(spiceLib(c0.props.spice) instanceof Error)) noModel(c0.id, 'NPN .model');
    const q = ckt.add(new Bjt(pin('C'), pin('B'), pin('E'), m ? bjtFrom('npn', m.p) : Q2N2222), c0.id);
    return { activity: (x) => Math.min(1, Math.max(0, q.collectorCurrent(x)) / ACT_FULL) };
  },
  pnp(ckt, c0, pin) {
    const m = customModel(c0.id, c0.props.spice, ['pnp']);
    if (!m && spiceLib(c0.props.spice) && !(spiceLib(c0.props.spice) instanceof Error)) noModel(c0.id, 'PNP .model');
    const q = ckt.add(new Bjt(pin('C'), pin('B'), pin('E'), m ? bjtFrom('pnp', m.p) : Q2N2907), c0.id);
    return { activity: (x) => Math.min(1, Math.max(0, -q.collectorCurrent(x)) / ACT_FULL) };
  },
  nmos(ckt, c0, pin) {
    const sub = customSubckt(c0.props.spice, 3);
    if (sub) { // vendor power-MOSFET models are subcircuits with pins D G S
      try { instantiateSubckt(ckt, sub.lib, sub.name, [pin('D'), pin('G'), pin('S')], c0.id); return {}; }
      catch (e) { modelLog.fn(`${c0.id}: custom SPICE subcircuit not used (${(e as Error).message}). Using the built-in model.`); }
    }
    const cm = customModel(c0.id, c0.props.spice, ['nmos']);
    if (cm && (cm.p.level ?? 1) !== 1) modelLog.fn(`${c0.id}: only LEVEL=1 MOSFET models are supported. Using the built-in model.`);
    const mm: MosModel = cm && (cm.p.level ?? 1) === 1 ? { type: 'nmos', vto: cm.p.vto ?? 0, kp: cm.p.kp ?? 2e-5, lambda: cm.p.lambda ?? 0 } : M2N7000;
    const m = ckt.add(new Mosfet(pin('D'), pin('G'), pin('S'), mm), c0.id);
    ckt.diode(pin('S'), pin('D'), { is: 1e-14, n: 1 }, `${c0.id}_body`); // body diode
    return { activity: (x) => Math.min(1, Math.abs(m.drainCurrent(x)) / ACT_FULL) };
  },
  diode(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const pick = () => String(c.props.model) in DIODES ? String(c.props.model) : '1N4148';
    let name = pick();
    const cm = customModel(c.id, c.props.spice, ['d']);
    if (cm) { ckt.diode(pin('A'), pin('K'), { is: cm.p.is ?? 1e-14, n: cm.p.n ?? 1, rs: cm.p.rs ?? 0 }, c.id); return {}; }
    // Series resistance needs an internal node, so model changes keep the original structure and only
    // swap the junction parameters (Rs differences between these types are small).
    const d = ckt.diode(pin('A'), pin('K'), DIODES[name], c.id);
    return { update: () => { const n = pick(); if (n === name) return false; name = n; d.setModel(DIODES[n]); return true; } };
  },
  opamp(ckt, c0, pin) {
    const lib = spiceLib(c0.props.spice);
    if (lib instanceof Error) modelLog.fn(`${c0.id}: custom SPICE model not used (${lib.message}). Using the built-in model.`);
    else if (lib) {
      const sub = customSubckt(c0.props.spice, 5);
      if (!sub) noModel(c0.id, '5-pin .subckt (+IN −IN VCC VEE OUT)');
      else { // standard op-amp macro-model pin order: +IN −IN VCC VEE OUT
        try { instantiateSubckt(ckt, sub.lib, sub.name, [pin('IN+'), pin('IN-'), pin('VCC'), pin('GND'), pin('OUT')], c0.id); return {}; }
        catch (e) { modelLog.fn(`${c0.id}: custom SPICE subcircuit not used (${(e as Error).message}). Using the built-in model.`); }
      }
    }
    ckt.add(new OpAmp(pin('IN+'), pin('IN-'), pin('OUT'), pin('VCC'), pin('GND'), LM358), c0.id);
    ckt.resistor(pin('VCC'), pin('GND'), 7000, `${c0.id}_iq`); // ~0.7 mA quiescent current at 5 V
    return {};
  },
  capacitor(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const val = () => CAP_VALUES[String(c.props.value)] ?? 1e-6;
    let v = val();
    const cap = ckt.capacitor(pin('+'), pin('-'), v, c.id);
    return { update: () => { const n = val(); if (n === v) return false; v = n; cap.c = n; return true; } };
  },
  /**
   * Small brushed DC motor. Electrical side: Ra + La in series with the back-EMF (K·ω). Mechanical side
   * as an electrical analog on an internal node whose voltage is the shaft speed ω (rad/s): inertia J is
   * a capacitor, viscous friction b a resistor (1/b), and the torque K·i a controlled current source.
   */
  motor(ckt, c0, pin) {
    const { ra, la, k, j, b } = MOTOR;
    const n1 = ckt.node(`${c0.id}#ra`), n2 = ckt.node(`${c0.id}#la`), w = ckt.node(`${c0.id}#speed`);
    ckt.resistor(pin('+'), n1, ra, `${c0.id}_Ra`);
    ckt.inductor(n1, n2, la, `${c0.id}_La`);
    ckt.add(new Vcvs(n2, pin('-'), w, 0, k), `${c0.id}_emf`);       // back-EMF = K·ω
    ckt.add(new Vccs(0, w, pin('+'), n1, k / ra), `${c0.id}_torque`); // torque K·i, i = V(Ra)/Ra
    ckt.capacitor(w, 0, j, `${c0.id}_J`);
    ckt.resistor(w, 0, 1 / b, `${c0.id}_b`);
    return { motor: { speedNode: w, voltsAcross: () => 0 } };
  },
  /** 5 V relay: coil (R + L) and a changeover contact (COM–NO, COM–NC); the bridge moves the armature. */
  relay(ckt, c0, pin) {
    const mid = ckt.node(`${c0.id}#coil`);
    const rc = ckt.resistor(pin('C1'), mid, RELAY.r, `${c0.id}_coilR`);
    ckt.inductor(mid, pin('C2'), RELAY.l, `${c0.id}_coilL`);
    const no = ckt.switch(pin('COM'), pin('NO'), false, `${c0.id}_NO`);
    const nc = ckt.switch(pin('COM'), pin('NC'), true, `${c0.id}_NC`);
    const v = (x: Float64Array, n: number) => (n === 0 ? 0 : x[n - 1]);
    return { relay: { coilCurrent: (x) => rc.current(x), contacts: [no], nc: [nc], closed: false, coilVolts: (x) => v(x, pin('C1')) - v(x, pin('C2')) } };
  },
  lcd(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    ckt.resistor(pin('VCC'), pin('GND'), 220, `${c.id}_backlight`);
    ckt.resistor(pin('SDA'), pin('VCC'), 4700, `${c.id}_sda_pullup`);
    ckt.resistor(pin('SCL'), pin('VCC'), 4700, `${c.id}_scl_pullup`);
    return {};
  },
};

export { Resistor };

// every logic chip in the library gets the generic chip model
for (const def of Object.values(CHIPS)) MODELS[def.type] = chipModel(def);
