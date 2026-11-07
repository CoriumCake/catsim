/* Runs every example through the full runtime + analog engine and checks it is electrically sound:
 * no LED burns out, no GPIO is overloaded, no runtime or convergence errors. */
import { describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { EXAMPLES } from '../../src/examples.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKIP = new Set(['http']); // needs the internet
const INTENTIONALLY_BROKEN = new Set(['noresistor']);

async function runExample(key: string, ms: number) {
  const ex = EXAMPLES.find((e) => e.key === key)!;
  const host = {
    project: { name: ex.name, code: ex.code, components: structuredClone(ex.components), wires: ex.wires.map((w, i) => ({ id: 'w' + i, ...w })) },
    logs: [] as Array<[string, string]>, errors: [] as unknown[],
    log(m: string, level = 'info') { host.logs.push([level, m]); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.analog = new AnalogBridge(sim);
  sim.setSpeed(4);
  sim.start(ex.code);
  for (let t = 0; t < ms; t += 50) { await wait(50); sim.touch(); }
  sim.stop(true);
  return { sim, host };
}

describe('examples are electrically sound', () => {
  for (const ex of EXAMPLES) {
    if (SKIP.has(ex.key) || INTENTIONALLY_BROKEN.has(ex.key)) continue;
    it(ex.key, async () => {
      const { sim, host } = await runExample(ex.key, 500); // ≈ 2 s of simulated time
      expect(host.errors).toEqual([]);
      expect(sim.analog.error).toBeNull();
      expect([...sim.analog.burnt]).toEqual([]);
      expect(host.logs.filter(([lvl, m]) => lvl !== 'info' && /burned out|is carrying|Analog simulation stopped/.test(m))).toEqual([]);
    });
  }

  it('the burnout example really burns its unprotected LED (and only that one)', async () => {
    const { sim } = await runExample('noresistor', 400);
    expect([...sim.analog.burnt]).toEqual(['led1']);
  });
});
