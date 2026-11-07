import { describe, expect, it } from 'vitest';
import { Circuit, Simulation, VT } from '../../src/analog/circuit.ts';
import { dc, square, valueAt, nextBreak } from '../../src/analog/waveform.ts';

/** Run a transient and sample node `n` at the given times (linear interpolation between steps). */
function sampleTran(sim: Simulation, node: number, times: number[], current?: () => number) {
  const pts: Array<[number, number]> = [[sim.t, current ? current() : sim.nodeV(node)]];
  sim.advanceTo(times[times.length - 1], (t) => pts.push([t, current ? current() : sim.nodeV(node)]));
  return times.map((t) => {
    let i = pts.findIndex((p) => p[0] >= t);
    if (i <= 0) return pts[Math.max(0, i)][1];
    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
    return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
  });
}

describe('waveforms', () => {
  it('evaluates PULSE like SPICE and reports its corners', () => {
    const w = square(3.3, 1000, 0.25); // 1 kHz, 25 % duty
    expect(valueAt(w, 0.0001)).toBeCloseTo(3.3);
    expect(valueAt(w, 0.0003)).toBe(0);
    expect(valueAt(w, 0.0011)).toBeCloseTo(3.3);
    const b1 = nextBreak(w, 0);
    expect(b1).toBeCloseTo(1e-6, 12);
    expect(nextBreak(w, 0.0005)).toBeCloseTo(0.001, 12);
  });
});

describe('DC operating point', () => {
  it('solves a resistive divider', () => {
    const c = new Circuit(); const a = c.node(), m = c.node();
    c.vsource(a, 0, dc(5)); c.resistor(a, m, 1000); c.resistor(m, 0, 3000);
    const s = new Simulation(c); s.dcOp();
    expect(s.nodeV(m)).toBeCloseTo(3.75, 6); // gmin (1e-12 S per node, as in SPICE) shifts it by nanovolts
  });

  it('includes a source series resistance', () => {
    const c = new Circuit(); const a = c.node();
    const v = c.vsource(a, 0, dc(3.3), 30); c.resistor(a, 0, 300);
    const s = new Simulation(c); s.dcOp();
    expect(s.nodeV(a)).toBeCloseTo(3.0, 9);
    expect(v.current(s.x)).toBeCloseTo(0.01, 9);
  });

  it('solves a diode with a resistor (matches the Shockley equation)', () => {
    const is = 1e-14, n = 1, R = 1000, V = 5;
    const c = new Circuit(); const a = c.node(), d = c.node();
    c.vsource(a, 0, dc(V)); c.resistor(a, d, R); c.diode(d, 0, { is, n });
    const s = new Simulation(c); s.dcOp();
    // reference: bisection on (V - vd)/R = Is(exp(vd/nVt) - 1)
    let lo = 0, hi = V;
    for (let i = 0; i < 200; i++) { const vd = (lo + hi) / 2; ((V - vd) / R > is * (Math.exp(vd / (n * VT)) - 1)) ? lo = vd : hi = vd; }
    expect(s.nodeV(d)).toBeCloseTo(lo, 6);
  });

  it('converges for a reverse-biased diode and for diodes in series', () => {
    const c = new Circuit(); const a = c.node(), m1 = c.node(), m2 = c.node(), r = c.node();
    c.vsource(a, 0, dc(3.3)); c.diode(a, m1, { is: 1e-18, n: 2 }); c.diode(m1, m2, { is: 1e-18, n: 2 }); c.resistor(m2, 0, 100);
    c.vsource(r, 0, dc(-5)); c.diode(r, 0, { is: 1e-14, n: 1 });
    const s = new Simulation(c); s.dcOp();
    expect(s.nodeV(m2)).toBeGreaterThanOrEqual(0);
    expect(s.nodeV(m2)).toBeLessThan(0.01); // two 1.6 V+ LEDs need more than 3.3 V
  });

  it('keeps floating nodes defined (gmin)', () => {
    const c = new Circuit(); const a = c.node(), f = c.node();
    c.vsource(a, 0, dc(1)); c.capacitor(a, f, 1e-6);
    const s = new Simulation(c);
    expect(() => s.dcOp()).not.toThrow();
  });
});

describe('transient', () => {
  it('charges an RC circuit like V(1 - e^(-t/RC))', () => {
    const R = 1000, C = 1e-6, tau = R * C;
    const c = new Circuit(); const a = c.node(), o = c.node();
    c.vsource(a, 0, { kind: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-9, tf: 1e-9, pw: 1, per: 2 });
    c.resistor(a, o, R); c.capacitor(o, 0, C);
    const s = new Simulation(c); s.dcOp(0);
    const ts = [0.2, 0.5, 1, 2, 3, 5].map((k) => k * tau);
    const got = sampleTran(s, o, ts);
    ts.forEach((t, i) => expect(got[i]).toBeCloseTo(1 - Math.exp(-t / tau), 2));
    expect(s.stats.steps).toBeLessThan(400);
  });

  it('ramps current in an RL circuit like V/R (1 - e^(-tR/L))', () => {
    const R = 10, L = 1e-3, tau = L / R;
    const c = new Circuit(); const a = c.node(), m = c.node();
    c.vsource(a, 0, { kind: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-9, tf: 1e-9, pw: 1, per: 2 });
    c.resistor(a, m, R); const l = c.inductor(m, 0, L);
    const s = new Simulation(c); s.dcOp(0);
    const ts = [0.5, 1, 2, 4].map((k) => k * tau);
    const got = sampleTran(s, m, ts, () => l.current(s.x));
    ts.forEach((t, i) => expect(got[i]).toBeCloseTo((1 / R) * (1 - Math.exp(-t / tau)), 3));
  });

  it('rings in an underdamped series RLC circuit', () => {
    const R = 10, L = 1e-3, C = 1e-6;
    const a0 = R / (2 * L), w0 = 1 / Math.sqrt(L * C), wd = Math.sqrt(w0 * w0 - a0 * a0);
    const c = new Circuit(); const a = c.node(), m = c.node(), o = c.node();
    c.vsource(a, 0, { kind: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-9, tf: 1e-9, pw: 1, per: 2 });
    c.resistor(a, m, R); c.inductor(m, o, L); c.capacitor(o, 0, C);
    const s = new Simulation(c, { dtMax: 1e-5 }); s.dcOp(0);
    const ts = [0.5e-4, 1e-4, 2e-4, 3e-4, 5e-4];
    const exact = (t: number) => 1 - Math.exp(-a0 * t) * (Math.cos(wd * t) + (a0 / wd) * Math.sin(wd * t));
    const got = sampleTran(s, o, ts);
    ts.forEach((t, i) => expect(Math.abs(got[i] - exact(t))).toBeLessThan(0.01));
  });

  it('follows a sine source through a resistor divider', () => {
    const c = new Circuit(); const a = c.node(), m = c.node();
    c.vsource(a, 0, { kind: 'sin', vo: 0, va: 2, freq: 50, td: 0 }); c.resistor(a, m, 1000); c.resistor(m, 0, 1000);
    const s = new Simulation(c); s.dcOp(0);
    const ts = [0.005, 0.0125, 0.015];
    const got = sampleTran(s, m, ts);
    ts.forEach((t, i) => expect(got[i]).toBeCloseTo(Math.sin(2 * Math.PI * 50 * t), 2));
  });

  it('jumps across flat parts of a PWM signal in resistive circuits', () => {
    const c = new Circuit(); const a = c.node(), d = c.node();
    c.vsource(a, 0, square(3.3, 1000, 0.5), 30); c.resistor(a, d, 220); c.diode(d, 0, { is: 1e-18, n: 2 });
    const s = new Simulation(c); s.dcOp(0);
    let hi = 0, lo = 0;
    s.advanceTo(0.1, () => { if (s.nodeV(a) > 3) hi++; else if (s.nodeV(a) < 0.1) lo++; });
    expect(hi).toBeGreaterThan(90); expect(lo).toBeGreaterThan(90);
    expect(s.stats.newton).toBeLessThan(5000); // ~4 corners per period, a few Newton iterations each
  });

  it('applies a source change at the current time (digitalWrite)', () => {
    const c = new Circuit(); const a = c.node(), o = c.node();
    const v = c.vsource(a, 0, dc(0), 30); c.resistor(a, o, 1000); c.capacitor(o, 0, 1e-6);
    const s = new Simulation(c); s.dcOp(0);
    s.advanceTo(0.001);
    v.wave = dc(3.3); s.markDiscontinuity();
    s.advanceTo(0.001 + 1.03e-3);
    expect(s.nodeV(o)).toBeCloseTo(3.3 * (1 - Math.exp(-1)), 1);
  });
});
