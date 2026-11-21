/* CatSim — "build it yourself": the project's wires are taken out and kept as the goal. Each one is a step that
 * ticks itself when its two pins are joined, by any route (another GND pin of the board, a breadboard row). */
import type { PartDef, Project, Wire } from './types.ts';
import { wireNets } from './analog/nets.ts';

export interface Step { text: string; done: boolean }
export interface Progress {
  steps: Step[];
  /** wires on the canvas that join pins the goal keeps apart */
  wrong: string[];
  done: number;
}

const pinName = (project: Project, defs: Record<string, PartDef>, ref: string): string => {
  const i = ref.indexOf(':'), id = ref.slice(0, i), pin = ref.slice(i + 1);
  const c = project.components.find((x) => x.id === id);
  const label = (c && defs[c.type]?.pins.find((p) => p.id === pin)?.label) || pin;
  return `${id} pin ${label}`;
};

/** Take the wires out and keep them as the goal. */
export function startGuide(project: Project): void {
  if (!project.wires.length) return;
  project.guide = { wires: project.wires };
  project.wires = [];
}

/** Forget the goal; the project stays as built so far. */
export function stopGuide(project: Project): void { delete project.guide; }

/** One step per goal wire, and the wires that don't belong. Null when no build is in progress. */
export function guideProgress(project: Project, defs: Record<string, PartDef>): Progress | null {
  const goal = project.guide?.wires; if (!goal) return null;
  const now = wireNets(project, defs).rootOf;
  const want = wireNets({ ...project, wires: goal }, defs).rootOf;
  const steps = goal.map((w) => ({
    text: `Wire ${pinName(project, defs, w.from)} to ${pinName(project, defs, w.to)}`,
    done: now.get(w.from) !== undefined && now.get(w.from) === now.get(w.to),
  }));
  const wrong = project.wires.filter((w) => want.get(w.from) !== want.get(w.to))
    .map((w) => `${pinName(project, defs, w.from)} to ${pinName(project, defs, w.to)}`);
  return { steps, wrong, done: steps.filter((s) => s.done).length };
}

/** Put back every goal wire whose pins aren't joined yet. Returns how many were added. */
export function showAnswer(project: Project, defs: Record<string, PartDef>): number {
  let added = 0;
  for (const w of project.guide?.wires ?? []) {
    const now = wireNets(project, defs).rootOf;
    if (now.get(w.from) === now.get(w.to)) continue;
    let i = 1; while (project.wires.some((x) => x.id === 'w' + i)) i++;
    const wire: Wire = { id: 'w' + i, from: w.from, to: w.to };
    if (w.color) wire.color = w.color;
    project.wires.push(wire); added++;
  }
  return added;
}
