import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';
import { normalizeProject } from '../../src/project.ts';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });
const IDLE = 'void setup() {}\nvoid loop() { delay(20); }';

async function solve(components: Comp[], wires: Array<[string, string]>) {
  const host = {
    project: normalizeProject({ name: 't', code: IDLE, components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) }, DEFS),
    logs: [] as string[], log(m: string) { host.logs.push(m); }, reportError() {}, iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.analog = new AnalogBridge(sim);
  sim.start(IDLE); live = sim;
  await wait(30); sim.touch();
  return { v: (k: string) => sim.analog.nodeVoltage(k) as number, logs: host.logs };
}
const esp = comp('esp', 'esp32');
const diodeCircuit = (spice: string) => solve([esp, comp('r1', 'resistor', { ohms: 1000 }), comp('d1', 'diode', { spice })],
  [['esp:VIN', 'r1:1'], ['r1:2', 'd1:A'], ['d1:K', 'esp:GND.L']]);

describe('custom SPICE models on parts', () => {
  it('a diode .model changes the forward voltage', async () => {
    const builtIn = (await diodeCircuit('')).v('d1:A');
    const custom = (await diodeCircuit('* Schottky-ish\n.model DX D(IS=1e-5 N=1.1)')).v('d1:A');
    expect(builtIn).toBeGreaterThan(0.6);
    expect(custom).toBeLessThan(builtIn - 0.2);
  });

  it('a low-gain NPN .model no longer saturates', async () => {
    const run = (spice: string) => solve([esp, comp('q1', 'npn', { spice }), comp('rb', 'resistor', { ohms: 10000 }), comp('rc', 'resistor', { ohms: 470 })],
      [['esp:3V3', 'rb:1'], ['rb:2', 'q1:B'], ['q1:E', 'esp:GND.L'], ['esp:VIN', 'rc:1'], ['rc:2', 'q1:C']]);
    expect((await run('')).v('q1:C')).toBeLessThan(0.3); // 2N2222, β ≈ 256: Ib ≈ 0.27 mA saturates it
    expect((await run('.model LOWB NPN(IS=1e-14 BF=10)')).v('q1:C')).toBeGreaterThan(3); // β = 10: Ic ≈ 2.6 mA, 1.2 V across 470 Ω
  });

  it('an op-amp .subckt (+IN −IN VCC VEE OUT) replaces the LM358', async () => {
    const ideal = `* ideal rail-free op-amp
.subckt IDEALOP inp inn vcc vee out
E1 int 0 inp inn 100000
R1 int out 1
.ends`;
    const run = (spice: string) => solve([esp, comp('u1', 'opamp', { spice })],
      [['esp:3V3', 'u1:VCC'], ['u1:GND', 'esp:GND.L'], ['esp:3V3', 'u1:IN+'], ['u1:OUT', 'u1:IN-']]);
    expect((await run('')).v('u1:OUT')).toBeLessThan(2); // LM358 can't get within 1.5 V of its supply
    expect((await run(ideal)).v('u1:OUT')).toBeCloseTo(3.3, 1);
  });

  it('a MOSFET .subckt with pins D G S (vendor style) is used', async () => {
    const sub = `.subckt MYFET d g s
M1 d g s s MN
.model MN NMOS(LEVEL=1 VTO=3.5 KP=2)
.ends`;
    const run = (spice: string) => solve([esp, comp('m1', 'nmos', { spice }), comp('rl', 'resistor', { ohms: 100 })],
      [['esp:3V3', 'm1:G'], ['m1:S', 'esp:GND.L'], ['esp:VIN', 'rl:1'], ['rl:2', 'm1:D']]);
    expect((await run('')).v('m1:D')).toBeLessThan(1); // 2N7000 turns on at 3.3 V
    expect((await run(sub)).v('m1:D')).toBeGreaterThan(4.9); // VTO = 3.5 V: stays off
  });

  it('invalid SPICE text falls back to the built-in model with an explanation', async () => {
    const r = await diodeCircuit('* my diode\n.model DX D(IS=abc N=1)');
    expect(r.v('d1:A')).toBeGreaterThan(0.6);
    expect(r.logs.some((m) => /d1: custom SPICE model not used \(line 2: bad value for IS/.test(m))).toBe(true);
  });

  it('keeps pasted models through project validation, with a size cap', () => {
    const p = normalizeProject({ components: [esp, comp('d1', 'diode', { spice: '.model X D(IS=1e-9)' }), comp('d2', 'diode', { spice: 'x'.repeat(60_000) })], wires: [] }, DEFS);
    expect(p.components.find((c) => c.id === 'd1')!.props.spice).toBe('.model X D(IS=1e-9)');
    expect(p.components.find((c) => c.id === 'd2')!.props.spice).toBe('');
  });
});
