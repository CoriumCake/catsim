/* The basic and power parts, wired as on the bench and driven by real sketches. */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';
import { batteryVolts, fsrOhms } from '../../src/analog/models-extra.ts';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

function run(components: Comp[], wires: Array<[string, string]>, code: string, board = 'esp32', boardProps = {}) {
  const b = comp(board === 'esp32c3' ? 'c3' : 'esp', board, boardProps);
  const host = {
    project: { name: 't', code, components: [b, ...components], wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[],
    log(m: string, l = 'info') { host.logs.push(`${l}: ${m}`); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {}, nvChanged() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.boardType = board;
  sim.analog = new AnalogBridge(sim);
  sim.start(code); live = sim;
  const set = (id: string, props: Record<string, unknown>) => {
    host.project = { ...host.project, components: host.project.components.map((c) => (c.id === id ? { ...c, props: { ...c.props, ...props } } : c)) };
    sim.invalidate(); sim.touch();
  };
  return { sim, host, set };
}
const settle = async (sim: { touch(): void }, ms = 120) => { for (let t = 0; t < ms; t += 20) { await wait(20); sim.touch(); } };
const until = async (cond: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); } };
const led = (sim: { analog: { ledBrightness(): Record<string, number> } }, k: string) => sim.analog.ledBrightness()[k] ?? 0;
const LOOP = 'void loop() { delay(10); }';

describe('RGB LED and 7-segment digit', () => {
  it('common anode: a color lights when its pin is LOW', async () => {
    const { sim, host } = run([comp('rgb1', 'rgb_led', { common: 'anode' }), comp('r1', 'resistor'), comp('r2', 'resistor')],
      [['esp:3V3', 'rgb1:COM'], ['rgb1:R', 'r1:1'], ['r1:2', 'esp:D25'], ['rgb1:G', 'r2:1'], ['r2:2', 'esp:D26']],
      `void setup() { pinMode(25, OUTPUT); pinMode(26, OUTPUT); digitalWrite(25, LOW); digitalWrite(26, HIGH); }\n${LOOP}`);
    await settle(sim, 200);
    expect(host.errors).toEqual([]);
    expect(led(sim, 'rgb1:R')).toBeGreaterThan(0.3);
    expect(led(sim, 'rgb1:G')).toBeLessThan(0.02);
  });
  it('common cathode: a color lights when its pin is HIGH', async () => {
    const { sim } = run([comp('rgb1', 'rgb_led', { common: 'cathode' }), comp('r1', 'resistor')],
      [['esp:GND.R', 'rgb1:COM'], ['rgb1:B', 'r1:1'], ['r1:2', 'esp:D25']], `void setup() { pinMode(25, OUTPUT); digitalWrite(25, HIGH); }\n${LOOP}`);
    await settle(sim, 200);
    expect(led(sim, 'rgb1:B')).toBeGreaterThan(0.05); // a blue die needs ~3 V: dim on 3.3 V through 220 Ω, as on the bench
  });
  it('7-segment (common cathode): HIGH lights a segment', async () => {
    const { sim } = run([comp('d1', 'seg7'), comp('r1', 'resistor')], [['d1:COM', 'esp:GND.R'], ['d1:a', 'r1:1'], ['r1:2', 'esp:D25']],
      `void setup() { pinMode(25, OUTPUT); digitalWrite(25, HIGH); }\n${LOOP}`);
    await settle(sim, 200);
    expect(led(sim, 'd1:a')).toBeGreaterThan(0.3);
    expect(led(sim, 'd1:b')).toBe(0);
  });
});

describe('switches, FSR, joystick, encoder', () => {
  it('slide switch joins COM to pin 2 when ON', async () => {
    const { sim, set } = run([comp('sw1', 'slide_switch')], [['sw1:COM', 'esp:3V3'], ['sw1:B', 'esp:D4']], `void setup() { pinMode(4, INPUT_PULLDOWN); }\n${LOOP}`);
    await settle(sim);
    expect(sim.readPin(4)).toBe(0);
    set('sw1', { on: true }); await settle(sim);
    expect(sim.readPin(4)).toBe(1);
  });
  it('FSR with a 10 kΩ pull-down: the ADC reading rises with force', async () => {
    const { sim, set } = run([comp('f1', 'fsr'), comp('r1', 'resistor', { ohms: 10000 })], [['esp:3V3', 'f1:1'], ['f1:2', 'esp:D34'], ['esp:D34', 'r1:1'], ['r1:2', 'esp:GND.L']],
      `int v = 0;\nvoid setup() { }\nvoid loop() { v = analogRead(34); delay(5); }`);
    await settle(sim);
    const idle = sim.analog.gpioVoltage(34);
    set('f1', { force: 1 }); await settle(sim);
    const light = sim.analog.gpioVoltage(34);
    set('f1', { force: 20 }); await settle(sim);
    const hard = sim.analog.gpioVoltage(34);
    expect(idle).toBeLessThan(0.01);
    expect(light).toBeCloseTo(3.3 * 10000 / (10000 + fsrOhms(1)), 1);
    expect(hard).toBeGreaterThan(3.0);
  });
  it('joystick axes and button', async () => {
    const { sim, set } = run([comp('j1', 'joystick')], [['j1:VCC', 'esp:3V3'], ['j1:GND', 'esp:GND.L'], ['j1:VRx', 'esp:D34'], ['j1:SW', 'esp:D4']],
      `void setup() { pinMode(4, INPUT_PULLUP); }\n${LOOP}`);
    await settle(sim);
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(1.65, 1);
    set('j1', { x: 1 }); await settle(sim);
    expect(sim.analog.gpioVoltage(34)).toBeGreaterThan(3.2);
    expect(sim.readPin(4)).toBe(1);
    sim.setPressed('j1', true); await settle(sim, 40);
    expect(sim.readPin(4)).toBe(0);
  });
  it('KY-040: the Encoder library and a hand-written CLK/DT reader both count detents', async () => {
    const { sim, host } = run([comp('e1', 'encoder')], [['e1:VCC', 'esp:3V3'], ['e1:GND', 'esp:GND.L'], ['e1:CLK', 'esp:D32'], ['e1:DT', 'esp:D33']],
      `#include <Encoder.h>
Encoder enc(32, 33);
int counter = 0; int lastClk = HIGH;
void setup() { Serial.begin(9600); pinMode(32, INPUT); pinMode(33, INPUT); }
void loop() {
  int clk = digitalRead(32);
  if (clk != lastClk && clk == LOW) { if (digitalRead(33) != clk) counter++; else counter--; }
  lastClk = clk;
  static long shown = 0; long p = enc.read();
  if (p != shown) { shown = p; Serial.print(counter); Serial.print("/"); Serial.print(p); Serial.print(" "); }
  delay(2);
}`);
    await settle(sim, 60);
    sim.setPressed('e1', true, 'cw'); sim.setPressed('e1', false, 'cw');
    sim.setPressed('e1', true, 'cw'); sim.setPressed('e1', false, 'cw');
    await settle(sim, 400);
    sim.setPressed('e1', true, 'ccw'); sim.setPressed('e1', false, 'ccw');
    await settle(sim, 250);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut.trim().split(' ').pop()).toBe('1/4');
    expect(sim.serialOut).toContain('2/8');
  });
});

describe('rotary encoder with interrupts (polled every 16 ms like the app)', () => {
  it('attachInterrupt on CLK (FALLING) counts every detent in both directions', async () => {
    const { sim, host } = run([comp('e1', 'encoder')], [['e1:VCC', 'esp:3V3'], ['e1:GND', 'esp:GND.L'], ['e1:CLK', 'esp:D32'], ['e1:DT', 'esp:D33']],
      `volatile int counter = 0;
void IRAM_ATTR onClk() { if (digitalRead(33) == HIGH) counter++; else counter--; }
void setup() { Serial.begin(115200); pinMode(32, INPUT); pinMode(33, INPUT); attachInterrupt(digitalPinToInterrupt(32), onClk, FALLING); }
void loop() { static int shown = 0; if (counter != shown) { shown = counter; Serial.print(counter); Serial.print(" "); } delay(5); }`);
    const tick = setInterval(() => { sim.touch(); sim.pollInterrupts(); }, 16);
    try {
      await settle(sim, 60);
      for (const k of ['cw', 'cw', 'cw', 'ccw']) { sim.setPressed('e1', true, k); sim.setPressed('e1', false, k); }
      await until(() => sim.serialOut.length >= 8, 3000);
      expect(host.errors).toEqual([]);
      expect(sim.serialOut).toBe('1 2 3 2 ');
    } finally { clearInterval(tick); }
  });
});

describe('power parts', () => {
  it('an 18650 cell lights an LED; its voltage follows the charge', async () => {
    expect(batteryVolts('18650 Li-ion (3.7 V)', 100)).toBeCloseTo(4.2);
    expect(batteryVolts('18650 Li-ion (3.7 V)', 0)).toBeCloseTo(3.0);
    const { sim, host } = run([comp('bat1', 'battery'), comp('r1', 'resistor'), comp('l1', 'led')], [['bat1:+', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'bat1:-']], `void setup() {}\n${LOOP}`);
    await settle(sim, 200);
    expect(led(sim, 'l1')).toBeGreaterThan(0.5);
    expect(host.logs.filter((m) => !m.startsWith('info'))).toEqual([]);
  });
  it('a battery drains with the current drawn and charges from a TP4056', async () => {
    const { sim, set } = run([comp('bat1', 'battery', { charge: 50, capacity: 50 }), comp('chg1', 'tp4056'), comp('r1', 'resistor', { ohms: 10 })],
      [['bat1:+', 'chg1:B+'], ['bat1:-', 'chg1:B-'], ['chg1:OUT+', 'r1:1'], ['r1:2', 'chg1:OUT-']], `void setup() {}\n${LOOP}`);
    sim.setSpeed(20);
    await settle(sim, 600);
    const soc1 = sim.analog.partActivity().bat1 * 100;
    expect(soc1).toBeLessThan(49); // ~370 mA from a 50 mAh cell: about 0.2 %/s
    set('r1', { ohms: 1000000 }); set('chg1', { usb: true });
    await settle(sim, 600);
    expect(sim.analog.partActivity().bat1 * 100).toBeGreaterThan(soc1 + 1); // charging at up to 1 A
  });
  it('a shorted battery and a coin cell asked for too much are reported', async () => {
    const a = run([comp('bat1', 'battery')], [['bat1:+', 'bat1:-']], `void setup() {}\n${LOOP}`);
    await settle(a.sim, 400);
    expect(a.host.logs.some((m) => /^error: Short circuit: battery bat1/.test(m))).toBe(true);
    a.sim.stop(true);
    const b = run([comp('bat1', 'battery', { type: 'CR2032 coin (3 V)' }), comp('r1', 'resistor', { ohms: 47 }), comp('l1', 'led')], [['bat1:+', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'bat1:-']], `void setup() {}\n${LOOP}`);
    await settle(b.sim, 400);
    expect(b.host.logs.some((m) => /Not enough current: the parts on battery bat1/.test(m))).toBe(true);
  });
  it('vibration motor switched by an AO3400 from a battery, with a flyback diode', async () => {
    const { sim, host } = run([comp('bat1', 'battery'), comp('m1', 'vibmotor'), comp('q1', 'nmos', { model: 'AO3400' }), comp('r1', 'resistor', { ohms: 100 }), comp('r2', 'resistor', { ohms: 100000 }), comp('d1', 'diode', { model: '1N5819' })],
      [['bat1:+', 'm1:+'], ['m1:-', 'q1:D'], ['q1:S', 'bat1:-'], ['bat1:-', 'esp:GND.L'], ['esp:D5', 'r1:1'], ['r1:2', 'q1:G'], ['q1:G', 'r2:1'], ['r2:2', 'esp:GND.L'], ['d1:A', 'm1:-'], ['d1:K', 'm1:+']],
      `void setup() { pinMode(5, OUTPUT); digitalWrite(5, HIGH); }\n${LOOP}`);
    await settle(sim, 400);
    expect(host.errors).toEqual([]);
    expect(Math.abs(sim.analog.mechanics().motors.m1[0])).toBeGreaterThan(5000);
    expect(host.logs.filter((m) => /spike|carrying|Not enough/.test(m))).toEqual([]);
  });
  it('TP4056: charging and full LEDs, and the protection cuts a flat cell', async () => {
    const wires: Array<[string, string]> = [['bat1:+', 'chg1:B+'], ['bat1:-', 'chg1:B-'], ['chg1:OUT+', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'chg1:OUT-']];
    const { sim, set } = run([comp('bat1', 'battery', { charge: 50 }), comp('chg1', 'tp4056'), comp('r1', 'resistor'), comp('l1', 'led')], wires, `void setup() {}\n${LOOP}`);
    await settle(sim);
    expect(led(sim, 'l1')).toBeGreaterThan(0.4);
    expect(sim.analog.partActivity().chg1).toBe(0);
    set('chg1', { usb: true }); await settle(sim);
    expect(sim.analog.partActivity().chg1).toBe(1); // red: charging
    set('bat1', { charge: 100 }); await settle(sim);
    expect(sim.analog.partActivity().chg1).toBe(0.5); // blue: full
    set('chg1', { usb: false }); set('bat1', { charge: 0, type: '2× AA (3 V)' }); await settle(sim, 300); // 2.0 V: below the 2.5 V cut-off
    expect(sim.analog.partActivity().chg1).toBe(0.25);
    expect(led(sim, 'l1')).toBeLessThan(0.02);
  });
  it('buck-boost gives 3.3 V from 1.8–5.5 V and turns off below that', async () => {
    const { sim, set } = run([comp('bat1', 'battery', { charge: 100 }), comp('reg1', 'buckboost'), comp('r1', 'resistor', { ohms: 100 })],
      [['bat1:+', 'reg1:VIN'], ['bat1:-', 'reg1:GND'], ['reg1:VOUT', 'r1:1'], ['r1:2', 'reg1:GND2'], ['reg1:GND', 'esp:GND.L'], ['reg1:VOUT', 'esp:D34']], `void setup() {}\n${LOOP}`);
    await settle(sim);
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(3.3, 1);
    set('bat1', { charge: 0 }); await settle(sim); // 3.0 V: boost mode
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(3.3, 1);
    set('bat1', { type: 'CR2032 coin (3 V)', charge: 0 }); await settle(sim);
    expect(sim.analog.gpioVoltage(34)).toBeGreaterThan(3.0); // 2.4 V still works (33 mA load from a coin cell sags, though)
  });
  it('a board powered from its pins stops when switched off and restarts when switched on', async () => {
    const parts = [comp('bat1', 'battery'), comp('chg1', 'tp4056'), comp('sw1', 'slide_switch', { on: true }), comp('reg1', 'buckboost')];
    const wires: Array<[string, string]> = [['bat1:+', 'chg1:B+'], ['bat1:-', 'chg1:B-'], ['chg1:OUT+', 'sw1:COM'], ['sw1:B', 'reg1:VIN'], ['chg1:OUT-', 'reg1:GND'],
      ['reg1:VOUT', 'c3:3V3'], ['reg1:GND2', 'c3:GND']];
    const { sim, host, set } = run(parts, wires, 'void setup() { Serial.begin(115200); Serial.print("boot "); }\nvoid loop() { delay(10); }', 'esp32c3', { power: 'pins' });
    await until(() => sim.serialOut === 'boot ');
    set('sw1', { on: false }); sim.checkPower(); await settle(sim, 60); sim.checkPower();
    expect(sim.halted).toBe(true);
    expect(host.logs.some((m) => /^warn: The board has no power/.test(m))).toBe(true);
    set('sw1', { on: true }); await settle(sim, 60); sim.checkPower();
    await until(() => sim.serialOut === 'boot boot ');
    expect(sim.halted).toBe(false);
    expect(host.errors).toEqual([]);
  });
  it('a battery-powered board drives HIGH at its actual rail voltage, not a fixed 3.3 V', async () => {
    const { sim, host } = run([comp('bat1', 'battery', { type: '2× AA (3 V)', charge: 80 })], [['bat1:+', 'c3:3V3'], ['bat1:-', 'c3:GND'], ['c3:IO10', 'c3:IO3']],
      'void setup() { pinMode(10, OUTPUT); digitalWrite(10, HIGH); }\nvoid loop() { delay(10); }', 'esp32c3', { power: 'pins' });
    await settle(sim, 200);
    expect(host.errors).toEqual([]);
    const rail = sim.analog.boardSupply();
    expect(rail).toBeGreaterThan(2.7); expect(rail).toBeLessThan(3.0);
    expect(sim.analog.gpioVoltage(10)).toBeCloseTo(rail, 1);
  });
  it('a board set to battery power with nothing on its pins does not start', async () => {
    const { sim, host } = run([], [], 'void setup() { Serial.begin(115200); Serial.print("boot"); }\nvoid loop() { delay(10); }', 'esp32c3', { power: 'pins' });
    await settle(sim, 100);
    expect(sim.serialOut).toBe('');
    expect(host.logs.some((m) => /no power/.test(m))).toBe(true);
  });
});

describe('L298N, sensor modules, breadboard', () => {
  it('L298N: IN1/IN2 set the direction (ENA on through its jumper), both LOW brakes', async () => {
    const { sim, host } = run([comp('bat1', 'battery', { type: '9 V block', charge: 100 }), comp('drv1', 'l298n'), comp('m1', 'motor')],
      [['bat1:+', 'drv1:12V'], ['bat1:-', 'drv1:GND'], ['drv1:GND', 'esp:GND.L'], ['drv1:OUT1', 'm1:+'], ['drv1:OUT2', 'm1:-'], ['esp:D25', 'drv1:IN1'], ['esp:D26', 'drv1:IN2'], ['esp:D27', 'drv1:ENA']],
      `void setup() { pinMode(25, OUTPUT); pinMode(26, OUTPUT); pinMode(27, INPUT); digitalWrite(25, HIGH); digitalWrite(26, LOW); }
void loop() { delay(10); }`);
    await settle(sim, 500);
    expect(host.errors).toEqual([]);
    expect(sim.analog.mechanics().motors.m1[0]).toBeGreaterThan(2000); // forward
    sim.out[25] = 0; sim.out[26] = 1; sim.touch(); await settle(sim, 800);
    expect(sim.analog.mechanics().motors.m1[0]).toBeLessThan(-2000); // reverse
    sim.out[26] = 0; sim.touch(); await settle(sim, 1500); // both LOW: the motor is shorted and brakes (τ ≈ 0.5 s)
    expect(Math.abs(sim.analog.mechanics().motors.m1[0])).toBeLessThan(1500);
  });
  it('sound / soil / gas modules: AO follows the level, DO goes LOW past the threshold', async () => {
    const { sim, set } = run([comp('g1', 'mq2', { gas: 0.2, threshold: 0.5 })], [['g1:VCC', 'esp:3V3'], ['g1:GND', 'esp:GND.L'], ['g1:AO', 'esp:D34'], ['g1:DO', 'esp:D4']],
      `void setup() { pinMode(4, INPUT); }\n${LOOP}`);
    await settle(sim);
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(0.66, 1);
    expect(sim.readPin(4)).toBe(1);
    set('g1', { gas: 0.8 }); await settle(sim);
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(2.64, 1);
    expect(sim.readPin(4)).toBe(0);
  });
  it('breadboard: a resistor and an LED plugged into it (no wires to their legs) light up', async () => {
    // breadboard at (0, 0): column k is at x = 16 + 10·(k−1); rows a–e at y = 40…80, f–j at y = 100…140
    const bb = comp('bb1', 'breadboard');
    const r1 = { ...comp('r1', 'resistor'), x: 41, y: 60 - 8 };                  // legs (15, 8) and (55, 8): holes 5c and 9c (40 units apart)
    const l1 = { ...comp('l1', 'led'), x: 86, y: 80 - 56 };                      // legs (10, 56) and (20, 56): holes 9e and 10e
    const { sim } = run([bb, r1, l1], [['esp:D23', 'bb1:5a'], ['bb1:10a', 'esp:GND.R']], `void setup() { pinMode(23, OUTPUT); digitalWrite(23, HIGH); }\n${LOOP}`);
    await settle(sim, 200);
    expect(led(sim, 'l1')).toBeGreaterThan(0.4);
    // the centre channel separates the halves: the same LED in the bottom half stays dark
    sim.stop(true);
    const l2 = { ...l1, y: 120 - 56 };
    const b = run([bb, r1, l2], [['esp:D23', 'bb1:5a'], ['bb1:10j', 'esp:GND.R']], `void setup() { pinMode(23, OUTPUT); digitalWrite(23, HIGH); }\n${LOOP}`);
    await settle(b.sim, 200);
    expect(led(b.sim, 'l1')).toBe(0);
  });
  it('breadboard: holes in a column and the rails are connected', async () => {
    const { sim } = run([comp('bb1', 'breadboard'), comp('r1', 'resistor'), comp('l1', 'led')],
      [['esp:D23', 'bb1:5a'], ['bb1:5e', 'r1:1'], ['r1:2', 'bb1:9f'], ['bb1:9j', 'l1:A'], ['l1:C', 'bb1:B-3'], ['bb1:B-20', 'esp:GND.R']],
      `void setup() { pinMode(23, OUTPUT); digitalWrite(23, HIGH); }\n${LOOP}`);
    await settle(sim, 200);
    expect(led(sim, 'l1')).toBeGreaterThan(0.4);
  });
});

describe('ESP32-C3 Super Mini', () => {
  it('runs a sketch with C3 pins: LED_BUILTIN 8 (active LOW), A0 = GPIO0, I2C on 8/9', async () => {
    const { sim, host } = run([comp('p1', 'pot', { value: 0.5 })], [['p1:VCC', 'c3:3V3'], ['p1:GND', 'c3:GND'], ['p1:SIG', 'c3:IO0']],
      `void setup() { Serial.begin(115200); pinMode(LED_BUILTIN, OUTPUT); digitalWrite(LED_BUILTIN, LOW); Serial.print(LED_BUILTIN); Serial.print(" "); Serial.print(SDA); Serial.print(SCL); Serial.print(" "); Serial.print(analogRead(A0) / 100); }\n${LOOP}`, 'esp32c3');
    await until(() => sim.serialOut.length >= 7);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('8 89 20');
    expect(sim.i2c).toEqual({ sda: 8, scl: 9 });
    expect(DEFS.esp32c3.state!(comp('c3', 'esp32c3'), sim)).toMatchObject({ led: true });
  });
  it('refuses pins and features the C3 does not have', async () => {
    const { host } = run([], [], 'void setup() { pinMode(12, OUTPUT); analogRead(6); dacWrite(25, 100); }\nvoid loop() { delay(10); }', 'esp32c3');
    await wait(50);
    expect(host.logs.some((m) => /GPIO12 is wired to the SPI flash on the ESP32-C3/.test(m))).toBe(true);
    expect(host.logs.some((m) => /GPIO6 is not an ADC pin \(the ESP32-C3 has ADC on GPIO 0–4\)/.test(m))).toBe(true);
    expect(String(host.errors[0])).toMatch(/the ESP32-C3 has no DAC/);
  });
});
