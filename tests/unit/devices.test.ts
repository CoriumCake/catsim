import { describe, expect, it } from 'vitest';
import { Circuit, Simulation, VT } from '../../src/analog/circuit.ts';
import { Bjt, Mosfet, OpAmp, Vcvs, Vccs, LM358 } from '../../src/analog/devices.ts';
import { dc } from '../../src/analog/waveform.ts';

const solve = (c: Circuit) => { const s = new Simulation(c); s.dcOp(); return s; };

describe('BJT', () => {
  const npn = { type: 'npn' as const, is: 1e-14, bf: 100, br: 1 };

  it('in forward-active, Ic = β·Ib and Vbe follows the diode law', () => {
    const c = new Circuit(); const vcc = c.node(), b = c.node(), col = c.node();
    c.vsource(vcc, 0, dc(10)); c.resistor(vcc, b, 1e6); c.resistor(vcc, col, 1000);
    const q = c.add(new Bjt(col, b, 0, npn));
    const s = solve(c);
    const ib = q.baseCurrent(s.x), ic = q.collectorCurrent(s.x);
    expect(ic / ib).toBeCloseTo(100, 1);
    const vbe = s.nodeV(b);
    expect(vbe).toBeCloseTo(VT * Math.log(ic / 1e-14 + 1), 3);
    expect(s.nodeV(col)).toBeGreaterThan(1); // not saturated
  });

  it('saturates as a switch (LED driver)', () => {
    const c = new Circuit(); const v5 = c.node(), g = c.node(), b = c.node(), col = c.node();
    c.vsource(v5, 0, dc(5)); c.vsource(g, 0, dc(3.3), 30);
    c.resistor(g, b, 1000); c.resistor(v5, col, 330);
    const q = c.add(new Bjt(col, b, 0, npn));
    const s = solve(c);
    expect(s.nodeV(col)).toBeLessThan(0.2); // Vce(sat)
    expect(q.collectorCurrent(s.x)).toBeCloseTo((5 - s.nodeV(col)) / 330, 4);
  });

  it('turns off with the base at 0 V', () => {
    const c = new Circuit(); const v5 = c.node(), col = c.node();
    c.vsource(v5, 0, dc(5)); c.resistor(v5, col, 330);
    c.add(new Bjt(col, 0, 0, npn));
    expect(solve(c).nodeV(col)).toBeCloseTo(5, 3);
  });

  it('PNP mirrors the NPN', () => {
    const c = new Circuit(); const vcc = c.node(), b = c.node(), col = c.node();
    c.vsource(vcc, 0, dc(10)); c.resistor(b, 0, 1e6); c.resistor(col, 0, 1000);
    const q = c.add(new Bjt(col, b, vcc, { ...npn, type: 'pnp' }));
    const s = solve(c);
    expect(-q.collectorCurrent(s.x) / -q.baseCurrent(s.x)).toBeCloseTo(100, 1);
    expect(s.nodeV(col)).toBeGreaterThan(0.5);
  });

  it('includes the Early effect', () => {
    const run = (vce: number) => {
      const c = new Circuit(); const b = c.node(), col = c.node();
      c.vsource(b, 0, dc(0.65)); c.vsource(col, 0, dc(vce));
      const q = c.add(new Bjt(col, b, 0, { ...npn, vaf: 50 }));
      const s = solve(c); return q.collectorCurrent(s.x);
    };
    expect(run(10) / run(5)).toBeCloseTo((1 + 9.35 / 50) / (1 + 4.35 / 50), 3);
  });
});

describe('MOSFET (level 1)', () => {
  const nmos = { type: 'nmos' as const, vto: 2, kp: 0.1, lambda: 0 };

  it('follows the square law in saturation', () => {
    const c = new Circuit(); const g = c.node(), d = c.node();
    c.vsource(g, 0, dc(3)); c.vsource(d, 0, dc(5));
    const m = c.add(new Mosfet(d, g, 0, nmos));
    const s = solve(c);
    expect(m.drainCurrent(s.x)).toBeCloseTo(0.5 * 0.1 * 1 * 1, 9);
  });

  it('is resistive in the linear region', () => {
    const c = new Circuit(); const g = c.node(), d = c.node();
    c.vsource(g, 0, dc(5)); c.vsource(d, 0, dc(0.1));
    const m = c.add(new Mosfet(d, g, 0, nmos));
    const s = solve(c);
    expect(m.drainCurrent(s.x)).toBeCloseTo(0.1 * ((3 - 0.05) * 0.1), 9);
  });

  it('switches a load low-side and blocks below threshold', () => {
    const run = (vg: number) => {
      const c = new Circuit(); const v5 = c.node(), g = c.node(), d = c.node();
      c.vsource(v5, 0, dc(5)); c.vsource(g, 0, dc(vg)); c.resistor(v5, d, 100);
      c.add(new Mosfet(d, g, 0, nmos)); return solve(c).nodeV(d);
    };
    expect(run(0)).toBeCloseTo(5, 3);
    expect(run(5)).toBeLessThan(0.3);
  });

  it('conducts in reverse (source and drain swap)', () => {
    const c = new Circuit(); const g = c.node(), d = c.node();
    c.vsource(g, 0, dc(5)); c.vsource(d, 0, dc(-0.1));
    const m = c.add(new Mosfet(d, g, 0, nmos));
    const s = solve(c);
    expect(m.drainCurrent(s.x)).toBeLessThan(0);
  });

  it('PMOS high-side switch', () => {
    const run = (vg: number) => {
      const c = new Circuit(); const v5 = c.node(), g = c.node(), d = c.node();
      c.vsource(v5, 0, dc(5)); c.vsource(g, 0, dc(vg)); c.resistor(d, 0, 100);
      c.add(new Mosfet(d, g, v5, { type: 'pmos', vto: -2, kp: 0.1 })); return solve(c).nodeV(d);
    };
    expect(run(5)).toBeLessThan(0.01);
    expect(run(0)).toBeGreaterThan(4.7);
  });
});

describe('controlled sources and op-amp', () => {
  it('VCVS and VCCS', () => {
    const c = new Circuit(); const i = c.node(), o = c.node(), o2 = c.node();
    c.vsource(i, 0, dc(0.5)); c.add(new Vcvs(o, 0, i, 0, 4)); c.resistor(o, 0, 1000);
    c.add(new Vccs(0, o2, i, 0, 2e-3)); c.resistor(o2, 0, 1000);
    const s = solve(c);
    expect(s.nodeV(o)).toBeCloseTo(2, 9);
    expect(s.nodeV(o2)).toBeCloseTo(1, 6);
  });

  const supply = (c: Circuit) => { const v = c.node(); c.vsource(v, 0, dc(5)); return v; };

  it('voltage follower', () => {
    const c = new Circuit(); const vcc = supply(c), i = c.node(), o = c.node();
    c.vsource(i, 0, dc(1.234)); c.add(new OpAmp(i, o, o, vcc, 0, LM358)); c.resistor(o, 0, 10_000);
    expect(solve(c).nodeV(o)).toBeCloseTo(1.234, 3);
  });

  it('non-inverting amplifier, gain 3', () => {
    const c = new Circuit(); const vcc = supply(c), i = c.node(), o = c.node(), fb = c.node();
    c.vsource(i, 0, dc(0.8)); c.add(new OpAmp(i, fb, o, vcc, 0, LM358));
    c.resistor(o, fb, 20_000); c.resistor(fb, 0, 10_000);
    expect(solve(c).nodeV(o)).toBeCloseTo(2.4, 3);
  });

  it('comparator saturates at the LM358 output swing', () => {
    const run = (vin: number) => {
      const c = new Circuit(); const vcc = supply(c), i = c.node(), r = c.node(), o = c.node();
      c.vsource(i, 0, dc(vin)); c.vsource(r, 0, dc(2.5)); c.add(new OpAmp(i, r, o, vcc, 0, LM358)); c.resistor(o, 0, 10_000);
      return solve(c).nodeV(o);
    };
    expect(run(3)).toBeCloseTo(5 - 1.5, 1);
    expect(run(2)).toBeLessThan(0.05);
  });
});
