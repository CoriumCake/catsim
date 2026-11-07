/* Electrical models for the parts library. Each model adds elements to the circuit for one part and
 * returns an `update` function that re-reads the part's properties / UI state (pot position, button
 * press…) and reports whether anything changed. */
import { Circuit, Diode, Resistor, Switch, VSource, VT, type DiodeModel } from './circuit.ts';
import { dc } from './waveform.ts';
import { Bjt, Mosfet, OpAmp, LM358, type BjtModel, type MosModel } from './devices.ts';
import { CHIPS, type ChipDef } from '../digital/chips.ts';
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

export interface PartModel {
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
const ACT_FULL = 0.005; // collector/drain current shown as "fully on" (5 mA)
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
    const q = ckt.add(new Bjt(pin('C'), pin('B'), pin('E'), Q2N2222), c0.id);
    return { activity: (x) => Math.min(1, Math.max(0, q.collectorCurrent(x)) / ACT_FULL) };
  },
  pnp(ckt, c0, pin) {
    const q = ckt.add(new Bjt(pin('C'), pin('B'), pin('E'), Q2N2907), c0.id);
    return { activity: (x) => Math.min(1, Math.max(0, -q.collectorCurrent(x)) / ACT_FULL) };
  },
  nmos(ckt, c0, pin) {
    const m = ckt.add(new Mosfet(pin('D'), pin('G'), pin('S'), M2N7000), c0.id);
    ckt.diode(pin('S'), pin('D'), { is: 1e-14, n: 1 }, `${c0.id}_body`); // body diode
    return { activity: (x) => Math.min(1, Math.abs(m.drainCurrent(x)) / ACT_FULL) };
  },
  diode(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    const pick = () => String(c.props.model) in DIODES ? String(c.props.model) : '1N4148';
    let name = pick();
    // Series resistance needs an internal node, so model changes keep the original structure and only
    // swap the junction parameters (Rs differences between these types are small).
    const d = ckt.diode(pin('A'), pin('K'), DIODES[name], c.id);
    return { update: () => { const n = pick(); if (n === name) return false; name = n; d.setModel(DIODES[n]); return true; } };
  },
  opamp(ckt, c0, pin) {
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
