/* CatSim — part definitions.
 * Every part: { type, name, category, w, h, pins[], props{}, controls[], render(c, s), state(c, sim), ... }
 * Pin coordinates are local to the part; `dir` is the direction a wire leaves the pin (l/r/t/b). */
import { OUTPUT } from './pins.js';
import { esc, clamp } from './util.ts';
import { CHIPS } from './digital/chips.ts';
import { LIB_PARTS } from './parts-libs.js';
import { BASIC_PARTS } from './parts-basic.js';
import { applyRealSizes } from './part-sizes.js';
const LED_COLORS = {
  red: '#ff3b3b', green: '#22e06b', blue: '#3d8bff',
  yellow: '#ffd60a', white: '#f2f5ff', orange: '#ff8a1f',
};

// ---------- ESP32 DevKit V1 (30 pin) ----------
const ESP_LEFT = [
  ['EN', 'EN', null, 'nc'], ['VP', 'VP', 36], ['VN', 'VN', 39], ['D34', 'D34', 34], ['D35', 'D35', 35],
  ['D32', 'D32', 32], ['D33', 'D33', 33], ['D25', 'D25', 25], ['D26', 'D26', 26], ['D27', 'D27', 27],
  ['D14', 'D14', 14], ['D12', 'D12', 12], ['D13', 'D13', 13], ['GND.L', 'GND', null, 'gnd'], ['VIN', 'VIN', null, 'vcc'],
];
const ESP_RIGHT = [
  ['D23', 'D23', 23], ['D22', 'D22', 22], ['TX0', 'TX0', 1], ['RX0', 'RX0', 3], ['D21', 'D21', 21],
  ['D19', 'D19', 19], ['D18', 'D18', 18], ['D5', 'D5', 5], ['TX2', 'TX2', 17], ['RX2', 'RX2', 16],
  ['D4', 'D4', 4], ['D2', 'D2', 2], ['D15', 'D15', 15], ['GND.R', 'GND', null, 'gnd'], ['3V3', '3V3', null, 'vcc'],
];
const ESP_W = 150;
const ADC1 = { 32: 4, 33: 5, 34: 6, 35: 7, 36: 0, 39: 3 };
const ADC2 = { 4: 0, 0: 1, 2: 2, 15: 3, 13: 4, 12: 5, 14: 6, 27: 7, 25: 8, 26: 9 };
const TOUCH = { 4: 0, 0: 1, 2: 2, 15: 3, 13: 4, 12: 5, 14: 6, 27: 7, 33: 8, 32: 9 };

function espPinTitle(p) {
  if (p.kind === 'gnd') return 'GND — ground';
  if (p.id === '3V3') return '3V3 — 3.3 V supply';
  if (p.id === 'VIN') return 'VIN — 5 V (USB) supply';
  if (p.kind === 'nc') return 'EN — chip enable / reset';
  const g = p.gpio; const f = [`GPIO${g}`];
  if (g >= 34) f.push('input only, no pull-ups');
  if (g in ADC1) f.push(`ADC1_CH${ADC1[g]}`);
  if (g in ADC2) f.push(`ADC2_CH${ADC2[g]} (not with WiFi)`);
  if (g in TOUCH) f.push(`T${TOUCH[g]}`);
  if (g === 25 || g === 26) f.push(`DAC${g - 24}`);
  if (g === 21) f.push('I2C SDA'); if (g === 22) f.push('I2C SCL');
  if (g === 1 || g === 3) f.push('UART0 (USB serial)');
  if (g === 16 || g === 17) f.push('UART2');
  if ([0, 2, 5, 12, 15].includes(g)) f.push('strapping pin');
  if (g === 2) f.push('on-board LED');
  return `${p.label} — ${f.join(', ')}`;
}

const espPins = [
  ...ESP_LEFT.map(([id, label, gpio, kind], i) => ({ id, label, gpio, kind: kind || 'gpio', x: 0, y: 36 + i * 14, dir: 'l' })),
  ...ESP_RIGHT.map(([id, label, gpio, kind], i) => ({ id, label, gpio, kind: kind || 'gpio', x: ESP_W, y: 36 + i * 14, dir: 'r' })),
];
espPins.forEach((p) => { p.title = espPinTitle(p); });

const glow = (cx, cy, r, color, o) =>
  o > 0.02 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${(o).toFixed(2)}" filter="url(#cs-blur)"/>` : '';

/** @type {Record<string, import('./types.ts').PartDef>} */
const DEFS = {};

DEFS.esp32 = {
  type: 'esp32', name: 'ESP32 DevKit V1', category: 'Boards', w: ESP_W, h: 274, fixed: true, board: true,
  props: { power: 'usb' },
  structural: ['power'],
  controls: [{ key: 'power', label: 'Powered by', type: 'select', options: ['usb', 'pins'], fmt: (v) => (v === 'pins' ? 'Its VIN / 3V3 pins (battery)' : 'USB') }],
  pins: espPins,
  internal: () => [['GND.L', 'GND.R']],
  state(c, sim) {
    const b = (sim.boardState && sim.boardState(c.id)) || sim; // several boards: this board's own pins
    const on = b.mode[2] === OUTPUT ? (b.pwm[2] ?? (b.out[2] ? 1 : 0)) : 0;
    return { led2: on, power: sim.running };
  },
  render(c, s) {
    let o = `<rect x="6" y="0" width="${ESP_W - 12}" height="262" rx="7" fill="#151b28" stroke="#05070c" stroke-width="1.5"/>`;
    o += `<rect x="34" y="6" width="82" height="120" rx="3" fill="#1f232d" stroke="#0a0c11"/>`;
    o += `<path d="M40 12 h8 v13 h8 v-13 h8 v13 h8 v-13 h8 v13 h8 v-13 h8" fill="none" stroke="#c9a227" stroke-width="2"/>`;
    o += `<rect x="40" y="34" width="70" height="86" rx="2" fill="url(#cs-metal)" stroke="#7d8591"/>`;
    o += `<text x="75" y="72" class="cs-chip">ESP32</text><text x="75" y="86" class="cs-chip cs-chip-sm">WROOM-32</text>`;
    o += `<text x="75" y="146" class="cs-chip cs-chip-sm" fill="#7f8aa3">DEVKIT V1</text>`;
    espPins.forEach((p) => {
      const left = p.x === 0;
      o += `<text x="${left ? 10 : ESP_W - 10}" y="${p.y + 2.6}" class="cs-esp-lbl" text-anchor="${left ? 'start' : 'end'}">${p.label}</text>`;
    });
    // LEDs
    o += glow(62, 202, 9, '#ff3344', s.power ? 0.6 : 0);
    o += `<rect x="58" y="200" width="8" height="5" rx="1" fill="${s.power ? '#ff4d5e' : '#3a1418'}"/>`;
    o += `<text x="62" y="214" class="cs-tiny">PWR</text>`;
    o += glow(90, 202, 11, '#3d8bff', s.led2 * 0.9);
    o += `<rect x="86" y="200" width="8" height="5" rx="1" fill="${s.led2 > 0.02 ? '#7db5ff' : '#14233d'}"/>`;
    o += `<text x="90" y="214" class="cs-tiny">IO2</text>`;
    // buttons
    [[44, 'EN'], [94, 'BOOT']].forEach(([x, l]) => {
      o += `<rect x="${x}" y="236" width="14" height="10" rx="1.5" fill="#cfd4dc"/><circle cx="${x + 7}" cy="241" r="3" fill="#2b2f38"/>`;
      o += `<text x="${x + 7}" y="232" class="cs-tiny">${l}</text>`;
    });
    o += `<rect x="58" y="252" width="34" height="22" rx="2" fill="#aeb5c0" stroke="#6c737e"/><rect x="63" y="258" width="24" height="5" rx="1" fill="#555c66"/>`;
    return o;
  },
};

DEFS.led = {
  type: 'led', name: 'LED', category: 'Output', w: 30, h: 56,
  pins: [
    { id: 'A', label: 'A (+)', x: 10, y: 56, dir: 'b', title: 'Anode (+), long leg' },
    { id: 'C', label: 'C (−)', x: 20, y: 56, dir: 'b', title: 'Cathode (−), short leg' },
  ],
  props: { color: 'red' },
  controls: [{ key: 'color', label: 'Color', type: 'select', options: Object.keys(LED_COLORS) }],
  state(c, sim) {
    // Real brightness from the analog engine (averaged diode current) when it is running.
    if (sim.running && sim.analog && sim.analog.leds) return { b: sim.analog.leds[c.id] ?? 0, burnt: !!(sim.analog.burnt && (sim.analog.burnt.has ? sim.analog.burnt.has(c.id) : sim.analog.burnt.includes(c.id))) };
    const a = sim.pinLevel(c, 'A'); const k = sim.pinLevel(c, 'C');
    return { b: a != null && k != null ? clamp(a - k, 0, 1) : 0 };
  },
  render(c, s) {
    const col = LED_COLORS[c.props.color] || LED_COLORS.red; const b = s.b || 0;
    if (s.burnt) {
      return `<path d="M10 33 V45 L10 56" stroke="#a7adb7" stroke-width="2" fill="none"/>
        <path d="M20 33 V52 L20 56" stroke="#a7adb7" stroke-width="2" fill="none"/>
        <path d="M4 33 V16 a11 11 0 0 1 22 0 V33 Z" fill="#3b2f2a" stroke="#111"/>
        <rect x="2" y="31" width="26" height="4" rx="1" fill="#2a211d"/>
        <path d="M11 9 L15 17 L12 22 L17 29" stroke="#0b0b0b" stroke-width="1.6" fill="none"/>
        <path d="M15 4 c-4 -4 4 -7 0 -11 M20 2 c-3 -3 3 -6 0 -9" stroke="#9aa1ae" stroke-width="1.6" fill="none" opacity=".7" stroke-linecap="round" class="cs-pulse"/>
        <text x="15" y="-12" class="cs-part-lbl" fill="#dc2626">burnt</text>`;
    }
    return `${glow(15, 16, 16 + b * 10, col, b > 0.02 ? 0.25 + 0.5 * b : 0)}
      <path d="M10 33 V45 L10 56" stroke="#a7adb7" stroke-width="2" fill="none"/>
      <path d="M20 33 V52 L20 56" stroke="#a7adb7" stroke-width="2" fill="none"/>
      <path d="M4 33 V16 a11 11 0 0 1 22 0 V33 Z" fill="${col}" fill-opacity="${(0.38 + 0.62 * b).toFixed(2)}" stroke="rgba(0,0,0,.35)"/>
      <rect x="2" y="31" width="26" height="4" rx="1" fill="${col}" fill-opacity="0.75"/>
      ${b > 0.05 ? `<circle cx="15" cy="17" r="6" fill="#fff" opacity="${(0.55 * b).toFixed(2)}"/>` : ''}
      <path d="M9 11 a7 7 0 0 1 6 -5" stroke="#fff" stroke-opacity=".55" fill="none" stroke-width="2" stroke-linecap="round"/>`;
  },
};

function resistorBands(ohms) {
  const cols = ['#111', '#8b4513', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#9e9e9e', '#fafafa'];
  const s = String(Math.max(1, Math.round(+ohms || 220)));
  if (s.length < 2) return [cols[0], cols[+s], cols[0], '#c9a227'];
  return [cols[+s[0]], cols[+s[1]], cols[Math.min(9, s.length - 2)], '#c9a227'];
}
const fmtOhms = (o) => (o >= 1e6 ? `${+(o / 1e6).toFixed(1)}MΩ` : o >= 1e3 ? `${+(o / 1e3).toFixed(1)}kΩ` : `${o}Ω`);

DEFS.resistor = {
  type: 'resistor', name: 'Resistor', category: 'Passive', w: 70, h: 16,
  // leads 10.16 mm apart (400 mil), the body 6.8 mm × 2.5 mm
  pins: [{ id: '1', label: '1', x: 15, y: 8, dir: 'l' }, { id: '2', label: '2', x: 55, y: 8, dir: 'r' }],
  props: { ohms: 220 },
  // common E6/E12 values from 10 Ω to 1 MΩ (validated on load, so every value an example uses must be listed)
  controls: [{ key: 'ohms', label: 'Resistance (Ω)', type: 'select', options: ['10', '22', '47', '100', '150', '220', '330', '470', '680', '1000', '1500', '2200', '3300', '4700', '6800', '10000', '15000', '20000', '22000', '33000', '47000', '68000', '100000', '220000', '470000', '1000000'] }],
  internal: () => [['1', '2']],
  state: () => ({}),
  render(c) {
    const b = resistorBands(c.props.ohms);
    return `<line x1="15" y1="8" x2="55" y2="8" stroke="#a7adb7" stroke-width="2"/>
      <rect x="21.5" y="3" width="27" height="10" rx="4.5" fill="#d9c49a" stroke="#9b8558"/>
      <rect x="24" y="3" width="2.2" height="10" fill="${b[0]}"/><rect x="28" y="3" width="2.2" height="10" fill="${b[1]}"/>
      <rect x="32" y="3" width="2.2" height="10" fill="${b[2]}"/><rect x="43.5" y="3" width="2.2" height="10" fill="${b[3]}"/>
      <text x="35" y="-3" class="cs-part-lbl">${fmtOhms(+c.props.ohms)}</text>`;
  },
};

const BTN_COLORS = { red: '#e5484d', blue: '#3d8bff', green: '#2fbf71', yellow: '#f5c518', black: '#30343c' };
DEFS.button = {
  // a 6 mm tactile switch: four legs in two pairs that are always joined (1–1b, 2–2b); pressing joins 1 to 2
  type: 'button', name: 'Push Button', category: 'Input', w: 30, h: 40, interactive: 'press',
  pins: [
    { id: '1', label: '1', x: 4, y: 6, dir: 't', title: 'Leg 1 (always joined to leg 1b)' },
    { id: '1b', label: '1b', x: 22, y: 6, dir: 't', title: 'Leg 1b (always joined to leg 1)' },
    { id: '2', label: '2', x: 4, y: 32, dir: 'b', title: 'Leg 2 (always joined to leg 2b); pressing joins 1 and 2' },
    { id: '2b', label: '2b', x: 22, y: 32, dir: 'b', title: 'Leg 2b (always joined to leg 2)' },
  ],
  bonded: [['1', '1b'], ['2', '2b']],
  props: { color: 'red' },
  controls: [{ key: 'color', label: 'Cap color', type: 'select', options: Object.keys(BTN_COLORS) }],
  hint: 'Press with the mouse while the simulation runs',
  internal: (c, sim) => (sim.ui[c.id] && sim.ui[c.id].pressed ? [['1', '2']] : []),
  state: (c, sim) => ({ pressed: !!(sim.ui[c.id] && sim.ui[c.id].pressed) }),
  render(c, s) {
    const col = BTN_COLORS[c.props.color] || BTN_COLORS.red;
    return `<path d="M4 6 V8 M22 6 V8 M4 32 V30 M22 32 V30" stroke="#a7adb7" stroke-width="2"/>
      <rect x="1" y="7" width="24" height="24" rx="2" fill="#2a2e36" stroke="#14161b"/>
      <circle cx="13" cy="19" r="${s.pressed ? 6.2 : 7}" fill="${col}" stroke="rgba(0,0,0,.4)" stroke-width="${s.pressed ? 2 : 1}"/>
      ${s.pressed ? '' : '<circle cx="10.5" cy="16.5" r="2" fill="#fff" opacity=".25"/>'}`;
  },
};

DEFS.pot = {
  // a 9 mm rotary potentiometer: a 9 mm body, a Ø6 mm shaft, pins 2.5 mm apart
  type: 'pot', name: 'Potentiometer', category: 'Input', w: 56, h: 60,
  pins: [
    { id: 'GND', label: 'GND', x: 18, y: 60, dir: 'b' },
    { id: 'SIG', label: 'SIG', x: 28, y: 60, dir: 'b', title: 'SIG — wiper output (analog)' },
    { id: 'VCC', label: 'VCC', x: 38, y: 60, dir: 'b' },
  ],
  props: { value: 0.5 },
  controls: [{ key: 'value', label: 'Position', type: 'range', min: 0, max: 1, step: 0.001, fmt: (v) => `${Math.round(v * 100)}%` }],
  analog: { SIG: (c) => +c.props.value },
  state: () => ({}),
  render(c) {
    const a = -135 + 270 * (+c.props.value);
    return `<path d="M18 39 V60 M28 39 V60 M38 39 V60" stroke="#a7adb7" stroke-width="2"/>
      <rect x="10.5" y="4" width="35" height="35" rx="2" fill="#1e5bb8" stroke="#123a78"/>
      <g transform="rotate(${a.toFixed(1)} 28 21.5)"><circle cx="28" cy="21.5" r="11.8" fill="#eef0f3" stroke="#8b939f"/><rect x="26.8" y="10" width="2.4" height="8" rx="1.2" fill="#2a2e36"/></g>
      <text x="18" y="50" class="cs-tiny cs-light">G</text><text x="28" y="50" class="cs-tiny cs-light">S</text><text x="38" y="50" class="cs-tiny cs-light">V</text>`;
  },
};

DEFS.dht22 = {
  pulled: ['DATA'],
  type: 'dht22', name: 'DHT22 Temp & Humidity', category: 'Sensors', w: 40, h: 72,
  pins: [
    { id: 'VCC', label: 'VCC', x: 10, y: 72, dir: 'b' },
    { id: 'DATA', label: 'DATA', x: 20, y: 72, dir: 'b' },
    { id: 'GND', label: 'GND', x: 30, y: 72, dir: 'b' },
  ],
  props: { temp: 24, hum: 45 },
  controls: [
    { key: 'temp', label: 'Temperature', type: 'range', min: -40, max: 80, step: 0.1, fmt: (v) => `${(+v).toFixed(1)} °C` },
    { key: 'hum', label: 'Humidity', type: 'range', min: 0, max: 100, step: 0.5, fmt: (v) => `${(+v).toFixed(1)} %` },
  ],
  state: () => ({}),
  render(c) {
    let holes = '';
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) holes += `<rect x="${7 + k * 7}" y="${6 + r * 7}" width="4" height="4" rx="1" fill="#c4cad4"/>`;
    return `<path d="M10 54 V72 M20 54 V72 M30 54 V72" stroke="#a7adb7" stroke-width="2"/>
      <rect x="2" y="1" width="36" height="54" rx="4" fill="#f4f6f8" stroke="#b9c0ca"/>${holes}
      <text x="20" y="43" class="cs-tiny cs-dark">${(+c.props.temp).toFixed(1)}°C</text>
      <text x="20" y="51" class="cs-tiny cs-dark">${Math.round(c.props.hum)}%</text>`;
  },
};

DEFS.ldr = {
  type: 'ldr', name: 'Light Sensor (LDR)', category: 'Sensors', w: 44, h: 62,
  pins: [
    { id: 'VCC', label: 'VCC', x: 10, y: 62, dir: 'b' },
    { id: 'GND', label: 'GND', x: 22, y: 62, dir: 'b' },
    { id: 'AO', label: 'AO', x: 34, y: 62, dir: 'b', title: 'AO — analog output (brighter = higher)' },
  ],
  props: { light: 0.6 },
  controls: [{ key: 'light', label: 'Light level', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 1000)} lux` }],
  analog: { AO: (c) => +c.props.light },
  state: () => ({}),
  render(c) {
    const l = +c.props.light;
    return `<path d="M10 46 V62 M22 46 V62 M34 46 V62" stroke="#a7adb7" stroke-width="2"/>
      <rect x="1" y="1" width="42" height="46" rx="3" fill="#1f4fa3" stroke="#12336e"/>
      ${glow(22, 17, 16, '#ffe680', l * 0.55)}
      <circle cx="22" cy="17" r="11" fill="#e8a65a" stroke="#9c6526"/>
      <path d="M15 13 h4 v4 h4 v-4 h4 v4 h-4 v4 h-4 v-4 h-4" fill="none" stroke="#7a3d12" stroke-width="1.4"/>
      <text x="22" y="40" class="cs-tiny cs-light">LDR</text>`;
  },
};

DEFS.pir = {
  type: 'pir', name: 'PIR Motion Sensor', category: 'Sensors', w: 56, h: 66,
  pins: [
    { id: 'VCC', label: 'VCC', x: 14, y: 66, dir: 'b' },
    { id: 'OUT', label: 'OUT', x: 28, y: 66, dir: 'b', title: 'OUT — HIGH while motion is detected' },
    { id: 'GND', label: 'GND', x: 42, y: 66, dir: 'b' },
  ],
  props: { motion: false },
  controls: [{ key: 'motion', label: 'Motion detected', type: 'toggle' }],
  drive: { OUT: (c) => (c.props.motion ? 1 : 0) },
  state: () => ({}),
  render(c) {
    const m = !!c.props.motion;
    return `<path d="M14 50 V66 M28 50 V66 M42 50 V66" stroke="#a7adb7" stroke-width="2"/>
      <rect x="1" y="4" width="54" height="48" rx="3" fill="#2f7d3a" stroke="#1b4d22"/>
      <circle cx="28" cy="26" r="19" fill="#f3f4f0" stroke="#c9ccc2"/>
      <path d="M28 7 V45 M9 26 H47 M15 13 L41 39 M41 13 L15 39" stroke="#d9dbd2" stroke-width="1"/>
      ${glow(48, 9, 6, '#ff3344', m ? 0.8 : 0)}<circle cx="48" cy="9" r="2.5" fill="${m ? '#ff4455' : '#5a1a20'}"/>`;
  },
};

DEFS.buzzer = {
  type: 'buzzer', name: 'Piezo Buzzer', category: 'Output', w: 44, h: 62,
  pins: [{ id: '+', label: '+', x: 16, y: 62, dir: 'b' }, { id: '-', label: '−', x: 28, y: 62, dir: 'b' }],
  props: { muted: false },
  controls: [{ key: 'muted', label: 'Mute sound', type: 'toggle' }],
  state(c, sim) {
    let f = 0;
    for (const g of sim.pinGpios(c, '+')) if (sim.tone[g]) f = sim.tone[g];
    const k = sim.pinLevel(c, '-');
    return { f: k === 0 ? f : 0 };
  },
  render(c, s) {
    const on = s.f > 0;
    return `<path d="M16 42 V62 M28 42 V62" stroke="#a7adb7" stroke-width="2"/>
      <circle cx="22" cy="22" r="20" fill="#1c1e22" stroke="#000"/>
      <circle cx="22" cy="22" r="13" fill="none" stroke="#33363d" stroke-width="2"/>
      <circle cx="22" cy="22" r="3.5" fill="#000"/>
      <text x="9" y="14" class="cs-tiny cs-light">+</text>
      ${on ? `<path d="M46 12 a14 14 0 0 1 0 20 M51 7 a20 20 0 0 1 0 30" stroke="#ffd60a" stroke-width="2" fill="none" stroke-linecap="round" class="cs-pulse"/>
               <text x="22" y="-4" class="cs-part-lbl">${Math.round(s.f)} Hz</text>` : ''}`;
  },
};

DEFS.servo = {
  type: 'servo', name: 'Servo Motor', category: 'Output', w: 100, h: 56,
  pins: [
    { id: 'GND', label: 'GND', x: 0, y: 20, dir: 'l', title: 'GND (brown)' },
    { id: 'V+', label: 'V+', x: 0, y: 28, dir: 'l', title: 'V+ (red)' },
    { id: 'SIG', label: 'SIG', x: 0, y: 36, dir: 'l', title: 'PWM signal (orange)' },
  ],
  props: {},
  state(c, sim) {
    const u = sim.ui[c.id] || (sim.ui[c.id] = {});
    for (const g of sim.pinGpios(c, 'SIG')) if (sim.servo[g] != null) u.angle = sim.servo[g];
    if (u.angle == null || !sim.running) u.angle = sim.running ? (u.angle ?? 90) : 90;
    return { angle: u.angle };
  },
  render(c, s) {
    const a = s.angle - 90;
    return `<path d="M0 20 H18" stroke="#6b3e1f" stroke-width="3"/><path d="M0 28 H18" stroke="#d63b3b" stroke-width="3"/><path d="M0 36 H18" stroke="#f08a24" stroke-width="3"/>
      <rect x="16" y="2" width="8" height="52" rx="2" fill="#1b4fb0"/><rect x="92" y="2" width="8" height="52" rx="2" fill="#1b4fb0"/>
      <rect x="20" y="8" width="76" height="40" rx="3" fill="#2163d6" stroke="#123c86"/>
      <circle cx="44" cy="28" r="12" fill="#e9ecf1" stroke="#9aa3b0"/>
      <g transform="rotate(${a.toFixed(1)} 44 28)"><path d="M41 28 L44 2 L47 28 Z" fill="#fff" stroke="#9aa3b0"/><circle cx="44" cy="28" r="5" fill="#fff" stroke="#9aa3b0"/></g>
      <text x="74" y="31" class="cs-tiny cs-light">${Math.round(s.angle)}°</text>`;
  },
};

// ---------- Arduino Uno R3 (ATmega328P) ----------
const UNO_PWM = [3, 5, 6, 9, 10, 11];
function unoPin(id, x, y, dir) {
  const m = /^D(\d+)$/.exec(id) || /^A(\d)$/.exec(id);
  let gpio = null, kind = 'gpio', title;
  if (/^GND/.test(id)) { kind = 'gnd'; title = 'GND'; }
  else if (id === '5V' || id === '3V3' || id === 'VIN') { kind = 'vcc'; title = { '5V': '5 V supply (USB)', '3V3': '3.3 V supply (50 mA max)', VIN: 'VIN (barrel jack input)' }[id]; }
  else if (id === 'SDA' || id === 'SCL') { kind = 'alias'; title = `${id}: same pin as ${id === 'SDA' ? 'A4' : 'A5'} (I2C)`; }
  else if (!m) { kind = 'nc'; title = { AREF: 'AREF: ADC reference', IOREF: 'IOREF (5 V)', RESET: 'RESET (active low)' }[id]; }
  else {
    gpio = id[0] === 'A' ? 14 + +m[1] : +m[1];
    const f = [`digital pin ${gpio}`];
    if (id[0] === 'A') f.unshift(`analog input ${m[1]} (10-bit ADC)`);
    if (UNO_PWM.includes(gpio)) f.push(`PWM (Timer${gpio === 5 || gpio === 6 ? 0 : gpio === 9 || gpio === 10 ? 1 : 2})`);
    if (gpio === 0 || gpio === 1) f.push(gpio ? 'TX (USB serial)' : 'RX (USB serial)');
    if (gpio === 2 || gpio === 3) f.push(`interrupt INT${gpio - 2}`);
    if (gpio === 13) f.push('on-board LED "L"');
    if (gpio >= 10 && gpio <= 13) f.push(['SS', 'MOSI', 'MISO', 'SCK'][gpio - 10]);
    title = `${id}: ${f.join(', ')}`;
  }
  return { id, label: id.replace(/^GND\d/, 'GND'), x, y, dir, gpio, kind, title };
}
const UNO_TOP = ['SCL', 'SDA', 'AREF', 'GND1', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'];
const UNO_TOP2 = ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'];
const UNO_BOT = ['IOREF', 'RESET', '3V3', '5V', 'GND2', 'GND3', 'VIN'];
const UNO_BOT2 = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
const unoPins = [
  ...UNO_TOP.map((id, i) => unoPin(id, 40 + i * 12, 0, 't')), ...UNO_TOP2.map((id, i) => unoPin(id, 166 + i * 12, 0, 't')),
  ...UNO_BOT.map((id, i) => unoPin(id, 76 + i * 12, 180, 'b')), ...UNO_BOT2.map((id, i) => unoPin(id, 172 + i * 12, 180, 'b')),
];
DEFS.uno = {
  type: 'uno', name: 'Arduino Uno R3', category: 'Boards', w: 264, h: 180, fixed: true, board: true,
  props: { power: 'usb' },
  structural: ['power'],
  controls: [{ key: 'power', label: 'Powered by', type: 'select', options: ['usb', 'pins'], fmt: (v) => (v === 'pins' ? 'Its VIN / 5V pins (battery)' : 'USB') }],
  hint: 'Write its sketch in the editor and press Start: it runs with the Uno\'s rules (5 V pins, 10-bit analogRead, PWM on 3/5/6/9/10/11).',
  pins: unoPins,
  internal: () => [['GND1', 'GND2'], ['GND2', 'GND3'], ['A4', 'SDA'], ['A5', 'SCL']],
  state: (c, sim) => {
    const b = (sim.boardState && sim.boardState(c.id)) || sim;
    return { L: sim.running && b.out && b.out[13] ? 1 : 0, on: !!sim.running, tx: sim.running && sim.txAt && performance.now() - sim.txAt < 80 };
  },
  render(c, s) {
    let o = `<rect x="0" y="6" width="264" height="168" rx="6" fill="#0b6d8c" stroke="#064457" stroke-width="1.5"/>`;
    o += `<rect x="-14" y="32" width="46" height="36" rx="2" fill="#c9ced6" stroke="#8b929c"/><rect x="-10" y="40" width="20" height="20" fill="#9ea5af"/>`;
    o += `<rect x="-10" y="120" width="40" height="30" rx="3" fill="#1d1f24"/><circle cx="10" cy="135" r="6" fill="#3a3d44"/>`;
    o += `<rect x="34" y="-6" width="120" height="12" fill="#1d1f24"/><rect x="160" y="-6" width="96" height="12" fill="#1d1f24"/>`;
    o += `<rect x="70" y="174" width="84" height="12" fill="#1d1f24"/><rect x="166" y="174" width="72" height="12" fill="#1d1f24"/>`;
    o += `<rect x="120" y="96" width="132" height="34" rx="2" fill="#1d1f24" stroke="#0a0b0d"/><path d="M120 106 a6 6 0 0 1 0 14" fill="#33363d"/>`;
    o += `<text x="186" y="117" class="cs-tiny cs-light">ATmega328P</text>`;
    o += `<text x="90" y="74" class="cs-uno-title">UNO</text><text x="90" y="88" class="cs-tiny cs-light">R3 · 16 MHz</text>`;
    const led = (x, y, col, on, lbl) => `${glow(x, y, 7, col, on ? 0.75 : 0)}<rect x="${x - 4}" y="${y - 2}" width="8" height="4" rx="1" fill="${on ? col : '#2a3238'}"/><text x="${x + 10}" y="${y + 2}" class="cs-tiny cs-light" text-anchor="start">${lbl}</text>`;
    o += led(118, 30, '#ffb020', s.L, 'L') + led(118, 42, '#ffb020', s.tx, 'TX') + led(118, 54, '#ffb020', false, 'RX') + led(222, 150, '#22c55e', s.on, 'ON');
    const short = { IOREF: 'IO', RESET: 'RS', AREF: 'AR', GND: 'G', '3V3': '3V' };
    for (const p of unoPins) o += `<text x="${p.x}" y="${p.y === 0 ? 14 : 168}" class="cs-dip-pin" fill="#e6f3f7">${esc(short[p.label] || p.label)}</text>`;
    return o;
  },
};

// ---------- semiconductors ----------
// TO-92 package seen from the flat (marked) face; legs at the bottom.
function to92(c, s, mark, legs) {
  const on = s.on > 0.02;
  // TO-92: a 4.7 mm wide, 5 mm tall body; the leads are 1.27 mm apart
  return `<path d="M10 44 V62 M15 44 V62 M20 44 V62" stroke="#a7adb7" stroke-width="2"/>
    <path d="M5.75 42 V27 A9.25 9.25 0 0 1 24.25 27 V42 Z" fill="#23262d" stroke="#0c0d10"/>
    <rect x="8" y="26" width="14" height="10" rx="1.5" fill="#2d3139"/>
    <text x="15" y="31" class="cs-tiny cs-light">${mark}</text>
    ${legs.map((l, i) => `<text x="${10 + i * 5}" y="56" class="cs-tiny cs-dark">${l}</text>`).join('')}
    ${on ? `<circle cx="21" cy="22" r="2" fill="#22c55e" opacity="${Math.min(1, 0.4 + s.on).toFixed(2)}"/>` : ''}`;
}
const TRANSISTOR_HINT = 'Shows a green dot when it conducts. Base/gate needs a resistor from the GPIO.';
const spiceCtl = (accepts) => ({ key: 'spice', label: 'Custom SPICE model', type: 'spice', maxLength: 50000, accepts });

DEFS.npn = {
  type: 'npn', name: 'NPN Transistor (2N2222)', category: 'Semiconductors', w: 40, h: 62, hint: TRANSISTOR_HINT,
  pins: [
    { id: 'E', label: 'E', x: 10, y: 62, dir: 'b', title: 'Emitter' },
    { id: 'B', label: 'B', x: 15, y: 62, dir: 'b', title: 'Base (through a resistor, e.g. 1 kΩ)' },
    { id: 'C', label: 'C', x: 20, y: 62, dir: 'b', title: 'Collector' },
  ],
  props: { spice: '' }, controls: [spiceCtl('.model NAME NPN(IS=… BF=… VAF=…)')],
  state: (c, sim) => ({ on: (sim.analog && sim.analog.parts && sim.analog.parts[c.id]) || 0, label: 'NPN' }),
  render: (c, s) => to92(c, s, '2N2222', ['E', 'B', 'C']),
};

DEFS.pnp = {
  type: 'pnp', name: 'PNP Transistor (2N2907)', category: 'Semiconductors', w: 40, h: 62, hint: TRANSISTOR_HINT,
  pins: [
    { id: 'E', label: 'E', x: 10, y: 62, dir: 'b', title: 'Emitter (to the positive supply)' },
    { id: 'B', label: 'B', x: 15, y: 62, dir: 'b', title: 'Base (through a resistor)' },
    { id: 'C', label: 'C', x: 20, y: 62, dir: 'b', title: 'Collector' },
  ],
  props: { spice: '' }, controls: [spiceCtl('.model NAME PNP(IS=… BF=…)')],
  state: (c, sim) => ({ on: (sim.analog && sim.analog.parts && sim.analog.parts[c.id]) || 0, label: 'PNP' }),
  render: (c, s) => to92(c, s, '2N2907', ['E', 'B', 'C']),
};

DEFS.nmos = {
  type: 'nmos', name: 'N-MOSFET', category: 'Semiconductors', w: 40, h: 62,
  hint: '2N7000: threshold ≈ 2.1 V, up to ~200 mA (only partly on at 3.3 V). AO3400: logic-level, ≈ 1 V threshold, fully on at 3.3 V (≈ 45 mΩ), up to 5 A. Both have a body diode.',
  structural: ['model'],
  pins: [
    { id: 'S', label: 'S', x: 10, y: 62, dir: 'b', title: 'Source (to GND for a low-side switch)' },
    { id: 'G', label: 'G', x: 15, y: 62, dir: 'b', title: 'Gate' },
    { id: 'D', label: 'D', x: 20, y: 62, dir: 'b', title: 'Drain (to the load)' },
  ],
  props: { model: '2N7000', spice: '' }, controls: [{ key: 'model', label: 'Part', type: 'select', options: ['2N7000', 'AO3400'] }, spiceCtl('.model NAME NMOS(LEVEL=1 VTO=… KP=…), or a .subckt with pins D G S')],
  state: (c, sim) => ({ on: (sim.analog && sim.analog.parts && sim.analog.parts[c.id]) || 0, label: 'N-FET' }),
  render: (c, s) => to92(c, s, c.props.model === 'AO3400' ? 'AO3400' : '2N7000', ['S', 'G', 'D']),
};

const DIODE_TYPES = ['1N4148', '1N4007', '1N5819'];
DEFS.diode = {
  type: 'diode', name: 'Diode', category: 'Semiconductors', w: 70, h: 16,
  // DO-35: a 4 mm × 1.9 mm glass body, leads 10.16 mm apart
  pins: [{ id: 'A', label: 'A', x: 15, y: 8, dir: 'l', title: 'Anode' }, { id: 'K', label: 'K', x: 55, y: 8, dir: 'r', title: 'Cathode (striped end)' }],
  props: { model: '1N4148', spice: '' },
  controls: [{ key: 'model', label: 'Type', type: 'select', options: DIODE_TYPES }, spiceCtl('.model NAME D(IS=… N=… RS=…)')],
  render(c) {
    const big = c.props.model !== '1N4148';
    const body = big ? '#1d1f24' : '#c98a3a';
    return `<line x1="15" y1="8" x2="55" y2="8" stroke="#a7adb7" stroke-width="2"/>
      <rect x="27" y="${big ? 1 : 4.25}" width="16" height="${big ? 14 : 7.5}" rx="${big ? 3 : 3.75}" fill="${body}" stroke="rgba(0,0,0,.35)"/>
      <rect x="38.5" y="${big ? 1 : 4.25}" width="2.5" height="${big ? 14 : 7.5}" fill="${big ? '#cfd4dc' : '#222'}"/>
      <text x="35" y="-3" class="cs-part-lbl">${esc(c.props.model)}</text>`;
  },
};

DEFS.opamp = {
  type: 'opamp', name: 'Op-amp (LM358)', category: 'Semiconductors', w: 64, h: 60,
  hint: 'Single op-amp, DIP-8. Output swings from 0 V to about VCC − 1.5 V (not rail-to-rail).',
  pins: [
    { id: 'VCC', label: 'VCC', x: 8, y: 0, dir: 't', title: 'Pin 8: VCC (3–32 V)' },
    { id: 'OUT', label: 'OUT', x: 8, y: 60, dir: 'b', title: 'Pin 1: output' },
    { id: 'IN-', label: 'IN−', x: 24, y: 60, dir: 'b', title: 'Pin 2: inverting input' },
    { id: 'IN+', label: 'IN+', x: 40, y: 60, dir: 'b', title: 'Pin 3: non-inverting input' },
    { id: 'GND', label: 'GND', x: 56, y: 60, dir: 'b', title: 'Pin 4: GND' },
    ],
    props: { spice: '' }, controls: [spiceCtl('.subckt NAME +IN −IN VCC VEE OUT (standard op-amp pin order)')],
  render() {
    let legs = '';
    for (let i = 0; i < 4; i++) legs += `<rect x="${5 + i * 16}" y="44" width="6" height="16" fill="#b9bec7"/><rect x="${5 + i * 16}" y="0" width="6" height="16" fill="${i === 0 ? '#b9bec7' : '#8a8f98'}"/>`;
    return `${legs}<rect x="0" y="12" width="64" height="36" rx="3" fill="#1d1f24" stroke="#0a0b0d"/>
      <path d="M0 24 a6 6 0 0 1 0 12" fill="#33363d"/>
      <circle cx="9" cy="40" r="2" fill="#33363d"/>
      <text x="32" y="29" class="cs-tiny cs-light">LM358</text>
      <text x="32" y="39" class="cs-tiny cs-light">OUT − + G</text>`;
  },
};

// ---------- logic chips (DIP packages, real pinouts) ----------
// Top view, notch on the left: pins 1…n/2 along the bottom (left→right), n…n/2+1 along the top.
const DIP_PITCH = 16;
function dipPart(def) {
  const n = def.pins.length, half = n / 2, w = half * DIP_PITCH;
  const pins = def.pins.map((label, i) => {
    const bottom = i < half;
    const col = bottom ? i : n - 1 - i;
    return { id: label, label, x: 8 + col * DIP_PITCH, y: bottom ? 60 : 0, dir: bottom ? 'b' : 't', title: `Pin ${i + 1}: ${label}` };
  });
  const short = def.name.split(' ')[0];
  return {
    type: def.type, name: def.name, category: 'Logic', w, h: 60, pins, props: {}, dip: n, hint: def.hint, chip: { vcc: def.vcc, gnd: def.gnd },
    render() {
      let o = '';
      for (const p of pins) o += `<rect x="${p.x - 3}" y="${p.y === 0 ? 0 : 44}" width="6" height="16" fill="#b9bec7"/>`;
      o += `<rect x="0" y="12" width="${w}" height="36" rx="3" fill="#1d1f24" stroke="#0a0b0d"/><path d="M0 24 a6 6 0 0 1 0 12" fill="#33363d"/>`;
      for (const p of pins) o += `<text x="${p.x}" y="${p.y === 0 ? 20 : 45}" class="cs-dip-pin">${esc(p.label)}</text>`;
      o += `<text x="${w / 2}" y="34" class="cs-tiny cs-light">${esc(short)}</text>`;
      return o;
    },
  };
}
for (const def of Object.values(CHIPS)) if (!def.module) DEFS[def.type] = dipPart(def);

DEFS.capacitor = {
  type: 'capacitor', name: 'Capacitor', category: 'Passive', w: 30, h: 56,
  pins: [{ id: '+', label: '+', x: 10, y: 56, dir: 'b', title: '+ (longer leg; polarised electrolytic)' }, { id: '-', label: '−', x: 20, y: 56, dir: 'b', title: '− (striped side)' }],
  props: { value: '10µF' },
  controls: [{ key: 'value', label: 'Capacitance', type: 'select', options: ['100nF', '1µF', '10µF', '100µF', '470µF'] }],
  render(c) {
    const ceramic = c.props.value === '100nF';
    if (ceramic) {
      return `<path d="M10 30 V56 M20 30 V56" stroke="#a7adb7" stroke-width="2"/>
        <ellipse cx="15" cy="20" rx="10" ry="10" fill="#e1a93b" stroke="#a8761f"/>
        <text x="15" y="23" class="cs-tiny cs-dark">104</text><text x="15" y="-3" class="cs-part-lbl">100nF</text>`;
    }
    return `<path d="M10 45 V56 M20 45 V56" stroke="#a7adb7" stroke-width="2"/>
      <rect x="5" y="2" width="20" height="43" rx="4" fill="#2457b8" stroke="#16397a"/>
      <rect x="19" y="2" width="6" height="43" fill="#9db7e6"/><text x="22" y="16" class="cs-tiny cs-dark">−</text>
      <ellipse cx="15" cy="3" rx="10" ry="2" fill="#c3cad6"/>
      <text x="15" y="-3" class="cs-part-lbl">${esc(c.props.value)}</text>`;
  },
};

// ---------- electromechanical ----------
DEFS.motor = {
  type: 'motor', name: 'DC Motor', category: 'Electromechanical', w: 60, h: 72,
  hint: 'Toy motor: ~9500 rpm unloaded at 5 V, 0.5 A when stalled. Too much for a GPIO: drive it with a transistor or MOSFET and add a flyback diode.',
  pins: [{ id: '+', label: '+', x: 22, y: 72, dir: 'b', title: '+ terminal' }, { id: '-', label: '−', x: 38, y: 72, dir: 'b', title: '− terminal' }],
  props: {},
  state: (c, sim) => { const m = sim.analog && sim.analog.mech && sim.analog.mech.motors[c.id]; return { rpm: m ? m[0] : 0, angle: m ? m[1] : 0 }; },
  render(c, s) {
    const a = (s.angle * 180) / Math.PI;
    const rpm = Math.round(Math.abs(s.rpm));
    return `<path d="M22 54 V72 M38 54 V72" stroke="#a7adb7" stroke-width="2"/>
      <rect x="6" y="18" width="48" height="38" rx="5" fill="#c9ced6" stroke="#8b929c"/>
      <rect x="6" y="46" width="48" height="10" rx="2" fill="#2b2f37"/>
      <circle cx="30" cy="30" r="15" fill="#aeb4be" stroke="#7d8591"/>
      <g transform="rotate(${a.toFixed(1)} 30 30)"><rect x="28" y="12" width="4" height="36" rx="2" fill="#e5484d"/></g>
      <circle cx="30" cy="30" r="3" fill="#555c66"/>
      <text x="16" y="53" class="cs-tiny cs-light">+</text>
      ${rpm > 1 ? `<text x="30" y="8" class="cs-part-lbl">${rpm.toLocaleString()} rpm</text>` : ''}`;
  },
};

DEFS.relay = {
  optional: ['COM', 'NO', 'NC'],
  type: 'relay', name: '5 V Relay', category: 'Electromechanical', w: 66, h: 60,
  hint: 'Coil C1–C2 (70 Ω, pulls in above ~35 mA). COM connects to NC at rest and to NO when energised. Drive the coil with a transistor and a flyback diode.',
  pins: [
    { id: 'C1', label: 'C1', x: 8, y: 60, dir: 'b', title: 'Coil +' },
    { id: 'C2', label: 'C2', x: 20, y: 60, dir: 'b', title: 'Coil −' },
    { id: 'COM', label: 'COM', x: 34, y: 60, dir: 'b', title: 'Common contact' },
    { id: 'NO', label: 'NO', x: 46, y: 60, dir: 'b', title: 'Normally open (closed when energised)' },
    { id: 'NC', label: 'NC', x: 58, y: 60, dir: 'b', title: 'Normally closed (open when energised)' },
  ],
  props: {},
  state: (c, sim) => ({ on: !!(sim.analog && sim.analog.mech && sim.analog.mech.relays[c.id]) }),
  render(c, s) {
    const on = !!s.on;
    return `${[8, 20, 34, 46, 58].map((x) => `<path d="M${x} 46 V60" stroke="#a7adb7" stroke-width="2"/>`).join('')}
      <rect x="1" y="4" width="64" height="44" rx="3" fill="#2163d6" stroke="#123c86"/>
      <text x="33" y="17" class="cs-tiny cs-light">RELAY 5V</text>
      <path d="M8 40 V28 M20 40 V28" stroke="#9db7e6" stroke-width="1.4"/><rect x="5" y="24" width="18" height="8" rx="2" fill="none" stroke="#9db7e6"/>
      <circle cx="34" cy="38" r="2" fill="#fff"/><circle cx="46" cy="28" r="2" fill="#fff"/><circle cx="58" cy="28" r="2" fill="#fff"/>
      <path d="M34 38 L${on ? 46 : 58} 29" stroke="${on ? '#ffd60a' : '#fff'}" stroke-width="2" stroke-linecap="round"/>
      <text x="${on ? 46 : 58}" y="${on ? 22 : 22}" class="cs-tiny cs-light">${on ? 'NO' : 'NC'}</text>`;
  },
};

DEFS.lcd = {
  type: 'lcd', name: 'LCD 16×2 (I2C)', category: 'Output', w: 236, h: 86,
  pins: [
    { id: 'GND', label: 'GND', x: 0, y: 22, dir: 'l' },
    { id: 'VCC', label: 'VCC', x: 0, y: 34, dir: 'l' },
    { id: 'SDA', label: 'SDA', x: 0, y: 46, dir: 'l', title: 'SDA — I2C data (GPIO21 by default)' },
    { id: 'SCL', label: 'SCL', x: 0, y: 58, dir: 'l', title: 'SCL — I2C clock (GPIO22 by default)' },
  ],
  props: {},
  state(c, sim) {
    const lcd = sim.lcd;
    if (!lcd || !sim.running) return { lcd: null };
    const powered = sim.pinLevel(c, 'VCC') === 1 && sim.pinLevel(c, 'GND') === 0;
    const wired = sim.pinGpios(c, 'SDA').includes(sim.i2c.sda) && sim.pinGpios(c, 'SCL').includes(sim.i2c.scl);
    return { lcd: powered ? lcd : null, wired, powered };
  },
  render(c, s) {
    const L = s.lcd; const on = L && L.backlight;
    const bg = on ? '#9fd14a' : L ? '#4c6b22' : '#2f4416';
    const fg = on ? '#14240a' : '#0d1806';
    let rows = '';
    if (L && L.display && s.wired) {
      L.buf.forEach((row, r) => {
        const txt = row.join('').replace(/ /g, ' ');
        rows += `<text x="40" y="${42 + r * 22}" class="cs-lcd" fill="${fg}" textLength="176" lengthAdjust="spacing">${esc(txt)}</text>`;
      });
    }
    let cells = '';
    for (let r = 0; r < 2; r++) for (let k = 0; k < 16; k++) cells += `<rect x="${40 + k * 11}" y="${26 + r * 22}" width="9.5" height="17" fill="${fg}" opacity="${on ? 0.06 : 0.12}"/>`;
    return `<path d="M0 22 H16 M0 34 H16 M0 46 H16 M0 58 H16" stroke="#a7adb7" stroke-width="2"/>
      <rect x="14" y="0" width="222" height="86" rx="4" fill="#1f6a35" stroke="#123f20"/>
      <circle cx="24" cy="8" r="3" fill="#0f3a1b"/><circle cx="226" cy="8" r="3" fill="#0f3a1b"/><circle cx="24" cy="78" r="3" fill="#0f3a1b"/><circle cx="226" cy="78" r="3" fill="#0f3a1b"/>
      <rect x="30" y="14" width="196" height="58" rx="3" fill="#111"/>
      <rect x="34" y="18" width="188" height="50" rx="2" fill="${bg}"/>${cells}${rows}
      <text x="22" y="24.5" class="cs-tiny cs-light" text-anchor="start">G</text><text x="22" y="36.5" class="cs-tiny cs-light" text-anchor="start">V</text>
      <text x="20" y="48.5" class="cs-tiny cs-light" text-anchor="start">SD</text><text x="20" y="60.5" class="cs-tiny cs-light" text-anchor="start">SC</text>`;
  },
};

Object.assign(DEFS, LIB_PARTS, BASIC_PARTS);
applyRealSizes(DEFS);

// Boards running from a battery show when they have no power (the sketch is stopped).
for (const d of [DEFS.esp32, DEFS.uno]) {
  const st = d.state, r = d.render;
  d.state = (c, sim) => ({ ...st(c, sim), off: !!(((sim.boardState && sim.boardState(c.id)) || sim).halted) });
  d.render = (c, s) => r(c, s) + (s.off ? `<rect x="0" y="0" width="${d.w}" height="${d.h}" rx="6" fill="#000" opacity=".5"/><text x="${d.w / 2}" y="${d.h / 2}" class="cs-part-lbl" fill="#fca5a5">no power</text>` : '');
}

const PALETTE = [
  { cat: 'Boards', types: ['esp32', 'esp32c3', 'uno'] }, // picking one switches the project's board
  { cat: 'Output', types: ['led', 'rgb_led', 'seg7', 'buzzer', 'servo', 'lcd', 'lcd_parallel', 'oled', 'tm1637', 'ws2812_strip', 'ws2812_ring'] },
  { cat: 'Input', types: ['button', 'slide_switch', 'pot', 'joystick', 'encoder', 'keypad', 'ir_remote'] },
  { cat: 'Sensors', types: ['dht22', 'ldr', 'pir', 'fsr', 'sound', 'soil', 'mq2', 'bme280', 'mpu6050', 'ds18b20', 'hcsr04', 'ds3231', 'ir_receiver'] },
  { cat: 'Power', types: ['battery', 'tp4056', 'buckboost'] },
  { cat: 'Semiconductors', types: ['npn', 'pnp', 'nmos', 'diode', 'opamp'] },
  { cat: 'Electromechanical', types: ['motor', 'vibmotor', 'relay', 'stepper', 'l298n'] },
  { cat: 'Logic', types: Object.keys(CHIPS).filter((k) => !CHIPS[k].module) },
  { cat: 'Passive', types: ['resistor', 'capacitor', 'breadboard'] },
];
const ESP = { ADC1, ADC2, TOUCH };

export { DEFS, LED_COLORS, PALETTE, ESP, BTN_COLORS };
