/* Every part in the library is in the Parts palette, draws in every state, survives project validation,
 * and runs in a circuit without errors (alone, and with every pin wired to the board). */
import { describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS, PALETTE } from '../../src/components.js';
import { normalizeProject } from '../../src/project.ts';
import { EXAMPLES } from '../../src/examples.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const types = Object.keys(DEFS);
const parts = types.filter((t) => !DEFS[t].board);

describe('every part is available and usable', () => {
  it('every part is in the Parts palette', () => {
    const inPalette = new Set(PALETTE.flatMap((g) => g.types));
    expect(types.filter((t) => !inPalette.has(t))).toEqual([]);
  });

  it('every part has a name, pins with unique ids, a drawing and settings that validate', () => {
    for (const t of types) {
      const d = DEFS[t];
      expect(d.name, t).toBeTruthy();
      expect(new Set(d.pins.map((p) => p.id)).size, t).toBe(d.pins.length);
      const p = normalizeProject({ components: [{ id: 'esp', type: 'esp32', x: 0, y: 0 }, { id: 'x1', type: t, x: 300, y: 300 }], wires: [] }, DEFS);
      const c = p.components.find((x) => x.type === t)!;
      expect(c, t).toBeTruthy();
      expect(() => d.render(c, {}), t).not.toThrow();
      for (const ct of d.controls ?? []) expect(Object.prototype.hasOwnProperty.call(d.props, ct.key), `${t}.${ct.key} has a default`).toBe(true);
    }
  });

  it('every part with its pins wired to the board simulates without errors and draws its live state', async () => {
    const problems: string[] = [];
    for (const t of parts) {
      const d = DEFS[t];
      // wire each pin to a different ESP32 GPIO (or to 3V3 / GND by name), like a first experiment would
      const gpios = ['D23', 'D22', 'D21', 'D19', 'D18', 'D5', 'D4', 'D15', 'D13', 'D12', 'D14', 'D27', 'D26', 'D25', 'D33', 'D32'];
      const wires = d.type === 'breadboard' ? [] : d.pins.slice(0, 16).map((p, i) => ({ id: 'w' + i, from: `x1:${p.id}`, to: /^(GND|VSS|K|-|GND2|B-|IN-|OUT-|COM2)$/.test(p.id) ? 'esp:GND.R' : /^(VCC|VDD|VIN|5V|\+|3V3|12V|V\+)$/.test(p.id) ? 'esp:3V3' : `esp:${gpios[i % gpios.length]}` }));
      const host = {
        project: normalizeProject({ components: [{ id: 'esp', type: 'esp32', x: 0, y: 0 }, { id: 'x1', type: t, x: 400, y: 300 }], wires }, DEFS),
        logs: [] as string[], errors: [] as unknown[],
        log(m: string, l = 'info') { host.logs.push(`${l}: ${m}`); }, reportError(e: unknown) { host.errors.push(e); },
        iotChanged() {}, onSimState() {}, restartSim() {}, nvChanged() {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim: any = new Simulator(host);
      sim.analog = new AnalogBridge(sim);
      sim.start('void setup() {}\nvoid loop() { delay(10); }');
      await wait(40); sim.touch();
      const c = host.project.components[1];
      try { d.render(c, d.state ? d.state(c, sim) : {}); } catch (e) { problems.push(`${t}: render with live state threw ${(e as Error).message}`); }
      if (host.errors.length) problems.push(`${t}: ${String(host.errors[0])}`);
      if (sim.analog.error) problems.push(`${t}: analog engine: ${sim.analog.error}`);
      sim.stop(true);
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('every part appears in at least one example (so it can be found and tried)', () => {
    const inExamples = new Set(EXAMPLES.flatMap((e) => e.components.map((c: { type: string }) => c.type)));
    // (logic chips: the shift-register and 555 examples, plus their own tests)
    const missing = parts.filter((t) => !inExamples.has(t) && !DEFS[t].dip);
    expect(missing).toEqual([]);
  });
});
