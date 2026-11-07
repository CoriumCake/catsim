import { describe, expect, it } from 'vitest';
import { parseNetlist, spiceNumber, SpiceError } from '../../src/analog/parser.ts';
import { toNetlist } from '../../src/analog/spice.ts';
import { Circuit, Simulation } from '../../src/analog/circuit.ts';
import { Bjt, Mosfet } from '../../src/analog/devices.ts';
import { dc, square } from '../../src/analog/waveform.ts';

const op = (src: string, opts = {}) => { const p = parseNetlist(src, opts); const s = new Simulation(p.circuit); s.dcOp(); return { ...p, s, v: (n: string) => s.nodeV(p.nodes.get(n)!) }; };

describe('SPICE numbers', () => {
  it.each([['4.7k', 4700], ['10uF', 1e-5], ['2MEG', 2e6], ['3m', 3e-3], ['1e-3', 1e-3], ['5V', 5], ['100ohm', 100], ['.5n', 5e-10], ['1mil', 25.4e-6], ['-2.5', -2.5]])('%s', (s, v) => {
    expect(spiceNumber(s)).toBeCloseTo(v, 15);
  });
  it('rejects garbage', () => { expect(spiceNumber('abc')).toBeNaN(); expect(spiceNumber('')).toBeNaN(); });
});

describe('netlist parser', () => {
  it('parses a divider with comments, continuation and a title', () => {
    const r = op(`Divider test
* a comment
V1 in 0 DC 5   ; inline comment
R1 in mid
+ 1k
R2 mid gnd 3k
.op
.end
R3 ignored 0 1`, { firstLineIsTitle: true });
    expect(r.title).toBe('Divider test');
    expect(r.v('mid')).toBeCloseTo(3.75, 6);
  });

  it('parses models and semiconductors', () => {
    const r = op(`V1 vcc 0 5
VB in 0 3.3
RB in b 1k
RC vcc c 330
Q1 c b 0 Q2N2222
VG g 0 5
RD vcc d 100
M1 d g 0 0 MN W=2 L=1
D1 vcc dx DLED
RX dx 0 1k
.model Q2N2222 NPN(IS=1e-14 BF=200)
.model MN NMOS (LEVEL=1 VTO=2 KP=0.05)
.model DLED D IS=1e-18 N=2`);
    expect(r.v('c')).toBeLessThan(0.2);
    expect(r.v('d')).toBeLessThan(0.3);
    expect(r.v('dx')).toBeGreaterThan(2.5);
  });

  it('expands subcircuits with private internal nodes', () => {
    const r = op(`.subckt halver in out
R1 in mid 1k
R2 mid 0 1k
E1 out 0 mid 0 1
.ends
V1 a 0 8
X1 a b halver
X2 b c halver
`);
    expect(r.v('b')).toBeCloseTo(4, 6);
    expect(r.v('c')).toBeCloseTo(2, 6);
    expect(r.nodes.has('x1.mid') && r.nodes.has('x2.mid')).toBe(true);
  });

  it('parses PULSE and SIN sources', () => {
    const p = parseNetlist('V1 a 0 PULSE(0 3.3 0 1u 1u 0.5m 1m)\nV2 b 0 SIN(1 2 50 0)\nR1 a 0 1k\nR2 b 0 1k');
    const [v1, v2] = p.circuit.elements as unknown as Array<{ wave: { kind: string } }>;
    expect(v1.wave).toMatchObject({ kind: 'pulse', v2: 3.3, per: 1e-3 });
    expect(v2.wave).toMatchObject({ kind: 'sin', vo: 1, va: 2, freq: 50 });
  });

  it('round-trips the exporter', () => {
    const c = new Circuit(); const g = c.node(), b = c.node(), col = c.node(), v5 = c.node(), d = c.node();
    c.vsource(g, 0, square(3.3, 1000, 0.5), 30); c.vsource(v5, 0, dc(5)); c.resistor(g, b, 1000); c.resistor(v5, col, 330);
    c.add(new Bjt(col, b, 0, { type: 'npn', is: 1e-14, bf: 150, br: 2, vaf: 80 }));
    c.resistor(v5, d, 100); c.add(new Mosfet(d, g, 0, { type: 'nmos', vto: 1.8, kp: 0.2, lambda: 0.01 }));
    c.diode(v5, 0, { is: 1e-14, n: 1.2, rs: 2 });
    const a = new Simulation(c); a.dcOp(0);
    const p = parseNetlist(toNetlist(c));
    const s = new Simulation(p.circuit); s.dcOp(0);
    for (const n of [b, col, d]) expect(s.nodeV(p.nodes.get(String(n))!)).toBeCloseTo(a.nodeV(n), 6);
  });

  it('reports errors with line numbers', () => {
    const bad: Array<[string, RegExp]> = [
      ['R1 a 0 1k\nQ1 c b e NOPE', /line 2: Q1: unknown model/],
      ['R1 a 0 abc', /line 1: R1: bad value/],
      ['Z1 a 0 1', /line 1: unsupported element/],
      ['X1 a b sub', /unknown subcircuit/],
      ['.subckt s a\nR1 a 0 1', /missing \.ends/],
      ['M1 d g s b MN\n.model MN NMOS(LEVEL=3)', /LEVEL=1/],
    ];
    for (const [src, re] of bad) expect(() => parseNetlist(src)).toThrow(re);
    try { parseNetlist('R1 a 0 1k\nR2 a'); } catch (e) { expect(e).toBeInstanceOf(SpiceError); expect((e as SpiceError).line).toBe(2); }
  });

  it('caps runaway recursion', () => {
    expect(() => parseNetlist('.subckt s a\nX1 a s\n.ends\nX1 n s')).toThrow(/nested too deeply/);
  });
});
