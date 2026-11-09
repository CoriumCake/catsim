/* CatSim — parts driven by Arduino libraries: OLED, NeoPixel strip/ring, TM1637, DS18B20, HC-SR04,
 * DS3231, 4×4 keypad, IR receiver + remote, 28BYJ-48 stepper. Their live state comes from sim.dev
 * (written by the library in the worker) or from sim.ui (keys pressed with the mouse). */
import { esc } from './util.ts';

const lead = (pts) => `<path d="${pts}" stroke="#a7adb7" stroke-width="2" fill="none"/>`;
const dev = (sim, c, kind) => { const d = sim.running && sim.dev ? sim.dev[c.id] : null; return d && d.kind === kind ? d : null; };
const glow = (cx, cy, r, color, o) => (o > 0.02 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${o.toFixed(2)}" filter="url(#cs-blur)"/>` : '');
const hex = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

// ---------- OLED 128×64 (SSD1306, I2C) ----------
const OLED_COLORS = { white: ['#e9f3ff', '#e9f3ff'], blue: ['#5ec8ff', '#5ec8ff'], 'yellow + blue': ['#ffd84a', '#5ec8ff'] };
/** Lit pixels of an SSD1306 buffer as one path of horizontal runs (rows [y0, y1)). */
export function oledPath(d, y0 = 0, y1 = d.h, ox = 0, oy = 0) {
  let p = '';
  for (let y = y0; y < y1; y++) {
    let run = -1;
    for (let x = 0; x <= d.w; x++) {
      const on = x < d.w && !!(d.buf[x + (y >> 3) * d.w] & (1 << (y & 7))) !== d.invert;
      if (on && run < 0) run = x;
      else if (!on && run >= 0) { p += `M${ox + run} ${oy + y}h${x - run}v1h${run - x}z`; run = -1; }
    }
  }
  return p;
}
const oled = {
  type: 'oled', name: 'OLED 128×64 (SSD1306, I2C)', category: 'Output', w: 140, h: 100,
  pins: [
    { id: 'GND', label: 'GND', x: 52, y: 0, dir: 't' },
    { id: 'VCC', label: 'VCC', x: 64, y: 0, dir: 't', title: 'VCC — 3.3 V or 5 V' },
    { id: 'SCL', label: 'SCL', x: 76, y: 0, dir: 't', title: 'SCL — I2C clock (GPIO22 on the ESP32, A5 on the Uno)' },
    { id: 'SDA', label: 'SDA', x: 88, y: 0, dir: 't', title: 'SDA — I2C data (GPIO21 on the ESP32, A4 on the Uno)' },
  ],
  props: { addr: '0x3C', color: 'white' },
  controls: [
    { key: 'addr', label: 'I2C address', type: 'select', options: ['0x3C', '0x3D'] },
    { key: 'color', label: 'Pixel color', type: 'select', options: Object.keys(OLED_COLORS) },
  ],
  hint: 'Adafruit_SSD1306 + Adafruit_GFX. Wire SDA/SCL to the board\'s I2C pins and call display.display() to show the buffer.',
  state: (c, sim) => ({ d: dev(sim, c, 'oled') }),
  render(c, s) {
    const d = s.d; const [top, bottom] = OLED_COLORS[c.props.color] || OLED_COLORS.white;
    let px = '';
    if (d && d.on) {
      const op = d.dim ? 0.55 : 1;
      if (top === bottom) px = `<path d="${oledPath(d, 0, d.h, 6, 26)}" fill="${top}" opacity="${op}"/>`;
      else px = `<path d="${oledPath(d, 0, Math.min(16, d.h), 6, 26)}" fill="${top}" opacity="${op}"/><path d="${oledPath(d, 16, d.h, 6, 26)}" fill="${bottom}" opacity="${op}"/>`;
    }
    return `<rect x="1" y="1" width="138" height="98" rx="5" fill="#1d3f8f" stroke="#10275c"/>
      <circle cx="9" cy="9" r="3.5" fill="#0d1f4a"/><circle cx="131" cy="9" r="3.5" fill="#0d1f4a"/><circle cx="9" cy="91" r="3.5" fill="#0d1f4a"/><circle cx="131" cy="91" r="3.5" fill="#0d1f4a"/>
      <text x="52" y="13" class="cs-tiny cs-light">G</text><text x="64" y="13" class="cs-tiny cs-light">V</text><text x="76" y="13" class="cs-tiny cs-light">SC</text><text x="88" y="13" class="cs-tiny cs-light">SD</text>
      <rect x="3" y="22" width="134" height="72" rx="2" fill="#05070b"/>${px}`;
  },
};

// ---------- WS2812B strip (8) and ring (16) ----------
const pixelsState = (c, sim) => { const d = dev(sim, c, 'pixels'); return { rgb: d ? d.rgb : null }; };
/** One WS2812B: its hue at full strength, as bright as the value sent (a dim LED is a faint tint, not a dark dot). */
const pixel = (x, y, rgb) => {
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255, m = Math.max(r, g, b);
  const k = m ? 255 / m : 0, col = `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  const o = m ? Math.min(1, 0.25 + Math.sqrt(m / 255) * 0.75) : 0;
  return `${glow(x, y, 9, col, m ? o * 0.85 : 0)}<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2" fill="#f7f7f2" stroke="#c9c9bf"/>`
    + `<circle cx="${x}" cy="${y}" r="4.2" fill="#e3e3da"/>${m ? `<circle cx="${x}" cy="${y}" r="4.2" fill="${col}" opacity="${o.toFixed(2)}"/>` : ''}`;
};
const strip = {
  type: 'ws2812_strip', name: 'NeoPixel Strip (8× WS2812B)', category: 'Output', w: 176, h: 40,
  pins: [
    { id: 'VCC', label: '5V', x: 0, y: 8, dir: 'l', title: 'VCC — 5 V supply' },
    { id: 'DIN', label: 'DIN', x: 0, y: 20, dir: 'l', title: 'DIN — data in (any GPIO)' },
    { id: 'GND', label: 'GND', x: 0, y: 32, dir: 'l' },
  ],
  props: {},
  hint: 'Adafruit_NeoPixel or FastLED. Real WS2812B LEDs read colors in GRB order: use NEO_GRB / GRB in the sketch.',
  state: pixelsState,
  render(c, s) {
    let leds = '';
    for (let i = 0; i < 8; i++) leds += pixel(30 + i * 20, 20, s.rgb ? s.rgb[i] : 0);
    return `${lead('M0 8 H12 M0 20 H12 M0 32 H12')}<rect x="10" y="4" width="164" height="32" rx="3" fill="#1b1d22" stroke="#000"/>${leds}
      <text x="15" y="10" class="cs-tiny cs-light">+</text><text x="15" y="35" class="cs-tiny cs-light">−</text>`;
  },
};
const ring = {
  type: 'ws2812_ring', name: 'NeoPixel Ring (16× WS2812B)', category: 'Output', w: 110, h: 120,
  pins: [
    { id: 'VCC', label: '5V', x: 40, y: 120, dir: 'b', title: 'VCC — 5 V supply' },
    { id: 'DIN', label: 'DIN', x: 55, y: 120, dir: 'b', title: 'DIN — data in (any GPIO)' },
    { id: 'GND', label: 'GND', x: 70, y: 120, dir: 'b' },
  ],
  props: {},
  hint: 'Adafruit_NeoPixel or FastLED, 16 pixels. Pixel 0 is at the top; the order runs clockwise.',
  state: pixelsState,
  render(c, s) {
    let leds = '';
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2 - Math.PI / 2; leds += pixel(55 + Math.cos(a) * 41, 55 + Math.sin(a) * 41, s.rgb ? s.rgb[i] : 0); }
    return `${lead('M40 104 V120 M55 104 V120 M70 104 V120')}<circle cx="55" cy="55" r="53" fill="#1b1d22" stroke="#000"/><circle cx="55" cy="55" r="30" fill="#f6f7f9" stroke="#000"/>${leds}`;
  },
};

// ---------- TM1637 4-digit 7-segment display ----------
/** Segment polygons of one digit at (x, y): a–g in bit order. */
const T7 = 3.2;
const hSeg = (x1, x2, y) => `M${x1} ${y}l${T7 / 2} ${-T7 / 2}H${x2 - T7 / 2}l${T7 / 2} ${T7 / 2}l${-T7 / 2} ${T7 / 2}H${x1 + T7 / 2}z`;
const vSeg = (x, y1, y2) => `M${x} ${y1}l${T7 / 2} ${T7 / 2}V${y2 - T7 / 2}l${-T7 / 2} ${T7 / 2}l${-T7 / 2} ${-T7 / 2}V${y1 + T7 / 2}z`;
const SEGS = [hSeg(2.6, 15.4, 1.6), vSeg(16, 2.4, 14.6), vSeg(16, 15.4, 27.6), hSeg(2.6, 15.4, 28.4), vSeg(2, 15.4, 27.6), vSeg(2, 2.4, 14.6), hSeg(2.6, 15.4, 15)];
const tm1637 = {
  type: 'tm1637', name: '4-Digit Display (TM1637)', category: 'Output', w: 150, h: 60,
  pins: [
    { id: 'CLK', label: 'CLK', x: 150, y: 12, dir: 'r', title: 'CLK — clock (any GPIO)' },
    { id: 'DIO', label: 'DIO', x: 150, y: 24, dir: 'r', title: 'DIO — data (any GPIO)' },
    { id: 'VCC', label: 'VCC', x: 150, y: 36, dir: 'r', title: 'VCC — 3.3 V to 5 V' },
    { id: 'GND', label: 'GND', x: 150, y: 48, dir: 'r' },
  ],
  props: {},
  hint: 'TM1637Display(CLK, DIO). showNumberDecEx(n, 0b01000000) lights the colon.',
  state: (c, sim) => ({ d: dev(sim, c, 'seg7') }),
  render(c, s) {
    const d = s.d && s.d.on ? s.d : null; const k = d ? 0.45 + (d.bright / 7) * 0.55 : 0;
    let digits = '';
    for (let i = 0; i < 4; i++) {
      const x = 12 + i * 29 + (i >= 2 ? 8 : 0), y = 14, v = d ? d.segs[i] : 0;
      digits += `<g transform="translate(${x} ${y})">${SEGS.map((p, b) => `<path d="${p}" fill="${v & (1 << b) ? '#ff3b30' : '#3a1414'}" opacity="${v & (1 << b) ? k : 1}"/>`).join('')}</g>`;
    }
    const colon = d && d.segs[1] & 0x80;
    return `${lead('M138 12 H150 M138 24 H150 M138 36 H150 M138 48 H150')}<rect x="1" y="1" width="138" height="58" rx="3" fill="#1d3f8f" stroke="#10275c"/>
      <rect x="6" y="8" width="126" height="44" rx="2" fill="#141414"/>${digits}
      <circle cx="73" cy="23" r="2" fill="${colon ? '#ff3b30' : '#3a1414'}"/><circle cx="73" cy="37" r="2" fill="${colon ? '#ff3b30' : '#3a1414'}"/>`;
  },
};

// ---------- DS18B20 (TO-92) ----------
const ds18b20 = {
  type: 'ds18b20', name: 'DS18B20 Temperature (1-Wire)', category: 'Sensors', w: 40, h: 62,
  pins: [
    { id: 'GND', label: 'GND', x: 10, y: 62, dir: 'b', title: 'GND (left leg, flat side facing you)' },
    { id: 'DQ', label: 'DQ', x: 20, y: 62, dir: 'b', title: 'DQ — 1-Wire data; needs a 4.7 kΩ pull-up to VDD' },
    { id: 'VDD', label: 'VDD', x: 30, y: 62, dir: 'b', title: 'VDD — 3.0 to 5.5 V' },
  ],
  props: { temp: 22 },
  controls: [{ key: 'temp', label: 'Temperature', type: 'range', min: -55, max: 125, step: 0.5, fmt: (v) => `${(+v).toFixed(1)} °C` }],
  hint: 'OneWire + DallasTemperature. Put a 4.7 kΩ resistor between DQ and VDD. Several sensors can share one pin.',
  state: () => ({}),
  render(c) {
    return `${lead('M10 34 V62 M20 34 V62 M30 34 V62')}<path d="M6 34 V14 A14 14 0 0 1 34 14 V34 Z" fill="#222" stroke="#000"/>
      <text x="20" y="22" class="cs-tiny cs-light">18B20</text><text x="20" y="31" class="cs-tiny cs-light">${(+c.props.temp).toFixed(1)}°</text>`;
  },
};

// ---------- HC-SR04 ultrasonic ----------
const hcsr04 = {
  type: 'hcsr04', name: 'Ultrasonic Distance (HC-SR04)', category: 'Sensors', w: 110, h: 64,
  pins: [
    { id: 'VCC', label: 'VCC', x: 40, y: 64, dir: 'b', title: 'VCC — 5 V' },
    { id: 'TRIG', label: 'TRIG', x: 50, y: 64, dir: 'b', title: 'TRIG — a 10 µs HIGH pulse starts a measurement' },
    { id: 'ECHO', label: 'ECHO', x: 60, y: 64, dir: 'b', title: 'ECHO — HIGH for the sound\'s round trip (5 V: use a divider on an ESP32)' },
    { id: 'GND', label: 'GND', x: 70, y: 64, dir: 'b' },
  ],
  props: { distance: 100 },
  controls: [{ key: 'distance', label: 'Distance to object', type: 'range', min: 1, max: 450, step: 1, fmt: (v) => (+v > 400 ? `${v} cm (out of range)` : `${v} cm`) }],
  hint: 'NewPing, or pulseIn(ECHO, HIGH) after a 10 µs TRIG pulse: distance (cm) ≈ µs / 58. Range 2–400 cm.',
  state: () => ({}),
  render(c) {
    const eye = (x) => `<circle cx="${x}" cy="28" r="20" fill="#c8ccd2" stroke="#8a9099"/><circle cx="${x}" cy="28" r="15" fill="#2c2f35"/><circle cx="${x}" cy="28" r="12" fill="#55595f" stroke="#444"/>`;
    return `${lead('M40 52 V64 M50 52 V64 M60 52 V64 M70 52 V64')}<rect x="1" y="2" width="108" height="52" rx="3" fill="#1d5fb5" stroke="#123c78"/>${eye(25)}${eye(85)}
      <rect x="47" y="8" width="16" height="9" rx="1" fill="#d8d8d8"/><text x="55" y="48" class="cs-tiny cs-light">${Math.round(c.props.distance)} cm</text>`;
  },
};

// ---------- DS3231 RTC (ZS-042 board) ----------
const ds3231 = {
  optional: ['32K', 'SQW'],
  type: 'ds3231', name: 'Real-Time Clock (DS3231)', category: 'Sensors', w: 100, h: 84,
  pins: [
    { id: '32K', label: '32K', x: 0, y: 12, dir: 'l', title: '32K — 32.768 kHz output (not simulated)' },
    { id: 'SQW', label: 'SQW', x: 0, y: 24, dir: 'l', title: 'SQW — square wave / alarm output (not simulated)' },
    { id: 'SCL', label: 'SCL', x: 0, y: 36, dir: 'l', title: 'SCL — I2C clock' },
    { id: 'SDA', label: 'SDA', x: 0, y: 48, dir: 'l', title: 'SDA — I2C data' },
    { id: 'VCC', label: 'VCC', x: 0, y: 60, dir: 'l', title: 'VCC — 3.3 V or 5 V' },
    { id: 'GND', label: 'GND', x: 0, y: 72, dir: 'l' },
  ],
  props: { temp: 25 },
  controls: [{ key: 'temp', label: 'Chip temperature', type: 'range', min: -40, max: 85, step: 0.25, fmt: (v) => `${(+v).toFixed(2)} °C` }],
  hint: 'RTClib (RTC_DS3231). It starts at your computer\'s time; rtc.adjust() sets it, and it keeps time across restarts (it has a coin cell).',
  state: () => ({}),
  render() {
    return `<rect x="1" y="2" width="98" height="80" rx="3" fill="#1d3f8f" stroke="#10275c"/>
      <circle cx="62" cy="42" r="24" fill="#c9ced6" stroke="#8f96a1"/><circle cx="62" cy="42" r="19" fill="#dfe3e8"/><text x="62" y="45" class="cs-tiny cs-dark">CR2032</text>
      <rect x="34" y="66" width="20" height="13" rx="1" fill="#111"/><text x="44" y="74.5" class="cs-tiny cs-light">3231</text>
      ${['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'].map((l, i) => `<text x="17" y="${14.3 + i * 12}" class="cs-tiny cs-light">${l}</text>`).join('')}`;
  },
};

// ---------- 4×4 membrane keypad ----------
export const KEYPAD_LABELS = [['1', '2', '3', 'A'], ['4', '5', '6', 'B'], ['7', '8', '9', 'C'], ['*', '0', '#', 'D']];
const keypad = {
  optional: true,
  type: 'keypad', name: 'Keypad 4×4', category: 'Input', w: 150, h: 196, interactive: 'keys',
  pins: [...[1, 2, 3, 4].map((n, i) => ({ id: 'R' + n, label: 'R' + n, x: 26 + i * 14, y: 196, dir: 'b', title: `Row ${n}` })),
    ...[1, 2, 3, 4].map((n, i) => ({ id: 'C' + n, label: 'C' + n, x: 82 + i * 14, y: 196, dir: 'b', title: `Column ${n}` }))],
  props: {},
  hint: 'Keypad library: rowPins go to R1–R4, colPins to C1–C4. Click the keys while the simulation runs.',
  keyAt(c, x, y) { const k = Math.floor((x - 9) / 33), r = Math.floor((y - 9) / 33); return r >= 0 && r < 4 && k >= 0 && k < 4 && (x - 9) % 33 < 30 && (y - 9) % 33 < 30 ? `${r},${k}` : null; },
  internal(c, sim) { const u = sim.ui[c.id]; if (!u || !u.pressed || !u.key) return []; const [r, k] = String(u.key).split(',').map(Number); return [['R' + (r + 1), 'C' + (k + 1)]]; },
  state: (c, sim) => { const u = sim.ui && sim.ui[c.id]; return { key: u && u.pressed ? u.key : null }; },
  render(c, s) {
    let keys = '';
    KEYPAD_LABELS.forEach((row, r) => row.forEach((l, k) => {
      const on = s.key === `${r},${k}`; const x = 9 + k * 33, y = 9 + r * 33; const blue = k === 3 || l === '*' || l === '#';
      keys += `<rect x="${x}" y="${y}" width="30" height="30" rx="4" fill="${on ? '#9fb3c8' : blue ? '#2f64c9' : '#e8ebef'}" stroke="#8b95a3"/><text x="${x + 15}" y="${y + 19}" class="cs-key" fill="${blue ? '#fff' : '#222'}">${esc(l)}</text>`;
    }));
    return `<rect x="1" y="1" width="148" height="142" rx="5" fill="#20242b" stroke="#000"/>${keys}
      <path d="M20 143 H130 V170 H20 Z" fill="#c9a24a" opacity=".85"/>${lead(Array.from({ length: 8 }, (_, i) => `M${i < 4 ? 26 + i * 14 : 82 + (i - 4) * 14} 170 V196`).join(' '))}`;
  },
};

// ---------- IR receiver + remote ----------
const irReceiver = {
  type: 'ir_receiver', name: 'IR Receiver (VS1838B)', category: 'Sensors', w: 40, h: 56,
  pins: [
    { id: 'OUT', label: 'OUT', x: 10, y: 56, dir: 'b', title: 'OUT — demodulated signal (LOW while receiving)' },
    { id: 'GND', label: 'GND', x: 20, y: 56, dir: 'b' },
    { id: 'VCC', label: 'VCC', x: 30, y: 56, dir: 'b', title: 'VCC — 2.7 to 5.5 V' },
  ],
  props: {},
  drive: { OUT: () => 1 }, // idle HIGH
  hint: 'IRremote: IrReceiver.begin(pin) and IrReceiver.decode(). Press the keys of an IR Remote part to send codes.',
  state: (c, sim) => {
    const r = sim.app && sim.app.project.components.find((x) => x.type === 'ir_remote' && sim.ui && sim.ui[x.id] && sim.ui[x.id].pressed);
    return { rx: !!r && sim.running };
  },
  render(c, s) {
    return `${lead('M10 30 V56 M20 30 V56 M30 30 V56')}<rect x="4" y="8" width="32" height="24" rx="3" fill="#1b1b1f" stroke="#000"/>
      <circle cx="20" cy="17" r="8" fill="#2b2b33" stroke="#000"/>${s.rx ? '<path d="M28 2 l6 -4 M33 6 l7 -2" stroke="#ff5050" stroke-width="2" class="cs-pulse"/>' : ''}`;
  },
};
export const IR_LAYOUT = [['ch-', 'ch', 'ch+'], ['prev', 'next', 'play'], ['vol-', 'vol+', 'eq'], ['0', '100+', '200+'], ['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];
const IR_LABEL = { 'ch-': 'CH−', ch: 'CH', 'ch+': 'CH+', prev: '⏮', next: '⏭', play: '⏯', 'vol-': '−', 'vol+': '+', eq: 'EQ' };
const irRemote = {
  type: 'ir_remote', name: 'IR Remote (NEC, 21 keys)', category: 'Input', w: 84, h: 200, interactive: 'keys',
  pins: [],
  props: {},
  hint: 'Click its keys while the simulation runs: every powered IR receiver gets the NEC code (address 0x00, e.g. CH− = command 0x45).',
  keyAt(c, x, y) { const k = Math.floor((x - 8) / 24), r = Math.floor((y - 26) / 24); return r >= 0 && r < 7 && k >= 0 && k < 3 && (x - 8) % 24 < 20 && (y - 26) % 24 < 20 ? IR_LAYOUT[r][k] : null; },
  state: (c, sim) => { const u = sim.ui && sim.ui[c.id]; return { key: u && u.pressed ? u.key : null }; },
  render(c, s) {
    let keys = '';
    IR_LAYOUT.forEach((row, r) => row.forEach((k, i) => {
      const x = 8 + i * 24, y = 26 + r * 24, on = s.key === k; const top = r < 3;
      keys += `<circle cx="${x + 10}" cy="${y + 10}" r="10" fill="${on ? '#8a93a3' : top ? (r === 0 ? '#d23c3c' : '#3a3f48') : '#eceff3'}" stroke="#000" stroke-width=".6"/><text x="${x + 10}" y="${y + 13}" class="cs-key-sm" fill="${top ? '#fff' : '#222'}">${esc(IR_LABEL[k] || k)}</text>`;
    }));
    return `<rect x="1" y="1" width="82" height="198" rx="10" fill="#15171b" stroke="#000"/><circle cx="42" cy="12" r="4" fill="#4a1010" stroke="#000"/>${s.key ? glow(42, 12, 6, '#ff3030', 0.8) : ''}${keys}`;
  },
};

// ---------- 28BYJ-48 stepper + ULN2003 driver ----------
const stepper = {
  type: 'stepper', name: 'Stepper Motor (28BYJ-48 + ULN2003)', category: 'Electromechanical', w: 160, h: 104,
  pins: [
    { id: 'IN1', label: 'IN1', x: 0, y: 16, dir: 'l', title: 'IN1 — coil A (blue)' },
    { id: 'IN2', label: 'IN2', x: 0, y: 28, dir: 'l', title: 'IN2 — coil B (pink)' },
    { id: 'IN3', label: 'IN3', x: 0, y: 40, dir: 'l', title: 'IN3 — coil C (yellow)' },
    { id: 'IN4', label: 'IN4', x: 0, y: 52, dir: 'l', title: 'IN4 — coil D (orange)' },
    { id: 'GND', label: '−', x: 0, y: 76, dir: 'l', title: '− — ground' },
    { id: 'VCC', label: '+', x: 0, y: 88, dir: 'l', title: '+ — motor supply, 5 V' },
  ],
  props: {},
  hint: 'Stepper(2048, IN1, IN3, IN2, IN4) — note the order — or AccelStepper(AccelStepper::FULL4WIRE, IN1, IN3, IN2, IN4). 2048 steps per turn.',
  state: (c, sim) => { const d = dev(sim, c, 'stepper'); return { angle: d ? d.angle : 0, coils: d ? d.coils : [0, 0, 0, 0] }; },
  render(c, s) {
    const a = ((s.angle || 0) % 360 + 360) % 360; const coils = s.coils || [0, 0, 0, 0];
    const leds = ['A', 'B', 'C', 'D'].map((l, i) => `${glow(40 + i * 12, 86, 5, '#ff3030', coils[i] ? 0.8 : 0)}<circle cx="${40 + i * 12}" cy="86" r="3" fill="${coils[i] ? '#ff4040' : '#4a1515'}"/><text x="${40 + i * 12}" y="97" class="cs-tiny cs-light">${l}</text>`).join('');
    return `${lead('M0 16 H10 M0 28 H10 M0 40 H10 M0 52 H10 M0 76 H10 M0 88 H10')}<rect x="8" y="4" width="80" height="98" rx="3" fill="#1e7a3a" stroke="#114a22"/>
      <rect x="28" y="24" width="40" height="36" rx="2" fill="#111"/><text x="48" y="45" class="cs-tiny cs-light">ULN2003</text>${leds}
      <circle cx="124" cy="52" r="34" fill="#c0c5cc" stroke="#7d848e"/><circle cx="124" cy="52" r="26" fill="#d9dde2"/>
      <g transform="rotate(${a.toFixed(1)} 124 52)"><circle cx="124" cy="52" r="7" fill="#f0c419" stroke="#9a7a00"/><rect x="122" y="30" width="4" height="22" rx="2" fill="#333"/></g>
      <text x="124" y="98" class="cs-tiny cs-dark">${Math.round(s.angle || 0)}°</text>`;
  },
};

// ---------- BME280 / BMP280 module ----------
const bme280 = {
  pulled: ['SDA', 'SCL'],
  type: 'bme280', name: 'BME280 / BMP280 (I2C)', category: 'Sensors', w: 64, h: 70,
  pins: ['VIN', 'GND', 'SCL', 'SDA'].map((id, i) => ({ id, label: id, x: 11 + i * 14, y: 70, dir: 'b', title: { VIN: 'VIN — 3.3 V (5 V on modules with a regulator)', GND: 'GND', SCL: 'SCL — I2C clock', SDA: 'SDA — I2C data' }[id] })),
  props: { model: 'BME280', addr: '0x76', temp: 24, hum: 50, pressure: 1013.25 },
  controls: [
    { key: 'model', label: 'Chip', type: 'select', options: ['BME280', 'BMP280'], fmt: (v) => (v === 'BME280' ? 'BME280 (temp + humidity + pressure)' : 'BMP280 (temp + pressure)') },
    { key: 'addr', label: 'I2C address (SDO pin)', type: 'select', options: ['0x76', '0x77'] },
    { key: 'temp', label: 'Temperature', type: 'range', min: -40, max: 85, step: 0.1, fmt: (v) => `${(+v).toFixed(1)} °C` },
    { key: 'hum', label: 'Humidity (BME280)', type: 'range', min: 0, max: 100, step: 0.5, fmt: (v) => `${(+v).toFixed(1)} %` },
    { key: 'pressure', label: 'Pressure', type: 'range', min: 300, max: 1100, step: 0.25, fmt: (v) => `${(+v).toFixed(2)} hPa` },
  ],
  hint: 'Adafruit_BME280 / Adafruit_BMP280. Most purple modules answer at 0x76: call bme.begin(0x76) (begin() alone looks at 0x77).',
  state: () => ({}),
  render(c) {
    return `${lead('M11 56 V70 M25 56 V70 M39 56 V70 M53 56 V70')}<rect x="2" y="2" width="60" height="56" rx="3" fill="#6d28d9" stroke="#3b0f87"/>
      <rect x="24" y="14" width="16" height="16" rx="2" fill="#c9ced6" stroke="#7d848e"/><circle cx="36" cy="18" r="1.5" fill="#333"/>
      <text x="32" y="42" class="cs-tiny cs-light">${esc(c.props.model)}</text><text x="32" y="51" class="cs-tiny cs-light">${(+c.props.temp).toFixed(1)}° ${Math.round(c.props.pressure)}hPa</text>`;
  },
};

// ---------- MPU6050 (GY-521) ----------
const mpu6050 = {
  pulled: ['SDA', 'SCL'],
  type: 'mpu6050', name: 'Accelerometer + Gyro (MPU6050)', category: 'Sensors', w: 112, h: 74,
  pins: ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'].map((id, i) => ({ id, label: id, x: 7 + i * 14, y: 74, dir: 'b', title: { VCC: 'VCC — 3.3 V or 5 V', GND: 'GND', SCL: 'SCL — I2C clock', SDA: 'SDA — I2C data', XDA: 'XDA — auxiliary I2C (not used)', XCL: 'XCL — auxiliary I2C (not used)', AD0: 'AD0 — address: LOW/open = 0x68, HIGH = 0x69', INT: 'INT — interrupt output (not simulated)' }[id] })),
  props: { roll: 0, pitch: 0, spin: 0, temp: 25 },
  optional: ['XDA', 'XCL', 'AD0', 'INT'],
  controls: [
    { key: 'roll', label: 'Tilt left/right (roll)', type: 'range', min: -90, max: 90, step: 1, fmt: (v) => `${v}°` },
    { key: 'pitch', label: 'Tilt forward/back (pitch)', type: 'range', min: -90, max: 90, step: 1, fmt: (v) => `${v}°` },
    { key: 'spin', label: 'Rotation speed (Z)', type: 'range', min: -250, max: 250, step: 5, fmt: (v) => `${v} °/s` },
    { key: 'temp', label: 'Chip temperature', type: 'range', min: -40, max: 85, step: 0.5, fmt: (v) => `${v} °C` },
  ],
  hint: 'Adafruit_MPU6050 (getEvent: m/s², rad/s) or MPU6050 / MPU6050_light. Tilt it with the sliders: lying flat it reads 1 g on Z.',
  state: () => ({}),
  render(c) {
    const r = +c.props.roll || 0, p = +c.props.pitch || 0;
    return `${lead(Array.from({ length: 8 }, (_, i) => `M${7 + i * 14} 60 V74`).join(' '))}<rect x="1" y="2" width="110" height="60" rx="3" fill="#1d3f8f" stroke="#10275c"/>
      <g transform="translate(56 30) rotate(${(r / 3).toFixed(1)}) scale(1 ${Math.cos((p * Math.PI) / 180).toFixed(2)})"><rect x="-11" y="-11" width="22" height="22" fill="#111"/><circle cx="-7" cy="-7" r="1.5" fill="#444"/></g>
      <path d="M86 16 h14 M93 9 v14" stroke="#e5e7eb" stroke-width="1.5"/><text x="102" y="15" class="cs-tiny cs-light">X</text><text x="93" y="7" class="cs-tiny cs-light">Y</text>
      <text x="22" y="54" class="cs-tiny cs-light">GY-521</text>`;
  },
};

// ---------- 16×2 LCD, parallel (HD44780) ----------
const LCDP_PINS = ['VSS', 'VDD', 'V0', 'RS', 'RW', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'A', 'K'];
const lcdParallel = {
  type: 'lcd_parallel', name: 'LCD 16×2 (parallel)', category: 'Output', w: 236, h: 104,
  pins: LCDP_PINS.map((id, i) => ({ id, label: id, x: 28 + i * 12, y: 0, dir: 't', title: { VSS: 'VSS — GND', VDD: 'VDD — 5 V', V0: 'V0 — contrast: a 10 kΩ pot wiper (or GND)', RS: 'RS — register select', RW: 'RW — read/write: tie to GND', E: 'E — enable', A: 'A — backlight + (through 220 Ω to 5 V)', K: 'K — backlight − (GND)' }[id] || `${id} — data${['D0', 'D1', 'D2', 'D3'].includes(id) ? ' (unused in 4-bit mode)' : ''}` })),
  props: {},
  optional: ['D0', 'D1', 'D2', 'D3', 'A', 'K', 'V0'],
  hint: 'LiquidCrystal lcd(RS, E, D4, D5, D6, D7). RW to GND, V0 to a pot (contrast), A/K for the backlight.',
  state: (c, sim) => ({ d: dev(sim, c, 'lcd') }),
  render(c, s) {
    const L = s.d && s.d.on ? s.d : null, on = !!(L && L.backlight);
    const bg = on ? '#9fd14a' : L ? '#6d8a3a' : '#2f4416', fg = '#14240a';
    let rows = '';
    if (L) L.buf.forEach((row, r) => { rows += `<text x="40" y="${58 + r * 22}" class="cs-lcd" fill="${fg}" opacity="${Math.max(0.08, L.contrast).toFixed(2)}" textLength="176" lengthAdjust="spacing">${esc(row.join(''))}</text>`; });
    let cells = '';
    for (let r = 0; r < 2; r++) for (let k = 0; k < 16; k++) cells += `<rect x="${40 + k * 11}" y="${42 + r * 22}" width="9.5" height="17" fill="${fg}" opacity="${on ? 0.06 : 0.12}"/>`;
    return `<rect x="0" y="12" width="236" height="92" rx="4" fill="#1f6a35" stroke="#123f20"/>
      ${LCDP_PINS.map((l, i) => `<text x="${28 + i * 12}" y="22" class="cs-tiny cs-light" style="font-size:5px">${l}</text>`).join('')}
      <rect x="30" y="30" width="196" height="64" rx="3" fill="#111"/><rect x="34" y="34" width="188" height="56" rx="2" fill="${bg}"/>${cells}${rows}`;
  },
};

export const LIB_PARTS = { bme280, mpu6050, lcd_parallel: lcdParallel, oled, ws2812_strip: strip, ws2812_ring: ring, tm1637, ds18b20, hcsr04, ds3231, keypad, ir_receiver: irReceiver, ir_remote: irRemote, stepper };
