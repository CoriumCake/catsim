/* Electrical models for the parts library. Each model adds elements to the circuit for one part and
 * returns an `update` function that re-reads the part's properties / UI state (pot position, button
 * press…) and reports whether anything changed. */
import { Circuit, Diode, Resistor, Switch, VSource, VT, type DiodeModel } from './circuit.ts';
import { dc } from './waveform.ts';
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

export interface PartModel {
  update?: () => boolean;
  /** LEDs: the junction whose current sets the brightness */
  led?: Diode;
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
  lcd(ckt, c0, pin, ui, cur) {
    const c = { get id() { return c0.id; }, get props() { return cur().props; } };
    ckt.resistor(pin('VCC'), pin('GND'), 220, `${c.id}_backlight`);
    ckt.resistor(pin('SDA'), pin('VCC'), 4700, `${c.id}_sda_pullup`);
    ckt.resistor(pin('SCL'), pin('VCC'), 4700, `${c.id}_scl_pullup`);
    return {};
  },
};

export { Resistor };
