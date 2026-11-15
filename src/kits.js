/* CatSim — kits: ready-made groups of parts that wire themselves to an ESP32-C3 Super Mini and to each other.
 * The three SmartGrip kits (sensors, outputs, power) together make the whole pressure-glove circuit.
 * A kit's parts have fixed ids, so the wiring below can name them; positions are relative to the board. */

const RED = '#ff4d4d', GND = '#5c6370', YELLOW = '#ffd60a', GREEN = '#2ecc71', BLUE = '#3d8bff', PURPLE = '#b06cff', PINK = '#ff6b9a', ORANGE = '#f39c12';
const P = (id, type, dx, dy, props = {}) => ({ id, type, dx, dy, props });

export const KITS = [
  {
    key: 'sg_sensors', name: 'SmartGrip 1: three FSR fingers',
    hint: 'FSR1–3 with 10 kΩ to GND, on GPIO0, GPIO1 and GPIO3',
    parts: [
      P('finger1', 'fsr', 160, -180, { force: 0 }), P('rFinger1', 'resistor', 130, -40, { ohms: 10000 }),
      P('finger2', 'fsr', 270, -180, { force: 0 }), P('rFinger2', 'resistor', 240, -40, { ohms: 10000 }),
      P('finger3', 'fsr', 380, -180, { force: 0 }), P('rFinger3', 'resistor', 350, -40, { ohms: 10000 }),
    ],
  },
  {
    key: 'sg_outputs', name: 'SmartGrip 2: RGB LED, CAL button, vibration motor',
    hint: 'RGB LED on GPIO4–6, CAL button on GPIO7, motor through an AO3400 on GPIO10',
    parts: [
      P('rgbStatus', 'rgb_led', -200, -200, { common: 'anode' }),
      P('rRed', 'resistor', -120, -100, { ohms: 220 }), P('rGreen', 'resistor', -120, -70, { ohms: 220 }), P('rBlue', 'resistor', -120, -40, { ohms: 220 }),
      P('calBtn', 'button', -90, 10, { color: 'blue' }),
      P('rGate', 'resistor', -150, 80, { ohms: 100 }), P('rPull', 'resistor', -150, 150, { ohms: 100000 }),
      P('mosfet', 'nmos', -230, 60, { model: 'AO3400', spice: '' }),
      P('vib', 'vibmotor', -330, -20, { }), P('flyback', 'diode', -400, 70, { model: '1N5819', spice: '' }),
    ],
  },
  {
    key: 'sg_power', name: 'SmartGrip 3: 18650 battery, charger, switch, 3.3 V',
    hint: '18650 cell → TP4056 charger → ON/OFF switch → 3.3 V regulator → the board’s 3V3 pin',
    parts: [
      P('charger', 'tp4056', -330, 240, { usb: false }),
      P('cell', 'battery', -190, 230, { type: '18650 Li-ion (3.7 V)', charge: 80 }),
      P('onOff', 'slide_switch', 40, 190, { on: true }),
      P('reg3v3', 'buckboost', 140, 230, {}),
    ],
  },
];

// The whole circuit. `c3` stands for the project's ESP32-C3 board. A wire is added as soon as both of its ends exist.
const W = (from, to, color) => ({ from, to, color });
const WIRES = [
  // 1: each FSR from 3V3 to its ADC pin, with 10 k from that pin to GND
  ...[['finger1', 'rFinger1', 'IO0', YELLOW], ['finger2', 'rFinger2', 'IO1', GREEN], ['finger3', 'rFinger3', 'IO3', BLUE]].flatMap(([f, r, pin, col]) =>
    [W(`${f}:1`, 'c3:3V3', RED), W(`${f}:2`, `c3:${pin}`, col), W(`${f}:2`, `${r}:2`, col), W(`${r}:1`, 'c3:GND', GND)]),
  // 2: common-anode RGB LED through 220 Ω; the CAL button to GND; the motor switched by an N-MOSFET
  W('rgbStatus:COM', 'c3:3V3', RED),
  W('rgbStatus:R', 'rRed:1', ORANGE), W('rRed:2', 'c3:IO4', ORANGE),
  W('rgbStatus:G', 'rGreen:1', GREEN), W('rGreen:2', 'c3:IO5', GREEN),
  W('rgbStatus:B', 'rBlue:1', BLUE), W('rBlue:2', 'c3:IO6', BLUE),
  W('calBtn:1b', 'c3:IO7', PINK), W('calBtn:2b', 'c3:GND', GND),
  W('c3:IO10', 'rGate:2', PURPLE), W('rGate:1', 'mosfet:G', PURPLE), W('mosfet:G', 'rPull:1', PURPLE), W('rPull:2', 'c3:GND', GND),
  W('vib:+', 'c3:3V3', RED), W('vib:-', 'mosfet:D', YELLOW), W('mosfet:S', 'c3:GND', GND),
  W('flyback:K', 'vib:+', RED), W('flyback:A', 'vib:-', YELLOW),
  // 3: cell → charger → switch → 3.3 V regulator → the board
  W('cell:+', 'charger:B+', RED), W('cell:-', 'charger:B-', GND),
  W('charger:OUT+', 'onOff:COM', RED), W('onOff:B', 'reg3v3:VIN', RED), W('charger:OUT-', 'reg3v3:GND', GND),
  W('reg3v3:VOUT', 'c3:3V3', RED), W('reg3v3:GND2', 'c3:GND', GND),
];

const kitBoard = (project) => project.components.find((c) => c.type === 'esp32c3') || null;
const has = (project, part) => project.components.some((c) => c.id === part.id && c.type === part.type);

/** How many of a kit's parts are on the canvas. */
export function kitPresent(project, key) {
  const kit = KITS.find((k) => k.key === key);
  return kit.parts.filter((p) => has(project, p)).length;
}

/** Add every kit wire whose two ends now exist. Safe to call again: wires already there are left alone. */
export function linkKits(project) {
  const board = kitBoard(project);
  const parts = new Map(KITS.flatMap((k) => k.parts).filter((p) => has(project, p)).map((p) => [p.id, p]));
  const end = (ref) => { const [id, pin] = ref.split(':'); return id === 'c3' ? (board ? `${board.id}:${pin}` : null) : parts.has(id) ? ref : null; };
  let added = 0;
  for (const w of WIRES) {
    const from = end(w.from), to = end(w.to); if (!from || !to) continue;
    if (project.wires.some((x) => (x.from === from && x.to === to) || (x.from === to && x.to === from))) continue;
    let i = 1; while (project.wires.some((x) => x.id === 'w' + i)) i++;
    project.wires.push({ id: 'w' + i, from, to, color: w.color }); added++;
  }
  // the regulator feeds the board's 3V3 pin, so the board must not also be on USB power
  if (board && parts.has('reg3v3')) board.props = { ...board.props, power: 'pins' };
  return added;
}

/** Put a kit's missing parts on the canvas, around the ESP32-C3 (or around `at`, where a board would stand), and wire it. */
export function addKit(project, key, at) {
  const kit = KITS.find((k) => k.key === key), board = kitBoard(project), o = board || at;
  let parts = 0;
  for (const p of kit.parts) {
    if (has(project, p)) continue;
    if (project.components.some((c) => c.id === p.id)) continue; // the id is taken by something else: leave it
    project.components.push({ id: p.id, type: p.type, x: o.x + p.dx, y: o.y + p.dy, props: { ...p.props } }); parts++;
  }
  return { parts, wires: linkKits(project), board: board ? board.id : null };
}

/** The three kits on an ESP32-C3: the whole SmartGrip circuit, as an example loads it. */
export function kitCircuit(x, y) {
  const project = { components: [{ id: 'c3', type: 'esp32c3', x, y, props: { power: 'pins' } }], wires: [] };
  for (const k of KITS) addKit(project, k.key);
  return { components: project.components, wires: project.wires.map(({ from, to, color }) => ({ from, to, color })) };
}
