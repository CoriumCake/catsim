/* Export a Circuit as a SPICE netlist (used to validate the engine against ngspice, and later for
 * an "Export SPICE" feature). Node 0 is ground; other nodes are named by index. */
import { Circuit, Resistor, Capacitor, Inductor, VSource, ISource, Diode, Switch } from './circuit.ts';
import { toSpice } from './waveform.ts';

const num = (x: number) => x.toPrecision(12);

export function toNetlist(c: Circuit, title = 'CatSim circuit'): string {
  const lines = [`* ${title}`];
  let k = 0, extra = c.nodeCount;
  const id = () => ++k;
  const models: string[] = [];
  for (const e of c.elements) {
    if (e instanceof Resistor) lines.push(`R${id()} ${e.a} ${e.b} ${num(e.r)}`);
    else if (e instanceof Switch) lines.push(`R${id()} ${e.a} ${e.b} ${num(e.closed ? e.ron : e.roff)}`);
    else if (e instanceof Capacitor) lines.push(`C${id()} ${e.a} ${e.b} ${num(e.c)}`);
    else if (e instanceof Inductor) lines.push(`L${id()} ${e.a} ${e.b} ${num(e.l)}`);
    else if (e instanceof VSource) {
      if (e.rs) { const m = extra++; lines.push(`V${id()} ${m} ${e.b} ${toSpice(e.wave)}`, `R${id()} ${e.a} ${m} ${num(e.rs)}`); }
      else lines.push(`V${id()} ${e.a} ${e.b} ${toSpice(e.wave)}`);
    } else if (e instanceof ISource) lines.push(`I${id()} ${e.a} ${e.b} ${toSpice(e.wave)}`);
    else if (e instanceof Diode) {
      const n = id();
      lines.push(`D${n} ${e.a} ${e.k} DM${n}`);
      models.push(`.model DM${n} D(IS=${num(e.m.is)} N=${num(e.m.n)})`);
    }
  }
  return [...lines, ...models].join('\n') + '\n';
}
