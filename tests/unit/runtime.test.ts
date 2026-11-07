import { afterEach, describe, expect, it, vi } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { DEFS } from '../../src/components.js';
import { OUTPUT, INPUT_PULLUP } from '../../src/pins.js';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });

function makeSim(components: Comp[], wires: Array<[string, string]>) {
  const host = {
    project: { name: 't', code: '', components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as Array<[string, string]>,
    errors: [] as unknown[],
    log(msg: string, level = 'info') { host.logs.push([level, msg]); },
    reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // runtime.js is still plain JS; type it loosely until it is converted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sim: new Simulator(host) as any, host };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ledState = (sim: any, c: Comp) => DEFS.led.state!(c, sim).b;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

describe('circuit nets', () => {
  const esp = comp('esp', 'esp32'), led = comp('led1', 'led'), r = comp('r1', 'resistor');

  it('lights an LED driven HIGH through a resistor to GND', () => {
    const { sim } = makeSim([esp, led, r], [['esp:D2', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'esp:GND.R']]);
    sim.running = true; sim.mode[2] = OUTPUT; sim.out[2] = 1;
    expect(ledState(sim, led)).toBe(1);
    sim.out[2] = 0; expect(ledState(sim, led)).toBe(0);
  });

  it('keeps the LED dark without a path to GND', () => {
    const { sim } = makeSim([esp, led, r], [['esp:D2', 'r1:1'], ['r1:2', 'led1:A']]);
    sim.running = true; sim.mode[2] = OUTPUT; sim.out[2] = 1;
    expect(ledState(sim, led)).toBe(0);
  });

  it('maps PWM duty to LED brightness', () => {
    const { sim } = makeSim([esp, led], [['esp:D4', 'led1:A'], ['led1:C', 'esp:GND.L']]);
    sim.running = true; sim.mode[4] = OUTPUT; sim.pwm[4] = 0.25;
    expect(ledState(sim, led)).toBeCloseTo(0.25);
  });

  it('reads a button with INPUT_PULLUP (pressed = LOW)', () => {
    const btn = comp('b1', 'button');
    const { sim } = makeSim([esp, btn], [['esp:D15', 'b1:1'], ['b1:2', 'esp:GND.R']]);
    sim.running = true; sim.mode[15] = INPUT_PULLUP;
    expect(sim.readPin(15)).toBe(1);
    sim.setPressed('b1', true); expect(sim.readPin(15)).toBe(0);
    sim.setPressed('b1', false); expect(sim.readPin(15)).toBe(1);
  });
});

describe('sketch execution', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs setup and loop, writes pins and serial', async () => {
    const { sim, host } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    sim.start('int n = 0;\nvoid setup() { Serial.begin(9600); pinMode(2, OUTPUT); digitalWrite(2, HIGH); Serial.print("hi"); }\nvoid loop() { n++; delay(5); }');
    await wait(80);
    expect(host.errors).toEqual([]);
    expect(sim.out[2]).toBe(1);
    expect(sim.serialOut).toBe('hi');
    expect(sim.running).toBe(true);
  });

  it('reports compile errors with a line number and does not start', async () => {
    const { sim, host } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    expect(await sim.start('void setup() {}\nclass Foo {};\nvoid loop() {}')).toBe(false);
    expect(sim.running).toBe(false);
    expect(host.logs.some(([lvl, m]) => lvl === 'error' && /line 2/.test(m))).toBe(true);
  });

  it('warns when analogRead uses an ADC2 pin while WiFi is on', async () => {
    const { sim, host } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    sim.start('int v = -1;\nvoid setup() { WiFi.begin("x", "y"); v = analogRead(4); Serial.print(v); }\nvoid loop() { delay(10); }');
    await wait(50);
    expect(sim.serialOut).toBe('0');
    expect(host.logs.some(([, m]) => /ADC2/.test(m))).toBe(true);
  });

  it('delay() advances simulated time exactly', async () => {
    const { sim } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    sim.setSpeed(20);
    sim.start('void setup() { Serial.begin(9600); delay(1000); Serial.print(millis()); delay(500); Serial.print(" "); Serial.print(millis()); }\nvoid loop() { delay(1000); }');
    await wait(150);
    const [a, b] = sim.serialOut.split(' ').map(Number);
    expect(a).toBeGreaterThanOrEqual(1000); expect(a).toBeLessThan(1010);
    expect(b - a).toBeGreaterThanOrEqual(500); expect(b - a).toBeLessThan(510);
  });

  it('pause() freezes the sketch and its clock', async () => {
    const { sim } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    sim.start('int n = 0;\nvoid setup() {}\nvoid loop() { n++; Serial.print("x"); delay(10); }');
    await wait(60);
    sim.pause();
    const t = sim.millis(), out = sim.serialOut.length;
    await wait(80);
    expect(sim.millis()).toBe(t);
    expect(sim.serialOut.length).toBeLessThanOrEqual(out + 1);
    sim.resume();
    await wait(60);
    expect(sim.serialOut.length).toBeGreaterThan(out + 1);
  });

  it('stop() ends a long delay', async () => {
    const { sim } = makeSim([comp('esp', 'esp32')], []);
    const done = sim.start('void setup() { delay(100000); }\nvoid loop() {}');
    await wait(20);
    sim.stop(true);
    await expect(Promise.race([done, wait(500).then(() => 'timeout')])).resolves.not.toBe('timeout');
  });
});

describe('strict-mode sketch wrapper', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('lets sketch variables shadow API names', async () => {
    const { sim, host } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    sim.start('int map = 3;\nint min(int a, int b) { return a < b ? b : a; }\nvoid setup() { Serial.print(map); Serial.print(min(1, 2)); Serial.print(constrain(9, 0, 5)); }\nvoid loop() { delay(10); }');
    await wait(50);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('325');
  });
  it('reports runtime errors on the right line', async () => {
    const { sim, host } = makeSim([comp('esp', 'esp32')], []);
    live = sim;
    sim.start('void setup() {\n  Serial.begin(9600);\n  notAFunction();\n}\nvoid loop() {}');
    await wait(50);
    const e = host.errors[0] as Error;
    expect(e.message).toMatch(/notAFunction/);
    expect(String(e.stack)).toMatch(/<anonymous>:5:/); // body line 3 + 2 lines of Function() preamble
  });
});
