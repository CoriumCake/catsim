/* CatSim — part definitions.
 * Every part: { type, name, category, w, h, pins[], props{}, controls[], render(c, s), state(c, sim), ... }
 * Pin coordinates are local to the part; `dir` is the direction a wire leaves the pin (l/r/t/b). */
import { OUTPUT } from './pins.js';
import { esc, clamp } from './util.ts';
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
  type: 'esp32', name: 'ESP32 DevKit V1', category: 'Boards', w: ESP_W, h: 274, fixed: true,
  pins: espPins, props: {},
  internal: () => [['GND.L', 'GND.R']],
  state(c, sim) {
    const on = sim.mode[2] === OUTPUT ? (sim.pwm[2] ?? (sim.out[2] ? 1 : 0)) : 0;
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
    if (sim.running && sim.analog && sim.analog.leds) return { b: sim.analog.leds[c.id] ?? 0 };
    const a = sim.pinLevel(c, 'A'); const k = sim.pinLevel(c, 'C');
    return { b: a != null && k != null ? clamp(a - k, 0, 1) : 0 };
  },
  render(c, s) {
    const col = LED_COLORS[c.props.color] || LED_COLORS.red; const b = s.b || 0;
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
  pins: [{ id: '1', label: '1', x: 0, y: 8, dir: 'l' }, { id: '2', label: '2', x: 70, y: 8, dir: 'r' }],
  props: { ohms: 220 },
  controls: [{ key: 'ohms', label: 'Resistance (Ω)', type: 'select', options: ['100', '220', '330', '1000', '4700', '10000', '100000'] }],
  internal: () => [['1', '2']],
  state: () => ({}),
  render(c) {
    const b = resistorBands(c.props.ohms);
    return `<line x1="0" y1="8" x2="70" y2="8" stroke="#a7adb7" stroke-width="2"/>
      <rect x="17" y="2" width="36" height="12" rx="5" fill="#d9c49a" stroke="#9b8558"/>
      <rect x="22" y="2" width="3" height="12" fill="${b[0]}"/><rect x="29" y="2" width="3" height="12" fill="${b[1]}"/>
      <rect x="36" y="2" width="3" height="12" fill="${b[2]}"/><rect x="46" y="2" width="3" height="12" fill="${b[3]}"/>
      <text x="35" y="-3" class="cs-part-lbl">${fmtOhms(+c.props.ohms)}</text>`;
  },
};

const BTN_COLORS = { red: '#e5484d', blue: '#3d8bff', green: '#2fbf71', yellow: '#f5c518', black: '#30343c' };
DEFS.button = {
  type: 'button', name: 'Push Button', category: 'Input', w: 44, h: 54, interactive: 'press',
  pins: [{ id: '1', label: '1', x: 12, y: 54, dir: 'b' }, { id: '2', label: '2', x: 32, y: 54, dir: 'b' }],
  props: { color: 'red' },
  controls: [{ key: 'color', label: 'Cap color', type: 'select', options: Object.keys(BTN_COLORS) }],
  hint: 'Press with the mouse while the simulation runs',
  internal: (c, sim) => (sim.ui[c.id] && sim.ui[c.id].pressed ? [['1', '2']] : []),
  state: (c, sim) => ({ pressed: !!(sim.ui[c.id] && sim.ui[c.id].pressed) }),
  render(c, s) {
    const col = BTN_COLORS[c.props.color] || BTN_COLORS.red;
    return `<path d="M12 40 V54 M32 40 V54" stroke="#a7adb7" stroke-width="2"/>
      <rect x="4" y="4" width="36" height="36" rx="3" fill="#2a2e36" stroke="#14161b"/>
      <circle cx="8" cy="8" r="1.6" fill="#555"/><circle cx="36" cy="8" r="1.6" fill="#555"/><circle cx="8" cy="36" r="1.6" fill="#555"/><circle cx="36" cy="36" r="1.6" fill="#555"/>
      <circle cx="22" cy="22" r="${s.pressed ? 10.5 : 12}" fill="${col}" stroke="rgba(0,0,0,.4)" stroke-width="${s.pressed ? 3 : 1}"/>
      ${s.pressed ? '' : '<circle cx="18" cy="18" r="4" fill="#fff" opacity=".25"/>'}`;
  },
};

DEFS.pot = {
  type: 'pot', name: 'Potentiometer', category: 'Input', w: 56, h: 60,
  pins: [
    { id: 'GND', label: 'GND', x: 12, y: 60, dir: 'b' },
    { id: 'SIG', label: 'SIG', x: 28, y: 60, dir: 'b', title: 'SIG — wiper output (analog)' },
    { id: 'VCC', label: 'VCC', x: 44, y: 60, dir: 'b' },
  ],
  props: { value: 0.5 },
  controls: [{ key: 'value', label: 'Position', type: 'range', min: 0, max: 1, step: 0.001, fmt: (v) => `${Math.round(v * 100)}%` }],
  analog: { SIG: (c) => +c.props.value },
  state: () => ({}),
  render(c) {
    const a = -135 + 270 * (+c.props.value);
    return `<path d="M12 44 V60 M28 44 V60 M44 44 V60" stroke="#a7adb7" stroke-width="2"/>
      <rect x="2" y="2" width="52" height="44" rx="4" fill="#1e5bb8" stroke="#123a78"/>
      <circle cx="28" cy="23" r="16" fill="#d7dbe2" stroke="#8b939f"/>
      <g transform="rotate(${a.toFixed(1)} 28 23)"><circle cx="28" cy="23" r="10" fill="#eef0f3"/><rect x="26.5" y="8" width="3" height="11" rx="1.5" fill="#2a2e36"/></g>
      <text x="12" y="44" class="cs-tiny cs-light">G</text><text x="28" y="44" class="cs-tiny cs-light">S</text><text x="44" y="44" class="cs-tiny cs-light">V</text>`;
  },
};

DEFS.dht22 = {
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
  props: {},
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

const PALETTE = [
  { cat: 'Output', types: ['led', 'buzzer', 'servo', 'lcd'] },
  { cat: 'Input', types: ['button', 'pot'] },
  { cat: 'Sensors', types: ['dht22', 'ldr', 'pir'] },
  { cat: 'Passive', types: ['resistor'] },
];
const ESP = { ADC1, ADC2, TOUCH };

export { DEFS, LED_COLORS, PALETTE, ESP, BTN_COLORS };
