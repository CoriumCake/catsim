/* Electrical models for the power, sensor and module parts: batteries, the TP4056 charger, regulators,
 * boards running from a battery, RGB LEDs, 7-segment digits, switches, FSRs, joysticks, encoders,
 * sensor modules, the vibration motor and the L298N driver. */
import { Circuit, Diode, Switch, VSource, Resistor, volt } from './circuit.ts';
import { dc } from './waveform.ts';
import { Vcvs, Vccs } from './devices.ts';
import { MODELS, ledModel, chipModel, DIODES, type PartModel, type PinNode, type Supply } from './models.ts';
import { CHIPS } from '../digital/chips.ts';
import type { Component } from '../types.ts';

const v = (x: Float64Array, n: number) => volt(x, n);
const lvl = (u: unknown) => Math.min(1, Math.max(0, Number(u) || 0));

/** Linear (LDO) or switching regulator: `vout` on `out` while the input is above `on` (off below `off`).
 * Its input draws what the output delivers (×Vout/Vin/eff for a switcher). */
function regulator(ckt: Circuit, id: string, inN: number, outN: number, gnd: number, o: { vout: number; on: number; off: number; eff?: number; max: number; what: string }) {
  const n = ckt.node(`${id}#reg`);
  const src: VSource = ckt.vsource(n, gnd, dc(o.vout), 0.1, `${id}_reg`);
  const sw: Switch = ckt.switch(n, outN, false, `${id}_en`);
  const rin: Resistor = ckt.resistor(inN, gnd, 1e7, `${id}_in`);
  const iout = (x: Float64Array) => (sw.closed ? Math.max(0, src.current(x)) : 0);
  const settle = (x: Float64Array) => {
    const vin = v(x, inN) - v(x, gnd);
    let changed = false;
    const want = sw.closed ? vin > o.off : vin > o.on;
    if (want !== sw.closed) { sw.closed = want; changed = true; }
    const i = iout(x);
    let r = i > 1e-6 && vin > 0.1 ? (o.eff ? (vin * vin * o.eff) / (o.vout * i) : vin / i) : 1e7;
    r = Math.min(1e7, Math.max(0.5, r));
    if (Math.abs(r - rin.r) / rin.r > 0.03) { rin.r = r; changed = true; }
    return changed;
  };
  const supply: Supply = { key: `${id}:out`, what: o.what, current: iout, max: o.max, short: o.max * 3, advice: 'Check the wiring of its output.' };
  return { settle, supply, on: () => sw.closed };
}

// ---------- boards running from a battery (power: 'pins') ----------
const BOARD_POWER: Record<string, { rail: string; load: number; feeds: Array<{ pin: string; vout: number; on: number; off: number; max: number; to: string }> }> = {
  // ESP32 DevKit: VIN → AMS1117 (≈1.1 V dropout) → 3V3; the chip draws ~80 mA
  esp32: { rail: '3V3', load: 3.3 / 0.08, feeds: [{ pin: 'VIN', to: '3V3', vout: 3.3, on: 4.4, off: 4.2, max: 0.8 }] },
  // ESP32-C3 Super Mini: 5V → ME6211 LDO → 3V3; ~30 mA without WiFi
  esp32c3: { rail: '3V3', load: 3.3 / 0.03, feeds: [{ pin: '5V', to: '3V3', vout: 3.3, on: 3.5, off: 3.4, max: 0.5 }] },
  // Arduino Uno: VIN → NCP1117 → 5V (needs ≥ 6.5 V); 5V → LP2985 → 3V3; ~50 mA
  uno: { rail: '5V', load: 5 / 0.05, feeds: [{ pin: 'VIN', to: '5V', vout: 5, on: 6.5, off: 6.2, max: 0.8 }, { pin: '5V', to: '3V3', vout: 3.3, on: 3.6, off: 3.5, max: 0.15 }] },
};
export function boardPowerModel(ckt: Circuit, b: Component, pin: PinNode): PartModel {
  const spec = BOARD_POWER[b.type] ?? BOARD_POWER.esp32;
  ckt.resistor(pin(spec.rail), 0, spec.load, `${b.id}_chip`);
  const regs = spec.feeds.map((f) => regulator(ckt, `${b.id}_${f.pin}`, pin(f.pin), pin(f.to), 0, { ...f, what: `${b.id}'s ${f.to} regulator` }));
  return {
    power: (x) => v(x, pin(spec.rail)),
    settle: (x) => regs.map((r) => r.settle(x)).some(Boolean),
    supply: regs.map((r) => r.supply),
  };
}

// ---------- batteries ----------
/** Open-circuit voltage at 0…100 % charge, internal resistance, sensible continuous current, short-circuit level. */
export const BATTERIES: Record<string, { curve: number[]; rs: number; max: number; short: number }> = {
  '18650 Li-ion (3.7 V)': { curve: [3.0, 3.45, 3.6, 3.68, 3.74, 3.8, 3.86, 3.93, 4.0, 4.08, 4.2], rs: 0.06, max: 3, short: 8 },
  '2× AA (3 V)': { curve: [2.0, 2.3, 2.4, 2.5, 2.55, 2.6, 2.7, 2.8, 2.9, 3.0, 3.2], rs: 0.3, max: 1, short: 4 },
  '9 V block': { curve: [6.0, 7.0, 7.6, 8.0, 8.3, 8.5, 8.7, 8.9, 9.1, 9.3, 9.6], rs: 1.5, max: 0.4, short: 2 },
  'CR2032 coin (3 V)': { curve: [2.4, 2.7, 2.8, 2.85, 2.9, 2.92, 2.95, 2.98, 3.0, 3.05, 3.1], rs: 15, max: 0.015, short: 0.1 },
};
export function batteryVolts(type: unknown, charge: unknown): number {
  const b = BATTERIES[String(type)] ?? BATTERIES['18650 Li-ion (3.7 V)'];
  const c = Math.min(100, Math.max(0, Number(charge) || 0)) / 10, i = Math.min(9, Math.floor(c));
  return b.curve[i] + (b.curve[i + 1] - b.curve[i]) * (c - i);
}

const batStates = new Map<string, { soc: number; prop: number }>();
function batteryState(id: string, charge: unknown) {
  let s = batStates.get(id);
  if (!s) { const p = Number(charge); s = { soc: Math.min(100, Math.max(0, p || 0)), prop: p }; batStates.set(id, s); }
  return s;
}
export function resetBatteries() { batStates.clear(); }

// ---------- multi-LED parts ----------
const RGB_VF = { R: 2.0, G: 3.0, B: 3.0 };

export const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

/** FSR 402: over 10 MΩ untouched, ~10 kΩ at 1 N, ~1 kΩ at 10 N, ~250 Ω when pressed hard. */
export const fsrOhms = (newtons: number) => (newtons < 0.1 ? 1e7 : Math.min(1e7, Math.max(250, 10_000 / Math.pow(newtons, 1.05))));

Object.assign(MODELS, {
  battery(ckt: Circuit, c0: Component, pin: PinNode, ui: unknown, cur: () => Component): PartModel {
    const c = () => cur();
    const spec = () => BATTERIES[String(c().props.type)] ?? BATTERIES['18650 Li-ion (3.7 V)'];
    // state of charge (%) follows the current that really flows: drained by the load, filled by a charger
    const st = batteryState(c0.id, c().props.charge);
    const src: VSource = ckt.vsource(pin('+'), pin('-'), dc(batteryVolts(c().props.type, st.soc)), spec().rs, c0.id);
    const s = spec();
    return {
      step: (x, dt) => {
        const mAh = Math.max(1, Number(c().props.capacity) || 2600);
        st.soc = Math.min(100, Math.max(0, st.soc - (src.current(x) * dt * 100) / (mAh * 3.6)));
      },
      update: () => {
        if (Number(c().props.charge) !== st.prop) { st.prop = Number(c().props.charge); st.soc = Math.min(100, Math.max(0, st.prop || 0)); } // slider moved
        const want = Math.round(batteryVolts(c().props.type, st.soc) * 1000) / 1000, rs = spec().rs;
        if (src.wave.kind === 'dc' && src.wave.v === want && src.rs === rs) return false;
        src.wave = dc(want); src.rs = rs; return true;
      },
      activity: () => st.soc / 100,
      supply: [{ key: `${c0.id}:bat`, what: `battery ${c0.id}`, current: (x) => Math.abs(src.current(x)), max: s.max, short: s.short, advice: 'A shorted battery gets hot and can catch fire: check that + and − are not wired together.' }],
    };
  },

  tp4056(ckt: Circuit, c0: Component, pin: PinNode, ui: unknown, cur: () => Component): PartModel {
    // charger side: IN−, B− are one ground; OUT+ is B+; OUT− goes through the DW01 + FS8205 protection switch
    ckt.resistor(pin('IN-'), pin('B-'), 0.01, `${c0.id}_gnd`);
    ckt.resistor(pin('IN+'), pin('IN-'), 100_000, `${c0.id}_inload`); // input LED/divider: an unplugged IN+ reads 0 V
    const rOut: Resistor = ckt.resistor(pin('B+'), pin('OUT+'), 0.03, `${c0.id}_out`);
    const prot: Switch = ckt.switch(pin('B-'), pin('OUT-'), true, `${c0.id}_prot`);
    // USB plugged in: 5 V on IN+
    const usbN = ckt.node(`${c0.id}#usb`);
    ckt.vsource(usbN, pin('IN-'), dc(5), 0.2, `${c0.id}_usb`);
    const usb: Switch = ckt.switch(usbN, pin('IN+'), !!cur().props.usb, `${c0.id}_usbsw`);
    // charger: constant voltage 4.2 V through ~0.6 Ω (≈ 1 A into a half-charged cell, tapering when full)
    const chgN = ckt.node(`${c0.id}#chg`);
    ckt.vsource(chgN, pin('B-'), dc(4.2), 0.6, `${c0.id}_chg`);
    const chg: Switch = ckt.switch(chgN, pin('B+'), false, `${c0.id}_chgsw`);
    let tripped = '';
    return {
      update: () => { const u = !!cur().props.usb; if (u === usb.closed) return false; usb.closed = u; return true; },
      settle: (x) => {
        const vin = v(x, pin('IN+')) - v(x, pin('IN-')), vbat = v(x, pin('B+')) - v(x, pin('B-'));
        let changed = false;
        const charging = vin > 4.3 && vbat > 1;
        if (charging !== chg.closed) { chg.closed = charging; changed = true; }
        const iout = Math.abs(rOut.current(x));
        if (prot.closed && (vbat < 2.5 || iout > 3)) { prot.closed = false; changed = true; tripped = iout > 3 ? 'overcurrent' : 'low battery'; }
        else if (!prot.closed && vbat > 3.0 && (vin > 4.3 || tripped === 'low battery')) { prot.closed = true; changed = true; tripped = ''; }
        return changed;
      },
      activity: (x) => {
        const vin = v(x, pin('IN+')) - v(x, pin('IN-')), vbat = v(x, pin('B+')) - v(x, pin('B-'));
        return vin > 4.3 ? (vbat < 4.15 ? 1 : 0.5) : prot.closed ? 0 : 0.25; // 1 red (charging), 0.5 blue (full), 0.25 output cut
      },
      supply: [{ key: `${c0.id}:out`, what: `${c0.id}'s OUT+/OUT−`, current: (x) => Math.abs(rOut.current(x)), max: 2, short: 3, advice: 'The DW01 protection would cut the output: check for a short between OUT+ and OUT−.' }],
    };
  },

  buckboost(ckt: Circuit, c0: Component, pin: PinNode): PartModel {
    const r = regulator(ckt, c0.id, pin('VIN'), pin('VOUT'), pin('GND'), { vout: 3.3, on: 1.8, off: 1.6, eff: 0.9, max: 1, what: `${c0.id}'s 3.3 V output` });
    return { settle: r.settle, supply: [r.supply], activity: () => (r.on() ? 1 : 0) };
  },

  rgb_led(ckt: Circuit, c0: Component, pin: PinNode): PartModel {
    const anode = String(c0.props.common) !== 'cathode';
    const leds: Record<string, Diode> = {};
    for (const k of ['R', 'G', 'B'] as const) leds[k] = anode ? ckt.diode(pin('COM'), pin(k), ledModel(RGB_VF[k]), `${c0.id}_${k}`) : ckt.diode(pin(k), pin('COM'), ledModel(RGB_VF[k]), `${c0.id}_${k}`);
    return { leds };
  },

  seg7(ckt: Circuit, c0: Component, pin: PinNode): PartModel {
    const anode = String(c0.props.common) === 'anode';
    const leds: Record<string, Diode> = {};
    for (const s of SEGMENTS) leds[s] = anode ? ckt.diode(pin('COM'), pin(s), ledModel(1.9), `${c0.id}_${s}`) : ckt.diode(pin(s), pin('COM'), ledModel(1.9), `${c0.id}_${s}`);
    return { leds };
  },

  slide_switch(ckt: Circuit, c0: Component, pin: PinNode, ui: unknown, cur: () => Component): PartModel {
    const on = () => !!cur().props.on;
    const a: Switch = ckt.switch(pin('COM'), pin('B'), on(), `${c0.id}_on`);
    const b: Switch = ckt.switch(pin('COM'), pin('A'), !on(), `${c0.id}_off`);
    return { update: () => { const o = on(); if (o === a.closed) return false; a.closed = o; b.closed = !o; return true; } };
  },

  fsr(ckt: Circuit, c0: Component, pin: PinNode, ui: () => { pressed?: boolean } | undefined, cur: () => Component): PartModel {
    const force = () => Math.max(Number(cur().props.force) || 0, ui()?.pressed ? 10 : 0);
    const r: Resistor = ckt.resistor(pin('1'), pin('2'), fsrOhms(force()), c0.id);
    return { update: () => { const o = fsrOhms(force()); if (o === r.r) return false; r.r = o; return true; } };
  },

  joystick(ckt: Circuit, c0: Component, pin: PinNode, ui: () => { pressed?: boolean } | undefined, cur: () => Component): PartModel {
    const pots = (['x', 'y'] as const).map((axis) => {
      const out = axis === 'x' ? 'VRx' : 'VRy';
      const p = () => { const q = Number(cur().props[axis]); return Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 0.5; };
      const top = ckt.resistor(pin('VCC'), pin(out), (1 - p()) * 10_000 + 1, `${c0.id}_${axis}t`);
      const bot = ckt.resistor(pin(out), pin('GND'), p() * 10_000 + 1, `${c0.id}_${axis}b`);
      return () => { const q = p(); const t = (1 - q) * 10_000 + 1; if (t === top.r) return false; top.r = t; bot.r = q * 10_000 + 1; return true; };
    });
    const sw: Switch = ckt.switch(pin('SW'), pin('GND'), false, `${c0.id}_sw`);
    return { update: () => { let ch = pots.map((f) => f()).some(Boolean); const p = !!ui()?.pressed; if (p !== sw.closed) { sw.closed = p; ch = true; } return ch; } };
  },

  encoder(ckt: Circuit, c0: Component, pin: PinNode, ui: () => { pressed?: boolean; key?: string; events?: Array<{ seq: number; key: string; down: boolean; t: number }> } | undefined, cur: () => Component, now: () => number): PartModel {
    // KY-040: CLK and DT are contacts to GND with 10 kΩ pull-ups on the module; SW is a plain button to GND
    ckt.resistor(pin('CLK'), pin('VCC'), 10_000, `${c0.id}_puA`);
    ckt.resistor(pin('DT'), pin('VCC'), 10_000, `${c0.id}_puB`);
    const a: Switch = ckt.switch(pin('CLK'), pin('GND'), false, `${c0.id}_A`);
    const b: Switch = ckt.switch(pin('DT'), pin('GND'), false, `${c0.id}_B`);
    const sw: Switch = ckt.switch(pin('SW'), pin('GND'), false, `${c0.id}_sw`);
    const st = encoderState(c0.id);
    return {
      update: () => {
        const u = ui();
        for (const e of u?.events ?? []) if (e.seq > st.seen) { st.seen = e.seq; if (e.down && (e.key === 'cw' || e.key === 'ccw')) st.queue.push({ dir: e.key === 'cw' ? 1 : -1, t: e.t }); }
        const [ca, cb] = encoderContacts(st, now());
        const pressed = !!u?.pressed && u.key === 'sw';
        if (ca === a.closed && cb === b.closed && pressed === sw.closed) return false;
        a.closed = ca; b.closed = cb; sw.closed = pressed; return true;
      },
    };
  },

  vibmotor(ckt: Circuit, c0: Component, pin: PinNode): PartModel {
    // 10 mm coin motor (3 V, ~70 mA running, 12 000 rpm): same electromechanical model as the DC motor, smaller
    const ra = 22, la = 0.1e-3, k = 0.0017, j = 2e-8, bf = 2e-9;
    const n1 = ckt.node(`${c0.id}#ra`), n2 = ckt.node(`${c0.id}#la`), w = ckt.node(`${c0.id}#speed`);
    ckt.resistor(pin('+'), n1, ra, `${c0.id}_Ra`);
    ckt.inductor(n1, n2, la, `${c0.id}_La`);
    ckt.add(new Vcvs(n2, pin('-'), w, 0, k), `${c0.id}_emf`);
    ckt.add(new Vccs(0, w, pin('+'), n1, k / ra), `${c0.id}_torque`);
    ckt.capacitor(w, 0, j, `${c0.id}_J`);
    ckt.resistor(w, 0, 1 / bf, `${c0.id}_b`);
    return { motor: { speedNode: w, voltsAcross: () => 0 } };
  },

  l298n(ckt: Circuit, c0: Component, pin: PinNode, ui: unknown, cur: () => Component): PartModel {
    const m = chipModel(CHIPS.l298n)(ckt, c0, pin, () => ui, cur, () => 0);
    // on-board 78M05: 5 V out while 12V is above ~7 V (5V-EN jumper fitted); ENA/ENB jumpers tie the enables to 5 V
    const reg = regulator(ckt, `${c0.id}_5v`, pin('12V'), pin('5V'), pin('GND'), { vout: 5, on: 7, off: 6.5, max: 0.5, what: `${c0.id}'s 5V output` });
    // the module's 8 Schottky diodes clamp the motor's inductive kick to the supply rails
    for (const o of ['OUT1', 'OUT2', 'OUT3', 'OUT4']) { ckt.diode(pin(o), pin('12V'), DIODES['1N5819'], `${c0.id}_${o}h`); ckt.diode(pin('GND'), pin(o), DIODES['1N5819'], `${c0.id}_${o}l`); }
    ckt.resistor(pin('ENA'), pin('5V'), 4700, `${c0.id}_ja`);
    ckt.resistor(pin('ENB'), pin('5V'), 4700, `${c0.id}_jb`);
    return { ...m, settle: reg.settle, supply: [reg.supply] };
  },
});

/** Sound / soil / gas modules: AO follows the level (× supply), DO is the LM393 comparator output (open-collector
 * with a 10 kΩ pull-up). `low`: DO goes LOW when the level is above the trimmer's threshold. */
export function sensorModule(ao: (props: Record<string, unknown>) => number, active: (props: Record<string, unknown>) => boolean) {
  return (ckt: Circuit, c0: Component, pin: PinNode, ui: unknown, cur: () => Component): PartModel => {
    ckt.resistor(pin('VCC'), pin('GND'), 1000, `${c0.id}_supply`); // module + LEDs (~5 mA at 5 V)
    const mid = ckt.node(`${c0.id}#ao`);
    const amp: Vcvs = ckt.add(new Vcvs(mid, pin('GND'), pin('VCC'), pin('GND'), ao(cur().props)), `${c0.id}_amp`) as Vcvs;
    ckt.resistor(mid, pin('AO'), 1000, `${c0.id}_aor`);
    ckt.resistor(pin('DO'), pin('VCC'), 10_000, `${c0.id}_dopu`);
    const doSw: Switch = ckt.switch(pin('DO'), pin('GND'), false, `${c0.id}_do`);
    const fire = () => active(cur().props);
    doSw.closed = fire();
    return {
      update: () => {
        const g = ao(cur().props), f = fire();
        if (g === amp.gain && f === doSw.closed) return false;
        amp.gain = g; doSw.closed = f; return true;
      },
      activity: () => (fire() ? 1 : 0),
    };
  };
}
Object.assign(MODELS, {
  bme280: (ckt: Circuit, c0: Component, pin: PinNode): PartModel => {
    ckt.resistor(pin('VIN'), pin('GND'), 3300 / 0.001, `${c0.id}_supply`); // ~1 mA
    ckt.resistor(pin('SDA'), pin('VIN'), 10_000, `${c0.id}_sdapu`); ckt.resistor(pin('SCL'), pin('VIN'), 10_000, `${c0.id}_sclpu`);
    return {};
  },
  mpu6050: (ckt: Circuit, c0: Component, pin: PinNode): PartModel => {
    ckt.resistor(pin('VCC'), pin('GND'), 1000, `${c0.id}_supply`); // module LED + LDO, ~4 mA
    ckt.resistor(pin('SDA'), pin('VCC'), 4700, `${c0.id}_sdapu`); ckt.resistor(pin('SCL'), pin('VCC'), 4700, `${c0.id}_sclpu`);
    ckt.resistor(pin('AD0'), pin('GND'), 4700, `${c0.id}_ad0`); // AD0 pulled down on the board: 0x68 unless driven HIGH
    return {};
  },
  lcd_parallel: (ckt: Circuit, c0: Component, pin: PinNode): PartModel => {
    ckt.resistor(pin('VDD'), pin('VSS'), 5000, `${c0.id}_logic`); // ~1 mA
    ckt.resistor(pin('V0'), pin('VSS'), 1e6, `${c0.id}_v0`);
    ckt.diode(pin('A'), pin('K'), ledModel(3.0), `${c0.id}_backlight`);
    return {};
  },
  sound: sensorModule((p) => lvl(p.level), (p) => lvl(p.level) > lvl(p.threshold)),
  soil: sensorModule((p) => 1 - lvl(p.moisture), (p) => lvl(p.moisture) > lvl(p.threshold)), // dry soil reads high; DO LOW when wet
  mq2: sensorModule((p) => lvl(p.gas), (p) => lvl(p.gas) > lvl(p.threshold)),
});

// ---------- KY-040 quadrature (shared with the Encoder libraries) ----------
/** A detent step takes 4 × 20 ms: CW is CLK low, then DT low, then CLK high, then DT high. */
export const ENC_STEP_MS = 20;
type EncState = { seen: number; queue: Array<{ dir: number; t: number }>; pos: number; startAt: number };
const encStates = new Map<string, EncState>();
export function encoderState(id: string): EncState {
  let s = encStates.get(id);
  if (!s) { s = { seen: 0, queue: [], pos: 0, startAt: -1 }; encStates.set(id, s); }
  return s;
}
export function resetEncoders() { encStates.clear(); }
/** Contacts closed (pulled to GND) for CLK and DT at `now` (ms), advancing through queued detent steps. */
export function encoderContacts(st: EncState, now: number): [boolean, boolean] {
  while (st.queue.length) {
    const step = st.queue[0];
    if (st.startAt < 0) st.startAt = Math.max(now, step.t);
    const ph = Math.floor((now - st.startAt) / ENC_STEP_MS);
    if (ph < 0) return [false, false]; // not started yet
    if (ph >= 4) { st.pos += step.dir; st.queue.shift(); st.startAt = -1; continue; }
    // phases for CW: [A closed, B open], [A, B closed], [A open, B closed]; CCW swaps A and B
    const seq: Array<[boolean, boolean]> = [[true, false], [true, true], [false, true], [false, false]];
    const [p, q] = seq[ph];
    return step.dir > 0 ? [p, q] : [q, p];
  }
  return [false, false];
}
