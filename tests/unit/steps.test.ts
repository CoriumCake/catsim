/* "Build it yourself": the wires are taken out and each one ticks itself when its pins are joined again. */
import { describe, expect, it } from 'vitest';
import { startGuide, stopGuide, guideProgress, showAnswer } from '../../src/steps.ts';
import { normalizeProject } from '../../src/project.ts';
import { DEFS } from '../../src/components.js';
import { EXAMPLES } from '../../src/examples.js';
import type { Project } from '../../src/types.ts';

const fromExample = (key: string): Project => {
  const ex = EXAMPLES.find((e) => e.key === key)!;
  return normalizeProject({ name: ex.name, code: ex.code, components: structuredClone(ex.components), wires: ex.wires.map((w, i) => ({ id: 'w' + (i + 1), ...w })) }, DEFS);
};
const wire = (p: Project, from: string, to: string) => p.wires.push({ id: 'u' + p.wires.length, from, to });

describe('build it yourself', () => {
  it('takes the wires out and lists one step per wire, named by part and pin', () => {
    const p = fromExample('blink');
    expect(guideProgress(p, DEFS)).toBeNull();
    startGuide(p);
    expect(p.wires).toEqual([]);
    const g = guideProgress(p, DEFS)!;
    expect(g.steps.map((s) => s.text)).toEqual(['Wire esp pin D23 to r1 pin 1', 'Wire r1 pin 2 to led1 pin A (+)', 'Wire led1 pin C (−) to esp pin GND']);
    expect([g.done, g.wrong]).toEqual([0, []]);
  });
  it('ticks a step when its pins are joined, in either direction or through another pin of the same net', () => {
    const p = fromExample('blink'); startGuide(p);
    wire(p, 'r1:1', 'esp:D23'); // drawn the other way round
    expect(guideProgress(p, DEFS)!.steps.map((s) => s.done)).toEqual([true, false, false]);
    wire(p, 'led1:C', 'esp:GND.L'); // the goal names GND.R: the board joins its GND pins
    expect(guideProgress(p, DEFS)!.steps.map((s) => s.done)).toEqual([true, false, true]);
  });
  it('points out a wire that joins pins the circuit keeps apart', () => {
    const p = fromExample('blink'); startGuide(p);
    wire(p, 'esp:D23', 'led1:A'); // skips the resistor
    const g = guideProgress(p, DEFS)!;
    expect(g.wrong).toEqual(['esp pin D23 to led1 pin A (+)']);
    expect(g.done).toBe(0);
  });
  it('the answer adds only the wires still missing, and then every step is done', () => {
    const p = fromExample('blink'); startGuide(p);
    wire(p, 'esp:D23', 'r1:1');
    expect(showAnswer(p, DEFS)).toBe(2);
    expect(new Set(p.wires.map((w) => w.id)).size).toBe(3);
    const g = guideProgress(p, DEFS)!;
    expect([g.done, g.steps.length, g.wrong]).toEqual([3, 3, []]);
    expect(showAnswer(p, DEFS)).toBe(0);
  });
  it('every example can be rebuilt: the answer completes all of its steps', () => {
    for (const ex of EXAMPLES) {
      const p = fromExample(ex.key); if (!p.wires.length) continue;
      const n = p.wires.length;
      startGuide(p); showAnswer(p, DEFS);
      const g = guideProgress(p, DEFS)!;
      expect([ex.key, g.done, g.wrong]).toEqual([ex.key, n, []]);
    }
  });
  it('a build in progress survives saving and share links; goal wires to pins that do not exist are dropped', () => {
    const p = fromExample('blink'); startGuide(p);
    const again = normalizeProject(JSON.parse(JSON.stringify(p)), DEFS);
    expect(again.guide!.wires.map((w) => [w.from, w.to])).toEqual(p.guide!.wires.map((w) => [w.from, w.to]));
    const bad = normalizeProject({ ...JSON.parse(JSON.stringify(p)), guide: { wires: [{ from: 'esp:D23', to: 'ghost:1' }, { from: '"><img>', to: 'r1:1' }] } }, DEFS);
    expect(bad.guide).toBeUndefined();
  });
  it('stopping forgets the goal and keeps what was built', () => {
    const p = fromExample('blink'); startGuide(p); wire(p, 'esp:D23', 'r1:1'); stopGuide(p);
    expect(guideProgress(p, DEFS)).toBeNull();
    expect(p.wires.length).toBe(1);
  });
});
