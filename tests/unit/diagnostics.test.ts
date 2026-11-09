/* Wiring and current problems are reported in plain words (they show up as alerts in the app). */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esp = comp('esp', 'esp32');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

async function run(components: Comp[], wires: Array<[string, string]>, code: string, ms = 700) {
  const host = {
    project: { name: 't', code, components: [esp, ...components], wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[],
    log(m: string, l = 'info') { host.logs.push(`${l}: ${m}`); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {}, nvChanged() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.analog = new AnalogBridge(sim);
  sim.start(code); live = sim;
  for (let t = 0; t < ms; t += 50) { await wait(50); sim.touch(); }
  return host.logs;
}
const high = (p: number) => `void setup() { pinMode(${p}, OUTPUT); digitalWrite(${p}, HIGH); }\nvoid loop() { delay(10); }`;
const has = (logs: string[], re: RegExp) => expect(logs.some((m) => re.test(m)), logs.join('\n')).toBe(true);

describe('wiring and current alerts', () => {
  it('a supply pin shorted to GND', async () => {
    has(await run([], [['esp:3V3', 'esp:GND.R']], 'void setup() {}\nvoid loop() { delay(10); }'), /^error: Short circuit: the 3V3 pin/);
  });
  it('a supply asked for more current than it can give', async () => {
    const logs = await run([comp('r1', 'resistor', { ohms: 10 }), comp('r2', 'resistor', { ohms: 10 })], [['esp:VIN', 'r1:1'], ['r1:2', 'esp:GND.R'], ['esp:VIN', 'r2:1'], ['r2:2', 'esp:GND.L']], 'void setup() {}\nvoid loop() { delay(10); }');
    has(logs, /Not enough current: the parts on the VIN pin draw \d+ mA/);
  });
  it('an LED wired backwards', async () => {
    has(await run([comp('r1', 'resistor'), comp('l1', 'led')], [['esp:D23', 'r1:1'], ['r1:2', 'l1:C'], ['l1:A', 'esp:GND.R']], high(23)), /l1 is the wrong way round/);
  });
  it('an LED whose cathode is not connected', async () => {
    has(await run([comp('r1', 'resistor'), comp('l1', 'led')], [['esp:D23', 'r1:1'], ['r1:2', 'l1:A']], high(23)), /l1: pin C .* isn't connected to anything/);
  });
  it('an LED starved of current by a huge resistor', async () => {
    has(await run([comp('r1', 'resistor', { ohms: 100000 }), comp('l1', 'led')], [['esp:D23', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'esp:GND.R']], high(23), 900), /l1 barely lights: only 0\.0\d mA/);
  });
  it('a relay coil driven straight from a pin', async () => {
    const logs = await run([comp('k1', 'relay')], [['esp:D23', 'k1:C1'], ['k1:C2', 'esp:GND.R']], high(23));
    has(logs, /k1's coil gets only \d+ mA but needs 50 mA/);
  });
  it('a servo with no power', async () => {
    has(await run([comp('s1', 'servo')], [['esp:D18', 's1:SIG']], '#include <ESP32Servo.h>\nServo s;\nvoid setup() { s.attach(18); s.write(90); }\nvoid loop() { delay(10); }'), /s1 has no power/);
  });
  it('an I2C LCD with SDA and SCL swapped', async () => {
    has(await run([comp('lcd1', 'lcd')], [['esp:3V3', 'lcd1:VCC'], ['lcd1:GND', 'esp:GND.R'], ['esp:D21', 'lcd1:SCL'], ['esp:D22', 'lcd1:SDA']],
      'LiquidCrystal_I2C lcd(0x27, 16, 2);\nvoid setup() { lcd.init(); lcd.print("hi"); }\nvoid loop() { delay(10); }'), /LCD lcd1 won't respond: its SDA and SCL wires are swapped/);
  });
  it('the sketch drives a pin that has nothing wired to it', async () => {
    has(await run([comp('r1', 'resistor'), comp('l1', 'led')], [['esp:D23', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'esp:GND.R']], high(22)), /Pin 22 is set HIGH but nothing is wired to it/);
  });
  it('a correct circuit raises none of these', async () => {
    const logs = await run([comp('r1', 'resistor'), comp('l1', 'led')], [['esp:D23', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'esp:GND.R']], high(23));
    expect(logs.filter((m) => !m.startsWith('info'))).toEqual([]);
  });
});
