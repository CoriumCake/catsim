import { afterEach, describe, expect, it } from 'vitest';
import { CHIPS, type ChipCtx, type Level } from '../../src/digital/chips.ts';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';

const ctxOf = (levels: Record<string, Level>, v: Record<string, number> = {}, vcc = 5): ChipCtx =>
  ({ level: (p) => levels[p] ?? 0, v: (p) => v[p] ?? (levels[p] ? vcc : 0), vcc });

describe('chip logic', () => {
  it.each([
    ['hc00', [1, 1, 1, 0]], ['hc08', [0, 0, 0, 1]], ['hc32', [0, 1, 1, 1]], ['hc86', [0, 1, 1, 0]], ['hc02', [1, 0, 0, 0]],
  ] as const)('%s truth table', (type, expected) => {
    const d = CHIPS[type], st = d.init();
    [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([a, b], i) => {
      expect(d.evaluate(ctxOf({ '1A': a as Level, '1B': b as Level }), st)['1Y']).toBe(expected[i]);
    });
  });

  it('74HC04 inverts, 74HC14 has Schmitt thresholds', () => {
    expect(CHIPS.hc04.evaluate(ctxOf({ '3A': 1 }), {})['3Y']).toBe(0);
    expect(CHIPS.hc14.thresholds!('1A', ctxOf({}, {}, 5))).toEqual([0.33 * 5, 0.55 * 5]);
  });

  it('74HC74 latches D on the rising clock edge only', () => {
    const d = CHIPS.hc74, st = d.init();
    const run = (D: Level, CLK: Level) => d.evaluate(ctxOf({ '1D': D, '1CLK': CLK, '1PRE': 1, '1CLR': 1 }), st)['1Q'];
    expect(run(1, 0)).toBe(0);
    expect(run(1, 1)).toBe(1); // edge
    expect(run(0, 1)).toBe(1); // no edge
    expect(run(0, 0)).toBe(1);
    expect(run(0, 1)).toBe(0);
    expect(d.evaluate(ctxOf({ '1PRE': 0, '1CLR': 1 }), st)['1Q']).toBe(1); // async preset
  });

  it('74HC595 shifts and latches', () => {
    const d = CHIPS.hc595, st = d.init();
    const step = (lv: Record<string, Level>) => d.evaluate(ctxOf({ SRCLR: 1, OE: 0, ...lv }), st);
    for (const bit of [1, 0, 1, 1, 0, 0, 0, 1]) { step({ SER: bit as Level, SRCLK: 0 }); step({ SER: bit as Level, SRCLK: 1 }); }
    expect(step({})['Q0']).toBe(0); // not latched yet
    step({ RCLK: 1 });
    const out = step({ RCLK: 0 });
    // first bit shifted in ends up in Q7
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => out[`Q${i}`]).join('')).toBe('10001101');
    expect(d.evaluate(ctxOf({ SRCLR: 1, OE: 1 }), st).Q0).toBe('z'); // OE high disables the outputs
  });

  it('CD4017 counts rising edges and resets', () => {
    const d = CHIPS.cd4017, st = d.init();
    const clk = (l: Level, rst: Level = 0) => d.evaluate(ctxOf({ CLK: l, RST: rst }), st);
    for (let i = 0; i < 3; i++) { clk(1); clk(0); }
    expect(clk(0).Q3).toBe(1);
    expect(clk(0, 1).Q0).toBe(1);
  });

  it('NE555 comparators: trigger below VCC/3 sets, threshold above 2VCC/3 resets', () => {
    const d = CHIPS.ne555, st = d.init();
    const ev = (trig: number, thres: number) => d.evaluate(ctxOf({ RESET: 1 }, { TRIG: trig, THRES: thres, CTRL: 10 / 3 }), st);
    expect(ev(1, 1).OUT).toBe(1);
    expect(ev(2, 2).OUT).toBe(1); // holds
    expect(ev(4, 4)).toEqual({ OUT: 0, DISCH: 0 });
  });
});

// ---------- full circuits through the runtime + analog engine ----------
type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

function run(components: Comp[], wires: Array<[string, string]>, code: string, speed = 1) {
  const host = {
    project: { name: 't', code, components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[],
    log(m: string) { host.logs.push(m); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.analog = new AnalogBridge(sim);
  sim.setSpeed(speed);
  sim.start(code);
  live = sim;
  return { sim, host };
}
const esp = comp('esp', 'esp32');
const IDLE = 'void setup() {}\nvoid loop() { delay(20); }';

describe('logic chips in circuits', () => {
  it('74HC595 driven by shiftOut() sets its outputs', async () => {
    const { sim, host } = run([esp, comp('u1', 'hc595')], [
      ['esp:3V3', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['u1:OE', 'esp:GND.L'], ['u1:SRCLR', 'esp:3V3'],
      ['esp:D23', 'u1:SER'], ['esp:D18', 'u1:SRCLK'], ['esp:D5', 'u1:RCLK'],
    ], `void setup() {
  pinMode(23, OUTPUT); pinMode(18, OUTPUT); pinMode(5, OUTPUT);
  digitalWrite(5, LOW); shiftOut(23, 18, MSBFIRST, 0b10100101); digitalWrite(5, HIGH);
}
void loop() { delay(20); }`);
    await wait(80); sim.touch();
    expect(host.errors).toEqual([]);
    const q = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ((sim.analog.nodeVoltage(`u1:Q${i}`) ?? 0) > 1.65 ? 1 : 0)).reverse().join('');
    expect(q).toBe('10100101');
  });

  it('NE555 astable oscillates at 1.44 / ((R1 + 2·R2)·C)', async () => {
    // R1 = 1k, R2 = 10k, C = 1 µF → 68.6 Hz
    const { sim } = run([esp, comp('u1', 'ne555'), comp('r1', 'resistor', { ohms: 1000 }), comp('r2', 'resistor', { ohms: 10000 }), comp('c1', 'capacitor', { value: '1µF' })], [
      ['esp:VIN', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['u1:RESET', 'esp:VIN'],
      ['esp:VIN', 'r1:1'], ['r1:2', 'u1:DISCH'], ['u1:DISCH', 'r2:1'], ['r2:2', 'u1:THRES'], ['u1:THRES', 'u1:TRIG'],
      ['u1:THRES', 'c1:+'], ['c1:-', 'esp:GND.L'],
    ], IDLE);
    sim.analog.setProbes(['u1:OUT', 'c1:+'], 1e-4);
    await wait(250); sim.touch();
    const s = sim.analog.takeSamples();
    const t = Array.from(s.t as Float64Array), out = Array.from(s.v[0] as Float32Array), cap = Array.from(s.v[1] as Float32Array);
    const rises: number[] = [];
    for (let i = 1; i < t.length; i++) if (out[i - 1] < 2.5 && out[i] >= 2.5) rises.push(t[i]);
    expect(rises.length).toBeGreaterThan(4);
    const periods = rises.slice(2).map((r, i) => r - rises[i + 1]); // skip the first (longer) cycle
    const f = 1 / (periods.reduce((a, b) => a + b, 0) / periods.length);
    expect(f).toBeGreaterThan(68.6 * 0.95); expect(f).toBeLessThan(68.6 * 1.05);
    // the capacitor swings between VCC/3 and 2·VCC/3
    const late = cap.filter((_, i) => t[i] > rises[2]);
    expect(Math.min(...late)).toBeCloseTo(5 / 3, 0); expect(Math.max(...late)).toBeCloseTo(10 / 3, 0);
  });

  it('74HC14 RC relaxation oscillator runs', async () => {
    const { sim } = run([esp, comp('u1', 'hc14'), comp('r1', 'resistor', { ohms: 10000 }), comp('c1', 'capacitor', { value: '1µF' })], [
      ['esp:3V3', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['u1:1Y', 'r1:1'], ['r1:2', 'u1:1A'], ['u1:1A', 'c1:+'], ['c1:-', 'esp:GND.L'],
    ], IDLE);
    sim.analog.setProbes(['u1:1Y'], 1e-4);
    await wait(200); sim.touch();
    const s = sim.analog.takeSamples(); const v = Array.from(s.v[0] as Float32Array);
    let edges = 0; for (let i = 1; i < v.length; i++) if ((v[i - 1] < 1.65) !== (v[i] < 1.65)) edges++;
    expect(edges).toBeGreaterThan(10); // RC = 10 ms with Schmitt hysteresis → tens of Hz
  });

  it('74HC74 wired as a toggle halves the clock (D = Q̅)', async () => {
    const { sim } = run([esp, comp('u1', 'hc74')], [
      ['esp:3V3', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['u1:1PRE', 'esp:3V3'], ['u1:1CLR', 'esp:3V3'],
      ['u1:1Q̅', 'u1:1D'], ['esp:D18', 'u1:1CLK'],
    ], `int n = 0;
void setup() { pinMode(18, OUTPUT); }
void loop() { digitalWrite(18, HIGH); delay(5); digitalWrite(18, LOW); delay(5); n++; }`);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) { await wait(10); sim.touch(); seen.push((sim.analog.nodeVoltage('u1:1Q') ?? 0) > 1.65 ? 1 : 0); }
    expect(new Set(seen).size).toBe(2);
  });

  it('CD4017 counts pulses from the ESP32', async () => {
    const { sim } = run([esp, comp('u1', 'cd4017')], [
      ['esp:3V3', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['u1:EN', 'esp:GND.L'], ['u1:RST', 'esp:GND.L'], ['esp:D18', 'u1:CLK'],
    ], `void setup() {
  pinMode(18, OUTPUT);
  for (int i = 0; i < 4; i++) { digitalWrite(18, HIGH); delay(1); digitalWrite(18, LOW); delay(1); }
}
void loop() { delay(20); }`);
    await wait(60); sim.touch();
    expect(sim.analog.nodeVoltage('u1:Q4')).toBeGreaterThan(3);
    expect(sim.analog.nodeVoltage('u1:Q3')).toBeLessThan(0.3);
  });

  it('74HC at 5 V does not see a 3.3 V GPIO as HIGH (needs HCT or a level shifter)', async () => {
    const { sim } = run([esp, comp('u1', 'hc04')], [['esp:VIN', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['esp:D18', 'u1:1A']],
      'void setup() { pinMode(18, OUTPUT); digitalWrite(18, HIGH); }\nvoid loop() { delay(20); }');
    await wait(40); sim.touch();
    expect(sim.analog.nodeVoltage('u1:1Y')).toBeGreaterThan(4); // input still reads LOW: 3.3 V < 0.7 · 5 V
  });
});
