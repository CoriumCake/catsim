import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';
import { MOTOR } from '../../src/analog/models.ts';

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
const toggle = (pin: number, ms: number) => `void setup() { pinMode(${pin}, OUTPUT); }\nvoid loop() { digitalWrite(${pin}, HIGH); delay(${ms}); digitalWrite(${pin}, LOW); delay(${ms}); }`;

describe('DC motor', () => {
  it('reaches the analytic no-load speed ω = V / (K + Ra·b/K)', async () => {
    const { sim } = run([esp, comp('m1', 'motor')], [['esp:VIN', 'm1:+'], ['m1:-', 'esp:GND.L']], IDLE, 5);
    for (let i = 0; i < 12; i++) { await wait(50); sim.touch(); } // ~3 s simulated, τ = J·Ra/K² = 0.4 s
    const { k, ra, b } = MOTOR;
    const rpm = (5 / (k + (ra * b) / k)) * 60 / (2 * Math.PI) * (1 - 0.1 / 5); // VIN source has 0.1 Ω
    const got = sim.analog.mechanics().motors.m1[0];
    expect(Math.abs(got - rpm) / rpm).toBeLessThan(0.03);
  });

  it('spins up through a MOSFET, and warns about the inductive kick only without a flyback diode', async () => {
    const parts = [esp, comp('q1', 'nmos'), comp('m1', 'motor')];
    const wires: Array<[string, string]> = [['esp:D26', 'q1:G'], ['q1:S', 'esp:GND.L'], ['esp:VIN', 'm1:+'], ['m1:-', 'q1:D']];
    const a = run(parts, wires, toggle(26, 300), 2);
    for (let i = 0; i < 10; i++) { await wait(50); a.sim.touch(); }
    expect(a.sim.analog.mechanics().motors.m1[0]).toBeGreaterThan(1000);
    expect(a.host.logs.some((m: string) => /spike.*flyback diode/.test(m))).toBe(true);
    a.sim.stop(true);

    const b = run([...parts.map((p) => ({ ...p })), comp('d1', 'diode', { model: '1N4007' })], [...wires, ['m1:-', 'd1:A'], ['d1:K', 'esp:VIN']], toggle(26, 300), 2);
    for (let i = 0; i < 10; i++) { await wait(50); b.sim.touch(); }
    expect(b.host.logs.filter((m: string) => /spike/.test(m))).toEqual([]);
  });
});

describe('relay', () => {
  it('switches its NO contact when the coil is energised through a transistor', async () => {
    const { sim, host } = run([esp, comp('k1', 'relay'), comp('q1', 'npn'), comp('rb', 'resistor', { ohms: 1000 }), comp('d1', 'diode', { model: '1N4007' }),
      comp('rl', 'resistor', { ohms: 220 }), comp('l1', 'led')], [
      ['esp:D25', 'rb:1'], ['rb:2', 'q1:B'], ['q1:E', 'esp:GND.L'],
      ['esp:VIN', 'k1:C1'], ['k1:C2', 'q1:C'], ['k1:C2', 'd1:A'], ['d1:K', 'esp:VIN'],
      ['esp:3V3', 'k1:COM'], ['k1:NO', 'rl:1'], ['rl:2', 'l1:A'], ['l1:C', 'esp:GND.R'],
    ], toggle(25, 200));
    await wait(120); sim.touch();
    expect(sim.analog.mechanics().relays.k1).toBe(1);
    expect(sim.analog.ledBrightness().l1).toBeGreaterThan(0.3);
    await wait(200); sim.touch();
    expect(sim.analog.mechanics().relays.k1).toBe(0);
    expect(host.logs.filter((m: string) => /spike/.test(m))).toEqual([]); // the flyback diode is there
  });
});
