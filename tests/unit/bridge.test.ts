import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

function run(components: Comp[], wires: Array<[string, string]>, code: string) {
  const host = {
    project: { name: 't', code, components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[],
    log(m: string) { host.logs.push(m); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.analog = new AnalogBridge(sim);
  sim.start(code);
  live = sim;
  return { sim, host };
}

describe('analog bridge', () => {
  const esp = comp('esp', 'esp32');

  it('lights an LED with a current set by the resistor and the LED colour', async () => {
    const red = comp('l1', 'led', { color: 'red' }), blue = comp('l2', 'led', { color: 'blue' });
    const { sim, host } = run([esp, comp('r1', 'resistor', { ohms: 220 }), red, comp('r2', 'resistor', { ohms: 220 }), blue], [
      ['esp:D2', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'esp:GND.R'],
      ['esp:D4', 'r2:1'], ['r2:2', 'l2:A'], ['l2:C', 'esp:GND.R'],
    ], 'void setup() { pinMode(2, OUTPUT); pinMode(4, OUTPUT); digitalWrite(2, HIGH); digitalWrite(4, HIGH); }\nvoid loop() { delay(10); }');
    await wait(150); sim.touch();
    expect(host.errors).toEqual([]);
    const b = sim.analog.ledBrightness();
    // red: (3.3 - ~1.9 V) / 255 Ω ≈ 5.5 mA → sqrt(0.55) ≈ 0.74; blue (3.0 V) gets far less current
    expect(b.l1).toBeGreaterThan(0.6); expect(b.l1).toBeLessThan(0.9);
    expect(b.l2).toBeLessThan(b.l1 * 0.7);
    const vLed = sim.analog.nodeVoltage('l1:A');
    expect(vLed).toBeGreaterThan(1.8); expect(vLed).toBeLessThan(2.05);
  });

  it('reads a button through the pull-up with real thresholds', async () => {
    const { sim } = run([esp, comp('b1', 'button')], [['esp:D15', 'b1:1'], ['b1:2', 'esp:GND.R']],
      'void setup() { pinMode(15, INPUT_PULLUP); }\nvoid loop() { delay(5); }');
    await wait(60);
    expect(sim.readPin(15)).toBe(1);
    expect(sim.analog.gpioVoltage(15)).toBeCloseTo(3.3, 2);
    sim.setPressed('b1', true);
    expect(sim.readPin(15)).toBe(0);
    expect(sim.analog.gpioVoltage(15)).toBeLessThan(0.01);
  });

  it('reads a potentiometer as a real voltage divider', async () => {
    const pot = comp('p1', 'pot', { value: 0.25 });
    const { sim } = run([esp, pot], [['esp:3V3', 'p1:VCC'], ['p1:GND', 'esp:GND.L'], ['p1:SIG', 'esp:D34']],
      'int v = 0;\nvoid setup() { Serial.begin(9600); }\nvoid loop() { v = analogRead(34); Serial.print(v); Serial.print(" "); delay(50); }');
    await wait(80);
    const first = +sim.serialOut.trim().split(' ')[0];
    expect(first).toBeGreaterThan(1000); expect(first).toBeLessThan(1050); // 25 % of 4095, slightly loaded by the source resistance
  });

  it('averages PWM into LED brightness', async () => {
    const led = comp('l1', 'led');
    const { sim } = run([esp, comp('r1', 'resistor', { ohms: 220 }), led], [['esp:D2', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'esp:GND.R']],
      'void setup() { analogWrite(2, 64); }\nvoid loop() { delay(10); }'); // 25 % duty at 1 kHz
    await wait(250); sim.touch();
    const b = sim.analog.ledBrightness().l1;
    expect(b).toBeGreaterThan(0.3); expect(b).toBeLessThan(0.45); // sqrt(0.25 · 0.55)
  });

  it('records probe waveforms (PWM square wave on the pin)', async () => {
    const { sim } = run([esp, comp('r1', 'resistor', { ohms: 1000 })], [['esp:D2', 'r1:1'], ['r1:2', 'esp:GND.L']],
      'void setup() { analogWrite(2, 128); }\nvoid loop() { delay(10); }');
    sim.analog.setProbes(['esp:D2']);
    await wait(60); sim.touch();
    const s = sim.analog.takeSamples();
    expect(s).not.toBeNull();
    const v = Array.from(s.v[0] as Float32Array);
    expect(Math.max(...v)).toBeGreaterThan(3.1);
    expect(Math.min(...v)).toBeLessThan(0.05);
  });

  it('outputs a real voltage with dacWrite', async () => {
    const { sim } = run([esp, comp('r1', 'resistor', { ohms: 100000 })], [['esp:D25', 'r1:1'], ['r1:2', 'esp:GND.L']],
      'void setup() { dacWrite(25, 128); }\nvoid loop() { delay(10); }');
    await wait(40); sim.touch();
    expect(sim.analog.gpioVoltage(25)).toBeCloseTo(3.3 * 128 / 255, 1);
  });

  it('picks up property changes when the project object is replaced (as the worker receives edits)', async () => {
    const pot = comp('p1', 'pot', { value: 0.25 });
    const { sim, host } = run([esp, pot], [['esp:3V3', 'p1:VCC'], ['p1:GND', 'esp:GND.L'], ['p1:SIG', 'esp:D34']],
      'void setup() {}\nvoid loop() { delay(20); }');
    await wait(40); sim.touch();
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(0.825, 1);
    const copy = structuredClone(host.project);
    copy.components.find((c: Comp) => c.id === 'p1')!.props.value = 0.75;
    host.project = copy; sim.invalidate();
    sim.touch();
    expect(sim.analog.gpioVoltage(34)).toBeCloseTo(2.475, 1);
  });
});
