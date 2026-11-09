/* Runs every example through the full runtime + analog engine and checks it is electrically sound:
 * no LED burns out, no GPIO is overloaded, no runtime or convergence errors. */
import { describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { EXAMPLES } from '../../src/examples.js';
import { normalizeProject } from '../../src/project.ts';
import { DEFS } from '../../src/components.js';
import { MultiRun } from '../../src/multi.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKIP = new Set(['http']); // needs the internet
const INTENTIONALLY_BROKEN = new Set(['noresistor']);

async function runExample(key: string, ms: number) {
  const ex = EXAMPLES.find((e) => e.key === key)!;
  const host = {
    // load it exactly as the app does (through validation)
    project: normalizeProject({ name: ex.name, code: ex.code, components: structuredClone(ex.components), wires: ex.wires.map((w, i) => ({ id: 'w' + i, ...w })) }, DEFS),
    logs: [] as Array<[string, string]>, errors: [] as unknown[],
    log(m: string, level = 'info') { host.logs.push([level, m]); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sim: any;
  const boards = host.project.components.filter((c) => DEFS[c.type].board);
  if (boards.length > 1) { // several boards: each runs its own program in the shared circuit
    const progs = (ex as { programs?: Record<string, { code?: string }> }).programs || {};
    const m = new MultiRun({ get project() { return host.project; }, log: (msg: string, level?: string) => host.log(msg, level), reportError: (e: unknown) => host.reportError(e) });
    m.start(boards.map((b, i) => ({ id: b.id, type: b.type, code: i === 0 ? ex.code : progs[b.id]?.code})), 4);
    for (let t = 0; t < ms; t += 50) { await wait(50); m.touch(); }
    m.stop();
    return { sim: { analog: m.bridge }, host };
  }
  sim = new Simulator(host);
  if (boards[0]?.type === 'uno' || boards[0]?.type === 'esp32c3') sim.boardType = boards[0].type;
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
      expect(host.logs.filter(([, m]) => /this library isn't available|no OLED|nothing is wired|has no power|no pull-up|isn't connected to anything|wrong way round|barely lights|Short circuit|Not enough current|won't respond|coil gets only/.test(m))).toEqual([]);
    }, 20_000); // PWM into a logic-level driver (L298N) is heavy to simulate at 4× speed
  }

  it('the burnout example really burns its unprotected LED (and only that one)', async () => {
    const { sim } = await runExample('noresistor', 400);
    expect([...sim.analog.burnt]).toEqual(['led1']);
  });
});
