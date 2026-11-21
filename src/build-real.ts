/* CatSim — building a project for real: the parts to buy and the sketch file for the Arduino IDE. */
import type { PartDef, Project } from './types.ts';
import { fmtOhms } from './util.ts';

/** What tells two parts of one type apart when you buy them (a resistor's value, an LED's colour). */
const SPEC: Record<string, (p: Record<string, unknown>) => string> = {
  resistor: (p) => fmtOhms(Number(p.ohms) || 220),
  led: (p) => String(p.color ?? 'red'),
  capacitor: (p) => String(p.value ?? ''),
  rgb_led: (p) => `common ${p.common ?? 'anode'}`,
  battery: (p) => String(p.type ?? ''),
  nmos: (p) => String(p.model ?? ''),
  diode: (p) => String(p.model ?? ''),
  bme280: (p) => String(p.model ?? ''),
};

export interface BuyLine { qty: number; name: string }

/** The parts to buy, boards first, then in the order they were placed; equal parts are counted together.
 * Every wire in the diagram is one jumper wire (legs plugged into a breadboard need none). */
export function partsList(project: Project, defs: Record<string, PartDef>): BuyLine[] {
  const lines = new Map<string, BuyLine & { board: boolean }>();
  for (const c of project.components) {
    const d = defs[c.type]; if (!d) continue;
    const spec = SPEC[c.type]?.(c.props ?? {}) ?? '';
    const name = spec ? `${d.name}, ${spec}` : d.name;
    const line = lines.get(name);
    if (line) line.qty++; else lines.set(name, { qty: 1, name, board: !!d.board });
  }
  const out: BuyLine[] = [...lines.values()].sort((a, b) => Number(b.board) - Number(a.board)).map(({ qty, name }) => ({ qty, name }));
  if (project.wires.length) out.push({ qty: project.wires.length, name: 'jumper wire' });
  return out;
}

const IDE_BOARD: Record<string, string> = {
  uno: 'Arduino Uno',
  esp32c3: 'ESP32C3 Dev Module (or "Nologo ESP32C3 Super Mini")',
  esp32: 'ESP32 Dev Module',
};

/** A board's sketch as an .ino file: which board to pick in the IDE, the parts to buy and every wire, as comments. */
export function inoFile(project: Project, boardId: string, code: string, defs: Record<string, PartDef>): string {
  const board = project.components.find((c) => c.id === boardId);
  const parts = partsList(project, defs).map((l) => `//   ${l.qty} × ${l.name}`);
  const wiring = project.wires.map((w) => `//   ${w.from}  ->  ${w.to}`);
  return `// ${project.name} — exported from CatSim for the Arduino IDE\n`
    + `// Board: ${board ? defs[board.type].name : 'board'}  (Tools → Board → ${(board && IDE_BOARD[board.type]) || IDE_BOARD.esp32})\n`
    + '// Libraries used by #include lines: install them with Tools → Manage Libraries.\n'
    + (parts.length ? `// Parts to build it:\n${parts.join('\n')}\n` : '')
    + (wiring.length ? `// Wiring (part:pin  ->  part:pin):\n${wiring.join('\n')}\n` : '')
    + `\n${code}`;
}
