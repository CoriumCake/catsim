/* Export a Circuit as a SPICE netlist (used to validate the engine against ngspice, and later for
 * an "Export SPICE" feature). Node 0 is ground; other nodes are named by index. */
import { Circuit, Resistor, Capacitor, Inductor, VSource, ISource, Diode, Switch } from './circuit.ts';
import { Bjt, Mosfet, Vcvs, Vccs, OpAmp } from './devices.ts';
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
    else if (e instanceof Bjt) {
      const n = id(), m = e.m;
      lines.push(`Q${n} ${e.c} ${e.b} ${e.e} QM${n}`);
      models.push(`.model QM${n} ${m.type.toUpperCase()}(IS=${num(m.is)} BF=${num(m.bf)} BR=${num(m.br)} NF=${num(m.nf ?? 1)} NR=${num(m.nr ?? 1)}${Number.isFinite(m.vaf ?? Infinity) ? ` VAF=${num(m.vaf!)}` : ''})`);
    } else if (e instanceof Mosfet) {
      const n = id(), m = e.m;
      lines.push(`M${n} ${e.d} ${e.g} ${e.s} ${e.s} MM${n} W=${num(m.w ?? 1)} L=${num(m.l ?? 1)}`);
      models.push(`.model MM${n} ${m.type.toUpperCase()}(LEVEL=1 VTO=${num(m.vto)} KP=${num(m.kp)} LAMBDA=${num(m.lambda ?? 0)})`);
    } else if (e instanceof Vcvs) lines.push(`E${id()} ${e.a} ${e.b} ${e.cp} ${e.cn} ${num(e.gain)}`);
    else if (e instanceof Vccs) lines.push(`G${id()} ${e.a} ${e.b} ${e.cp} ${e.cn} ${num(e.gm)}`);
    else if (e instanceof OpAmp) throw new Error('The behavioural op-amp has no SPICE equivalent');
    else if (e instanceof Diode) {
      const n = id();
      lines.push(`D${n} ${e.a} ${e.k} DM${n}`);
      models.push(`.model DM${n} D(IS=${num(e.m.is)} N=${num(e.m.n)})`);
    }
  }
  return [...lines, ...models].join('\n') + '\n';
}
