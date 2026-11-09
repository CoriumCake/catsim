/* CatSim — basic parts and power parts: RGB LED, 7-segment digit, slide switch, batteries, FSR, coin
 * vibration motor, TP4056 charger, 3.3 V buck-boost regulator, joystick, KY-040 encoder, L298N, sound /
 * soil / gas sensor modules, a half-size breadboard and the ESP32-C3 Super Mini board. */
import { esc } from './util.ts';
import { BATTERIES, batteryVolts, fsrOhms, SEGMENTS, ENC_STEP_MS } from './analog/models-extra.ts';

const lead = (d) => `<path d="${d}" stroke="#a7adb7" stroke-width="2" fill="none"/>`;
const glow = (cx, cy, r, color, o) => (o > 0.02 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${o.toFixed(2)}" filter="url(#cs-blur)"/>` : '');
const leds = (sim, id) => (sim.running && sim.analog && sim.analog.leds) || {};
const act = (sim, id) => (sim.running && sim.analog && sim.analog.parts ? sim.analog.parts[id] ?? 0 : 0);
const burnt = (sim, key) => !!(sim.running && sim.analog && sim.analog.burnt && (sim.analog.burnt.has ? sim.analog.burnt.has(key) : sim.analog.burnt.includes(key)));
const fmtOhms = (o) => (o >= 1e6 ? `${+(o / 1e6).toFixed(1)} MΩ` : o >= 1e3 ? `${+(o / 1e3).toFixed(1)} kΩ` : `${Math.round(o)} Ω`);

// ---------- RGB LED (4 legs) ----------
const rgbLed = {
  type: 'rgb_led', name: 'RGB LED (4-pin)', category: 'Output', w: 44, h: 70,
  pins: [
    { id: 'R', label: 'R', x: 7, y: 70, dir: 'b', title: 'Red' },
    { id: 'COM', label: 'COM', x: 17, y: 70, dir: 'b', title: 'Common (longest leg): + for common anode, − for common cathode' },
    { id: 'G', label: 'G', x: 27, y: 70, dir: 'b', title: 'Green' },
    { id: 'B', label: 'B', x: 37, y: 70, dir: 'b', title: 'Blue' },
  ],
  props: { common: 'anode' },
  structural: ['common'],
  optional: ['R', 'G', 'B'],
  controls: [{ key: 'common', label: 'Type', type: 'select', options: ['anode', 'cathode'], fmt: (v) => (v === 'anode' ? 'Common anode (COM to +)' : 'Common cathode (COM to GND)') }],
  hint: 'Each color needs its own resistor (220 Ω). Common anode: COM to 3.3 V / 5 V, a color lights when its pin is LOW. Common cathode: COM to GND, a color lights when its pin is HIGH.',
  state: (c, sim) => { const L = leds(sim, c.id); return { r: L[`${c.id}:R`] || 0, g: L[`${c.id}:G`] || 0, b: L[`${c.id}:B`] || 0 }; },
  render(c, s) {
    const r = s.r || 0, g = s.g || 0, b = s.b || 0, m = Math.max(r, g, b);
    const col = m > 0.02 ? `rgb(${Math.round((r / m) * 255)},${Math.round((g / m) * 255)},${Math.round((b / m) * 255)})` : '#eef1f4';
    return `${glow(22, 18, 18 + m * 10, col, m > 0.02 ? 0.25 + 0.5 * m : 0)}${lead('M7 38 V70 M17 38 V70 M27 38 V70 M37 38 V70')}
      <path d="M9 38 V18 a13 13 0 0 1 26 0 V38 Z" fill="#f4f6f8" fill-opacity=".85" stroke="rgba(0,0,0,.3)"/>
      ${m > 0.02 ? `<path d="M9 38 V18 a13 13 0 0 1 26 0 V38 Z" fill="${col}" opacity="${(0.35 + 0.65 * m).toFixed(2)}"/>` : ''}
      <rect x="7" y="36" width="30" height="4" rx="1" fill="#dfe3e8"/>
      <text x="7" y="66" class="cs-tiny cs-dark">R</text><text x="17" y="66" class="cs-tiny cs-dark">${c.props.common === 'cathode' ? '−' : '+'}</text><text x="27" y="66" class="cs-tiny cs-dark">G</text><text x="37" y="66" class="cs-tiny cs-dark">B</text>`;
  },
};

// ---------- single 7-segment digit (5161AS / 5161BS) ----------
const SEG_PATH = {
  a: 'M14 8 h20 l-3 4 h-14 z', b: 'M35 9 v18 l-4 -3 v-12 z', c: 'M35 31 v18 l-4 -3 v-12 z', d: 'M14 50 h20 l-3 -4 h-14 z',
  e: 'M13 31 v18 l4 -3 v-12 z', f: 'M13 9 v18 l4 -3 v-12 z', g: 'M14 29 l3 -2.5 h14 l3 2.5 l-3 2.5 h-14 z',
};
const seg7 = {
  type: 'seg7', name: '7-Segment Digit', category: 'Output', w: 60, h: 96,
  pins: [
    ...['g', 'f', 'COM', 'a', 'b'].map((id, i) => ({ id, label: id, x: 6 + i * 12, y: 0, dir: 't', title: id === 'COM' ? 'Common (pins 3 and 8 are joined)' : `Segment ${id}` })),
    ...['e', 'd', 'COM2', 'c', 'dp'].map((id, i) => ({ id, label: id === 'COM2' ? 'COM' : id, x: 6 + i * 12, y: 96, dir: 'b', title: id === 'COM2' ? 'Common (pins 3 and 8 are joined)' : `Segment ${id}` })),
  ],
  bonded: [['COM', 'COM2']],
  props: { common: 'cathode' },
  structural: ['common'],
  optional: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp', 'COM2'],
  controls: [{ key: 'common', label: 'Type', type: 'select', options: ['cathode', 'anode'], fmt: (v) => (v === 'anode' ? 'Common anode (5161BS)' : 'Common cathode (5161AS)') }],
  hint: 'Each segment is an LED: give each one a resistor (220–330 Ω). Common cathode: COM to GND, HIGH lights a segment.',
  state: (c, sim) => { const L = leds(sim, c.id); return { on: Object.fromEntries(SEGMENTS.map((s) => [s, L[`${c.id}:${s}`] || 0])) }; },
  render(c, s) {
    const on = s.on || {};
    let segs = '';
    for (const k of Object.keys(SEG_PATH)) segs += `<path d="${SEG_PATH[k]}" transform="translate(6 18)" fill="${on[k] > 0.03 ? '#ff3b30' : '#3a1414'}" opacity="${on[k] > 0.03 ? (0.45 + 0.55 * on[k]).toFixed(2) : 1}"/>`;
    segs += `<circle cx="46" cy="70" r="2.6" fill="${on.dp > 0.03 ? '#ff3b30' : '#3a1414'}"/>`;
    return `${lead('M6 0 V10 M18 0 V10 M30 0 V10 M42 0 V10 M54 0 V10 M6 86 V96 M18 86 V96 M30 86 V96 M42 86 V96 M54 86 V96')}
      <rect x="2" y="10" width="56" height="76" rx="3" fill="#1b1b1e" stroke="#000"/>${segs}`;
  },
};

// ---------- SPDT slide switch (ON/OFF) ----------
const slideSwitch = {
  type: 'slide_switch', name: 'Slide Switch (ON/OFF)', category: 'Input', w: 56, h: 46, interactive: 'toggle',
  pins: [
    { id: 'A', label: '1', x: 14, y: 46, dir: 'b', title: 'Throw 1: joined to COM when OFF' },
    { id: 'COM', label: 'COM', x: 28, y: 46, dir: 'b', title: 'Common (middle pin)' },
    { id: 'B', label: '2', x: 42, y: 46, dir: 'b', title: 'Throw 2: joined to COM when ON' },
  ],
  props: { on: false },
  optional: ['A', 'B'],
  controls: [{ key: 'on', label: 'ON (COM joined to pin 2)', type: 'toggle' }],
  hint: 'Click it to flip, also while the simulation runs. For a power switch use COM and pin 2.',
  internal: (c) => (c.props.on ? [['COM', 'B']] : [['COM', 'A']]),
  state: () => ({}),
  render(c) {
    const on = !!c.props.on;
    return `${lead('M14 30 V46 M28 30 V46 M42 30 V46')}<rect x="4" y="10" width="48" height="22" rx="2" fill="#c9ced6" stroke="#7d848e"/>
      <rect x="10" y="15" width="36" height="12" rx="2" fill="#2b2f37"/><rect x="${on ? 29 : 11}" y="13" width="16" height="16" rx="2" fill="#f1f3f5" stroke="#555"/>
      <text x="28" y="7" class="cs-tiny ${on ? '' : 'cs-dark'}" fill="${on ? '#16a34a' : ''}">${on ? 'ON' : 'OFF'}</text>`;
  },
};

// ---------- batteries ----------
const battery = {
  type: 'battery', name: 'Battery', category: 'Power', w: 120, h: 44,
  pins: [
    { id: '+', label: '+', x: 0, y: 12, dir: 'l', title: '+ terminal' },
    { id: '-', label: '−', x: 0, y: 32, dir: 'l', title: '− terminal' },
  ],
  props: { type: '18650 Li-ion (3.7 V)', charge: 80, capacity: 2600 },
  controls: [
    { key: 'type', label: 'Type', type: 'select', options: Object.keys(BATTERIES) },
    { key: 'capacity', label: 'Capacity', type: 'select', options: [50, 220, 500, 1000, 2600, 3400], fmt: (v) => `${v} mAh${+v <= 50 ? ' (drains fast: for demos)' : ''}` },
    { key: 'charge', label: 'Charge', type: 'range', min: 0, max: 100, step: 1, fmt: (v) => `${Math.round(v)} %` },
  ],
  hint: '18650: 4.2 V full, 3.7 V nominal, empty at 3.0 V. The charge goes down with the current your circuit draws and up while a TP4056 charges it (pick a small capacity to see it move). Never short it: it can deliver many amps.',
  state: (c, sim) => (sim.running && sim.analog && sim.analog.parts && sim.analog.parts[c.id] != null ? { soc: sim.analog.parts[c.id] * 100 } : {}),
  render(c, s) {
    const live = s && s.soc != null, t = String(c.props.type), ch = live ? s.soc : Math.min(100, Math.max(0, +c.props.charge || 0)), volts = batteryVolts(t, ch);
    const coin = /CR2032/.test(t), nine = /9 V/.test(t), aa = /AA/.test(t);
    const body = coin ? `<circle cx="64" cy="22" r="20" fill="#c9ced6" stroke="#7d848e"/><text x="64" y="20" class="cs-tiny cs-dark">CR2032</text>`
      : nine ? `<rect x="22" y="4" width="90" height="36" rx="3" fill="#2b2f37"/><rect x="22" y="4" width="26" height="36" fill="#d4a017"/><text x="80" y="20" class="cs-tiny cs-light">9V</text>`
        : aa ? `<rect x="22" y="3" width="86" height="17" rx="5" fill="#2b2f37"/><rect x="22" y="24" width="86" height="17" rx="5" fill="#2b2f37"/><rect x="22" y="3" width="20" height="17" rx="5" fill="#c58f1f"/><rect x="22" y="24" width="20" height="17" rx="5" fill="#c58f1f"/><text x="76" y="14" class="cs-tiny cs-light">AA</text><text x="76" y="35" class="cs-tiny cs-light">AA</text>`
          : `<rect x="20" y="6" width="94" height="32" rx="8" fill="#2f6fd6" stroke="#1e4c99"/><rect x="14" y="14" width="8" height="16" rx="2" fill="#b9bec7"/><text x="72" y="20" class="cs-tiny cs-light">18650</text>`;
    return `${lead('M0 12 H20 M0 32 H20')}${body}
      <rect x="40" y="${coin ? 34 : 28}" width="50" height="5" rx="2" fill="#0003"/><rect x="40" y="${coin ? 34 : 28}" width="${(ch / 2).toFixed(1)}" height="5" rx="2" fill="${ch > 20 ? '#22c55e' : '#ef4444'}"/>
      <text x="${coin ? 64 : 66}" y="${coin ? 30 : 26}" class="cs-tiny cs-light">${volts.toFixed(2)} V · ${ch < 10 ? ch.toFixed(1) : Math.round(ch)}%</text><text x="10" y="9" class="cs-tiny cs-dark">+</text>`;
  },
};

// ---------- FSR 402 ----------
const fsr = {
  type: 'fsr', name: 'Force Sensor (FSR 402)', category: 'Sensors', w: 44, h: 86, interactive: 'press',
  pins: [{ id: '1', label: '1', x: 17, y: 86, dir: 'b', title: 'Pin 1 (no polarity)' }, { id: '2', label: '2', x: 27, y: 86, dir: 'b', title: 'Pin 2 (no polarity)' }],
  props: { force: 0 },
  controls: [{ key: 'force', label: 'Force', type: 'range', min: 0, max: 20, step: 0.1, fmt: (v) => `${(+v).toFixed(1)} N (${fmtOhms(fsrOhms(+v))})` }],
  hint: 'A resistor that drops from >10 MΩ (untouched) to ~250 Ω when pressed. Read it with a 10 kΩ resistor to GND: FSR from 3.3 V to the ADC pin. Press it with the mouse for a firm push (10 N).',
  state: (c, sim) => ({ pressed: !!(sim.ui && sim.ui[c.id] && sim.ui[c.id].pressed) }),
  render(c, s) {
    const f = Math.max(+c.props.force || 0, s.pressed ? 10 : 0), k = Math.min(1, f / 10);
    return `${lead('M17 56 V86 M27 56 V86')}<rect x="14" y="36" width="16" height="24" fill="#c9a24a" opacity=".9"/>
      <circle cx="22" cy="22" r="20" fill="#2b2f37" stroke="#000"/><circle cx="22" cy="22" r="15" fill="#c9a24a" opacity="${(0.55 + 0.45 * k).toFixed(2)}"/>
      ${f > 0.05 ? `<circle cx="22" cy="22" r="${(6 + 6 * k).toFixed(1)}" fill="#fff" opacity=".25"/><text x="22" y="-4" class="cs-part-lbl">${f.toFixed(1)} N</text>` : ''}`;
  },
};

// ---------- coin vibration motor ----------
const vibmotor = {
  type: 'vibmotor', name: 'Vibration Motor (3 V coin)', category: 'Electromechanical', w: 44, h: 60,
  pins: [{ id: '+', label: '+', x: 16, y: 60, dir: 'b', title: '+ (red wire)' }, { id: '-', label: '−', x: 28, y: 60, dir: 'b', title: '− (blue wire)' }],
  props: {},
  hint: '10 mm coin motor: about 70 mA at 3 V, too much for a GPIO pin. Switch it with a MOSFET (AO3400) and put a diode (1N5819) across it.',
  state: (c, sim) => { const m = sim.analog && sim.analog.mech && sim.analog.mech.motors[c.id]; return { rpm: m ? m[0] : 0, angle: m ? m[1] : 0 }; },
  render(c, s) {
    const rpm = Math.abs(s.rpm || 0), on = rpm > 1500, dx = on ? Math.sin((s.angle || 0) * 7) * 1.6 : 0;
    return `<path d="M16 40 C16 50 16 52 16 60" stroke="#e5484d" stroke-width="2" fill="none"/><path d="M28 40 C28 50 28 52 28 60" stroke="#3d8bff" stroke-width="2" fill="none"/>
      <g transform="translate(${dx.toFixed(2)} 0)"><circle cx="22" cy="20" r="18" fill="#c9ced6" stroke="#7d848e"/><circle cx="22" cy="20" r="12" fill="#dfe3e8"/><circle cx="22" cy="20" r="4" fill="#9aa1ae"/></g>
      ${on ? `<path d="M2 12 q-3 8 0 16 M42 12 q3 8 0 16" stroke="#f59e0b" stroke-width="1.6" fill="none" class="cs-pulse"/><text x="22" y="-4" class="cs-part-lbl">${Math.round(rpm).toLocaleString()} rpm</text>` : ''}`;
  },
};

// ---------- TP4056 charger with DW01 protection ----------
const tp4056 = {
  type: 'tp4056', name: 'TP4056 Charger (protected)', category: 'Power', w: 130, h: 56,
  pins: [
    { id: 'IN+', label: 'IN+', x: 0, y: 12, dir: 'l', title: 'IN+ — 5 V charging input (the USB socket feeds it too)' },
    { id: 'IN-', label: 'IN−', x: 0, y: 44, dir: 'l', title: 'IN− — charging input ground' },
    { id: 'OUT+', label: 'OUT+', x: 130, y: 8, dir: 'r', title: 'OUT+ — to the load (protected)' },
    { id: 'B+', label: 'B+', x: 130, y: 21, dir: 'r', title: 'B+ — battery + (only the cell here)' },
    { id: 'B-', label: 'B−', x: 130, y: 34, dir: 'r', title: 'B− — battery −' },
    { id: 'OUT-', label: 'OUT−', x: 130, y: 47, dir: 'r', title: 'OUT− — load ground, through the protection switch' },
  ],
  props: { usb: false },
  optional: ['IN+', 'IN-', 'OUT+', 'OUT-'],
  controls: [{ key: 'usb', label: 'USB cable plugged in', type: 'toggle' }],
  hint: 'Battery on B+/B−, your circuit on OUT+/OUT−. Red LED: charging (1 A), blue: full. The DW01 cuts OUT− below 2.5 V or above 3 A.',
  state: (c, sim) => ({ a: act(sim, c.id) }),
  render(c, s) {
    const a = s.a || 0, red = a > 0.75, blue = a > 0.4 && a <= 0.75;
    return `<rect x="10" y="2" width="110" height="52" rx="3" fill="#1d3f8f" stroke="#10275c"/>
      <rect x="0" y="18" width="22" height="20" rx="2" fill="#c9ced6" stroke="#7d848e"/><rect x="2" y="23" width="12" height="10" fill="#2b2f37"/>
      <rect x="48" y="16" width="20" height="16" fill="#111"/><text x="58" y="27" class="cs-tiny cs-light">4056</text><rect x="76" y="20" width="12" height="10" fill="#111"/>
      ${glow(40, 44, 6, '#ff3030', red ? 0.85 : 0)}<circle cx="40" cy="44" r="3" fill="${red ? '#ff4040' : '#4a1515'}"/>
      ${glow(52, 44, 6, '#3d8bff', blue ? 0.85 : 0)}<circle cx="52" cy="44" r="3" fill="${blue ? '#5aa0ff' : '#15254a'}"/>
      ${['OUT+', 'B+', 'B−', 'OUT−'].map((l, i) => `<text x="113" y="${10.5 + i * 13}" class="cs-tiny cs-light" style="text-anchor:end">${l}</text>`).join('')}
      <text x="14" y="14" class="cs-tiny cs-light" style="text-anchor:start">IN+</text><text x="14" y="50" class="cs-tiny cs-light" style="text-anchor:start">IN−</text>
      ${a > 0.2 && a < 0.3 ? '<text x="65" y="-4" class="cs-part-lbl" fill="#dc2626">output cut</text>' : ''}`;
  },
};

// ---------- 3.3 V buck-boost regulator ----------
const buckboost = {
  type: 'buckboost', name: 'Buck-Boost Regulator 3.3 V', category: 'Power', w: 76, h: 46,
  pins: [
    { id: 'VIN', label: 'VIN', x: 0, y: 12, dir: 'l', title: 'VIN — 1.8 to 5.5 V in' },
    { id: 'GND', label: 'GND', x: 0, y: 34, dir: 'l' },
    { id: 'VOUT', label: '3V3', x: 76, y: 12, dir: 'r', title: 'VOUT — 3.3 V out, up to 1 A' },
    { id: 'GND2', label: 'GND', x: 76, y: 34, dir: 'r', title: 'GND (joined to the other GND)' },
  ],
  bonded: [['GND', 'GND2']],
  optional: ['GND2'],
  props: {},
  hint: 'Keeps 3.3 V while the input is anywhere from 1.8 to 5.5 V, so a Li-ion cell (4.2 → 3.0 V) can run a 3.3 V board until it is empty. About 90 % efficient.',
  state: (c, sim) => ({ on: act(sim, c.id) > 0.5 }),
  render(c, s) {
    return `<rect x="8" y="2" width="60" height="42" rx="3" fill="#1e7a3a" stroke="#114a22"/><rect x="28" y="10" width="14" height="14" fill="#111"/>
      <circle cx="54" cy="16" r="6" fill="#5b5f66" stroke="#2b2f37"/><text x="54" y="18.5" class="cs-tiny cs-light">L</text>
      ${glow(20, 34, 5, '#ef4444', s.on ? 0.8 : 0)}<circle cx="20" cy="34" r="2.5" fill="${s.on ? '#ff4545' : '#4a1515'}"/>
      <text x="14" y="15" class="cs-tiny cs-light" style="text-anchor:start">IN</text><text x="40" y="38" class="cs-tiny cs-light">3.3V</text>`;
  },
};

// ---------- joystick ----------
const joystick = {
  type: 'joystick', name: 'Joystick (2-axis + button)', category: 'Input', w: 84, h: 96, interactive: 'press',
  pins: ['GND', 'VCC', 'VRx', 'VRy', 'SW'].map((id, i) => ({ id, label: id === 'VCC' ? '+5V' : id, x: 14 + i * 14, y: 96, dir: 'b', title: { GND: 'GND', VCC: '+5V — supply (3.3 V on an ESP32)', VRx: 'VRx — X position (analog)', VRy: 'VRy — Y position (analog)', SW: 'SW — button, LOW when pressed (use INPUT_PULLUP)' }[id] })),
  props: { x: 0.5, y: 0.5 },
  optional: ['SW', 'VRx', 'VRy'],
  controls: [
    { key: 'x', label: 'X', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
    { key: 'y', label: 'Y', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
  ],
  hint: 'Two 10 kΩ pots: VRx and VRy sit at half the supply in the middle. Press it with the mouse for the button (SW to GND).',
  state: (c, sim) => ({ pressed: !!(sim.ui && sim.ui[c.id] && sim.ui[c.id].pressed) }),
  render(c, s) {
    const x = 42 + ((+c.props.x || 0.5) - 0.5) * 30, y = 40 - ((+c.props.y || 0.5) - 0.5) * 30;
    return `${lead('M14 80 V96 M28 80 V96 M42 80 V96 M56 80 V96 M70 80 V96')}<rect x="2" y="2" width="80" height="80" rx="4" fill="#1a1c21" stroke="#000"/>
      <circle cx="42" cy="40" r="28" fill="#2b2f37" stroke="#444"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.pressed ? 15 : 17}" fill="#3a3f48" stroke="#111"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="none" stroke="#555" stroke-dasharray="2 2"/>`;
  },
};

// ---------- KY-040 rotary encoder ----------
const encoder = {
  pulled: ['CLK', 'DT'],
  type: 'encoder', name: 'Rotary Encoder (KY-040)', category: 'Input', w: 76, h: 90, interactive: 'keys',
  pins: ['CLK', 'DT', 'SW', 'VCC', 'GND'].map((id, i) => ({ id, label: id === 'VCC' ? '+' : id, x: 10 + i * 14, y: 90, dir: 'b', title: { CLK: 'CLK — output A (quadrature)', DT: 'DT — output B (quadrature)', SW: 'SW — push button, LOW when pressed (no pull-up on the module)', VCC: '+ — 3.3 V or 5 V', GND: 'GND' }[id] })),
  props: {},
  optional: ['SW'],
  hint: 'Click the right half to turn one step clockwise, the left half for counter-clockwise, the middle to push. CLK and DT go LOW in turn (CLK first when turning clockwise); 20 detents per turn.',
  keyAt(c, x, y) { if (y < 6 || y > 72) return null; return x < 26 ? 'ccw' : x > 50 ? 'cw' : 'sw'; },
  state: (c, sim) => {
    const u = sim.ui && sim.ui[c.id]; let n = 0;
    for (const e of (u && u.events) || []) if (e.down) n += e.key === 'cw' ? 1 : e.key === 'ccw' ? -1 : 0;
    return { pos: n, key: u && u.pressed ? u.key : null };
  },
  render(c, s) {
    const a = (s.pos || 0) * 18;
    return `${lead('M10 74 V90 M24 74 V90 M38 74 V90 M52 74 V90 M66 74 V90')}<rect x="2" y="4" width="72" height="70" rx="3" fill="#1d3f8f" stroke="#10275c"/>
      <rect x="20" y="16" width="36" height="36" rx="3" fill="#c9ced6"/><circle cx="38" cy="34" r="${s.key === 'sw' ? 12 : 13}" fill="#2b2f37"/>
      <g transform="rotate(${a} 38 34)"><rect x="36.5" y="22" width="3" height="10" rx="1.5" fill="#e5e7eb"/></g>
      <path d="M9 34 a29 29 0 0 1 8 -18" stroke="${s.key === 'ccw' ? '#fbbf24' : '#9fb3c8'}" stroke-width="2" fill="none"/><text x="10" y="58" class="cs-tiny cs-light">↺</text>
      <path d="M67 34 a29 29 0 0 0 -8 -18" stroke="${s.key === 'cw' ? '#fbbf24' : '#9fb3c8'}" stroke-width="2" fill="none"/><text x="66" y="58" class="cs-tiny cs-light">↻</text>`;
  },
};

// ---------- L298N ----------
const l298n = {
  type: 'l298n', name: 'L298N Motor Driver', category: 'Electromechanical', w: 156, h: 132,
  pins: [
    { id: 'OUT1', label: 'OUT1', x: 0, y: 36, dir: 'l', title: 'OUT1 — motor A' }, { id: 'OUT2', label: 'OUT2', x: 0, y: 52, dir: 'l', title: 'OUT2 — motor A' },
    { id: 'OUT3', label: 'OUT3', x: 156, y: 36, dir: 'r', title: 'OUT3 — motor B' }, { id: 'OUT4', label: 'OUT4', x: 156, y: 52, dir: 'r', title: 'OUT4 — motor B' },
    ...['12V', 'GND', '5V', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'].map((id, i) => ({ id, label: id, x: 22 + i * 14, y: 132, dir: 'b', title: {
      '12V': '12V — motor supply (5–35 V)', GND: 'GND — shared with the board', '5V': '5V — out from the on-board regulator (when 12V > 7 V)',
      ENA: 'ENA — motor A enable / PWM speed (jumper to 5 V = full speed)', ENB: 'ENB — motor B enable / PWM speed (jumper to 5 V = full speed)',
      IN1: 'IN1 — motor A direction', IN2: 'IN2 — motor A direction', IN3: 'IN3 — motor B direction', IN4: 'IN4 — motor B direction' }[id] })),
  ],
  props: {},
  optional: ['OUT1', 'OUT2', 'OUT3', 'OUT4', '5V', 'ENA', 'ENB', 'IN1', 'IN2', 'IN3', 'IN4'],
  hint: 'IN1 HIGH + IN2 LOW: forward, swapped: reverse, both equal: brake. PWM on ENA sets the speed (unwired, its jumper keeps it on). Expect ~2 V lost in the driver.',
  state: () => ({}),
  render() {
    let fins = ''; for (let i = 0; i < 9; i++) fins += `<rect x="${44 + i * 8}" y="4" width="5" height="44" fill="#2b2f37"/>`;
    return `<rect x="6" y="4" width="144" height="112" rx="4" fill="#c0262d" stroke="#7a1418"/>${fins}
      <rect x="0" y="28" width="22" height="32" rx="2" fill="#2563eb"/><rect x="134" y="28" width="22" height="32" rx="2" fill="#2563eb"/>
      <rect x="10" y="98" width="40" height="18" rx="2" fill="#2563eb"/><rect x="62" y="104" width="88" height="12" fill="#111"/>
      <text x="78" y="72" class="cs-tiny cs-light">L298N</text><text x="78" y="82" class="cs-tiny cs-light">dual H-bridge</text>`;
  },
};

// ---------- sensor modules (LM393 comparator boards) ----------
function sensorModule(type, name, level, pinsOrder, hint, draw, labelFn) {
  return {
    type, name, category: 'Sensors', w: 64, h: 84, pulled: ['DO'],
    pins: pinsOrder.map((id, i) => ({ id, label: id, x: 11 + i * 14, y: 84, dir: 'b', title: { AO: 'AO — analog output', DO: 'DO — digital output (LOW when the threshold is crossed)', VCC: 'VCC — 3.3 V or 5 V', GND: 'GND' }[id] })),
    props: { [level.key]: level.def, threshold: 0.5 },
    optional: ['AO', 'DO'],
    controls: [
      { key: level.key, label: level.label, type: 'range', min: 0, max: 1, step: 0.01, fmt: labelFn },
      { key: 'threshold', label: 'Threshold (blue trimmer)', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
    ],
    hint,
    state: (c, sim) => ({ fired: act(sim, c.id) > 0.5 }),
    render(c, s) {
      return `${lead(pinsOrder.map((_, i) => `M${11 + i * 14} 70 V84`).join(' '))}<rect x="2" y="30" width="60" height="40" rx="3" fill="#1d3f8f" stroke="#10275c"/>
        <rect x="40" y="38" width="12" height="12" rx="2" fill="#2f6fe0"/><circle cx="46" cy="44" r="4" fill="#f1f1f1"/>
        ${glow(12, 60, 5, '#ef4444', s.fired ? 0.8 : 0)}<circle cx="12" cy="60" r="2.5" fill="${s.fired ? '#ff4545' : '#4a1515'}"/>${draw(c)}`;
    },
  };
}
const sound = sensorModule('sound', 'Sound Sensor (KY-038)', { key: 'level', label: 'Sound level', def: 0.1 }, ['AO', 'GND', 'VCC', 'DO'],
  'AO rises with loudness; DO goes LOW when the sound is louder than the threshold (set with the trimmer). Drag the level while it runs to make noise.',
  () => '<circle cx="22" cy="20" r="16" fill="#c9ced6" stroke="#7d848e"/><circle cx="22" cy="20" r="11" fill="#2b2f37"/>', (v) => `${Math.round(v * 100)} %`);
const soil = sensorModule('soil', 'Soil Moisture Sensor', { key: 'moisture', label: 'Moisture', def: 0.3 }, ['VCC', 'GND', 'DO', 'AO'],
  'AO is high in dry soil and drops as it gets wetter; DO goes LOW when the soil is wetter than the threshold.',
  () => '<path d="M14 30 V2 M30 30 V2" stroke="#c9a24a" stroke-width="5" stroke-linecap="round"/>', (v) => `${Math.round(v * 100)} % wet`);
const mq2 = sensorModule('mq2', 'Gas Sensor (MQ-2)', { key: 'gas', label: 'Gas / smoke', def: 0.1 }, ['VCC', 'GND', 'DO', 'AO'],
  'Smoke, LPG and methane: AO rises with concentration, DO goes LOW above the threshold. The real sensor has a heater that draws ~150 mA and needs a minute to warm up.',
  () => '<circle cx="22" cy="18" r="16" fill="#c9ced6" stroke="#7d848e"/><circle cx="22" cy="18" r="11" fill="#9aa1ae"/><path d="M14 18 h16 M22 10 v16" stroke="#7d848e"/>', (v) => `${Math.round(v * 100)} %`);

// ---------- half-size breadboard (400 holes) ----------
const BB_COLS = 30, BB_P = 10, BB_X0 = 16; // 10 units = 0.1", the legs of most parts
const bbRows = { top: ['a', 'b', 'c', 'd', 'e'], bottom: ['f', 'g', 'h', 'i', 'j'] };
const BB_Y = { tp: 10, tn: 20, a: 40, f: 100, bp: 160, bn: 170 };
const bbPins = [];
const bbBonded = [];
for (let col = 1; col <= BB_COLS; col++) {
  for (const [half, rows] of Object.entries(bbRows)) {
    rows.forEach((r, i) => { bbPins.push({ id: `${col}${r}`, label: `${r}${col}`, x: BB_X0 + (col - 1) * BB_P, y: (half === 'top' ? BB_Y.a : BB_Y.f) + i * BB_P, dir: half === 'top' ? 't' : 'b' }); if (i) bbBonded.push([`${col}${rows[i - 1]}`, `${col}${r}`]); });
  }
}
for (const [rail, y, dir] of [['T+', BB_Y.tp, 't'], ['T-', BB_Y.tn, 't'], ['B+', BB_Y.bp, 'b'], ['B-', BB_Y.bn, 'b']]) {
  for (let k = 0; k < 25; k++) {
    const col = k + Math.floor(k / 5); // groups of 5 with a gap
    bbPins.push({ id: `${rail}${k + 1}`, label: `${rail[1]} rail`, x: BB_X0 + 10 + col * BB_P, y, dir, title: `${rail[0] === 'T' ? 'Top' : 'Bottom'} ${rail[1] === '+' ? 'red (+)' : 'blue (−)'} power rail` });
    if (k) bbBonded.push([`${rail}${k}`, `${rail}${k + 1}`]);
  }
}
const breadboard = {
  type: 'breadboard', name: 'Breadboard (half, 400 holes)', category: 'Passive', w: BB_X0 * 2 + (BB_COLS - 1) * BB_P, h: 180,
  pins: bbPins, bonded: bbBonded, optional: true, props: {}, noPinHeaders: true,
  hint: 'Drop a part onto it and its legs plug into the holes (they snap into place). Holes a–e in one column are joined, and so are f–j; the red/blue rails are joined along their length. Wires can go to any hole.',
  state: () => ({}),
  render() {
    const w = this.w;
    let lbl = '';
    for (let col = 1; col <= BB_COLS; col += (col === 1 ? 4 : 5)) lbl += `<text x="${BB_X0 + (col - 1) * BB_P}" y="${BB_Y.a - 8}" class="cs-tiny cs-dark">${col}</text>`;
    for (const [i, r] of [...bbRows.top, ...bbRows.bottom].entries()) lbl += `<text x="6" y="${(i < 5 ? BB_Y.a : BB_Y.f) + (i % 5) * BB_P + 2.5}" class="cs-tiny cs-dark">${r}</text>`;
    return `<rect x="0" y="0" width="${w}" height="180" rx="4" fill="#f4f1e8" stroke="#cfc8b6"/>
      <rect x="0" y="${BB_Y.a + 4 * BB_P + 6}" width="${w}" height="${BB_Y.f - BB_Y.a - 4 * BB_P - 12}" fill="#e3ddcd"/>
      <path d="M8 4 H${w - 8} M8 ${BB_Y.bp - 6} H${w - 8}" stroke-width="1.5" stroke="#e5484d"/>
      <path d="M8 ${BB_Y.tn + 6} H${w - 8} M8 176 H${w - 8}" stroke-width="1.5" stroke="#3d8bff"/>${lbl}`;
  },
};

// ---------- ESP32-C3 Super Mini ----------
const C3_LEFT = [['5V', '5V', null, 'vcc'], ['GND', 'GND', null, 'gnd'], ['3V3', '3V3', null, 'vcc'], ['IO4', '4', 4], ['IO3', '3', 3], ['IO2', '2', 2], ['IO1', '1', 1], ['IO0', '0', 0]];
const C3_RIGHT = [['IO5', '5', 5], ['IO6', '6', 6], ['IO7', '7', 7], ['IO8', '8', 8], ['IO9', '9', 9], ['IO10', '10', 10], ['IO20', '20', 20], ['IO21', '21', 21]];
const C3_NOTE = { 0: 'ADC1_CH0', 1: 'ADC1_CH1', 2: 'ADC1_CH2, strapping pin', 3: 'ADC1_CH3', 4: 'ADC1_CH4', 5: 'ADC2 (not with WiFi)', 8: 'on-board LED (active LOW), default SDA, strapping pin', 9: 'BOOT button, default SCL, strapping pin', 20: 'RX', 21: 'TX' };
const C3_W = 100;
// Top view, USB-C at the top (checked against the espboards.dev pinout): GPIO 5–10, 20, 21 down the left edge,
// 5V, GND, 3V3, GPIO 4–0 down the right edge.
const c3Pins = [
  ...C3_RIGHT.map(([id, label, gpio], i) => ({ id, label, gpio, kind: 'gpio', x: 0, y: 40 + i * 16, dir: 'l' })),
  ...C3_LEFT.map(([id, label, gpio, kind], i) => ({ id, label, gpio, kind: kind || 'gpio', x: C3_W, y: 40 + i * 16, dir: 'r' })),
];
c3Pins.forEach((p) => { p.title = p.kind === 'gpio' ? `GPIO${p.gpio}${C3_NOTE[p.gpio] ? ` — ${C3_NOTE[p.gpio]}` : ''}` : p.kind === 'gnd' ? 'GND' : p.id === '5V' ? '5V — USB 5 V, or a 3.5–5.5 V input' : '3V3 — 3.3 V (output on USB, or feed 3.3 V here from a battery regulator)'; });
const esp32c3 = {
  type: 'esp32c3', name: 'ESP32-C3 Super Mini', category: 'Boards', w: C3_W, h: 176, fixed: true, board: true,
  pins: c3Pins,
  props: { power: 'usb' },
  structural: ['power'],
  controls: [{ key: 'power', label: 'Powered by', type: 'select', options: ['usb', 'pins'], fmt: (v) => (v === 'pins' ? 'Its 5V / 3V3 pins (battery)' : 'USB') }],
  hint: '13 GPIOs (0–10, 20, 21), ADC on 0–4, WiFi + Bluetooth LE, no DAC. The blue LED on GPIO8 lights when the pin is LOW.',
  state: (c, sim) => { const b = (sim.boardState && sim.boardState(c.id)) || sim; return { led: !!(sim.running && b.mode && b.mode[8] === 3 && !b.out[8]), off: !!b.halted }; },
  render(c, s) {
    const pins = c3Pins.map((p) => `<text x="${p.x === 0 ? 10 : C3_W - 10}" y="${p.y + 3}" class="cs-tiny cs-light" style="text-anchor:${p.x === 0 ? 'start' : 'end'}">${esc(p.label)}</text>`).join('');
    return `<rect x="2" y="12" width="${C3_W - 4}" height="162" rx="5" fill="#16191f" stroke="#000"/>
      <rect x="32" y="0" width="36" height="22" rx="4" fill="#c9ced6" stroke="#7d848e"/><rect x="38" y="6" width="24" height="10" rx="3" fill="#2b2f37"/>
      <rect x="32" y="64" width="36" height="36" rx="2" fill="#2a2d33" stroke="#444"/><text x="50" y="80" class="cs-tiny cs-light">ESP32</text><text x="50" y="89" class="cs-tiny cs-light">C3</text>
      <rect x="40" y="132" width="20" height="30" rx="2" fill="#8a6a2c" opacity=".8"/>
      ${glow(50, 114, 7, '#3d8bff', s.led ? 0.9 : 0)}<circle cx="50" cy="114" r="3" fill="${s.led ? '#5aa0ff' : '#15254a'}"/>
      <rect x="22" y="30" width="12" height="8" rx="1" fill="#e5e7eb"/><rect x="66" y="30" width="12" height="8" rx="1" fill="#e5e7eb"/>
      <text x="28" y="47" class="cs-tiny cs-light">BOOT</text><text x="72" y="47" class="cs-tiny cs-light">RST</text>${pins}
      ${s.off ? `<rect x="2" y="12" width="${C3_W - 4}" height="162" rx="5" fill="#000" opacity=".55"/><text x="50" y="128" class="cs-part-lbl" fill="#fca5a5">no power</text>` : ''}`;
  },
};

export const BASIC_PARTS = { rgb_led: rgbLed, seg7, slide_switch: slideSwitch, battery, fsr, vibmotor, tp4056, buckboost, joystick, encoder, l298n, sound, soil, mq2, breadboard, esp32c3 };
export { ENC_STEP_MS };
