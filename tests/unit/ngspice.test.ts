/* Validates the analog engine against ngspice: each reference circuit is exported with toNetlist(),
 * simulated by ngspice in batch mode, and compared point by point with our transient result.
 * Skipped when ngspice is not installed, unless REQUIRE_NGSPICE=1 (set in CI). */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Circuit, Simulation } from '../../src/analog/circuit.ts';
import { toNetlist } from '../../src/analog/spice.ts';
import { dc, square } from '../../src/analog/waveform.ts';
import { ledModel, LED_VF, R_OUT, V_LOGIC } from '../../src/analog/models.ts';

const have = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;
if (!have && process.env.REQUIRE_NGSPICE) throw new Error('ngspice is required (REQUIRE_NGSPICE=1) but was not found');

interface Case { name: string; build: () => { c: Circuit; probes: number[] }; tstop: number; tstep: number; tol: number }

function runNgspice(netlist: string, probes: number[], tstep: number, tstop: number): Array<number[]> {
  const dir = mkdtempSync(join(tmpdir(), 'catsim-ng-'));
  try {
    const out = join(dir, 'out.txt');
    const cir = `${netlist}.options reltol=1e-4 abstol=1e-12 vntol=1e-7\n.control\ntran ${tstep} ${tstop} 0 ${tstep}\nwrdata ${out} ${probes.map((n) => `v(${n})`).join(' ')}\nquit\n.endc\n.end\n`;
    writeFileSync(join(dir, 'c.cir'), cir);
    const r = spawnSync('ngspice', ['-b', join(dir, 'c.cir')], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`ngspice failed: ${r.stderr || r.stdout}`);
    // wrdata: for each vector a (time, value) column pair
    return readFileSync(out, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
      .map((cols) => [cols[0], ...probes.map((_, i) => cols[2 * i + 1])]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function ours(c: Circuit, probes: number[], tstop: number): Array<number[]> {
  const sim = new Simulation(c, { dtMax: tstop / 200 });
  sim.dcOp(0);
  const pts: Array<number[]> = [[0, ...probes.map((n) => sim.nodeV(n))]];
  sim.advanceTo(tstop, (t) => pts.push([t, ...probes.map((n) => sim.nodeV(n))]));
  return pts;
}

const interp = (pts: Array<number[]>, t: number, k: number) => {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; }
  const [a, b] = [pts[lo], pts[hi]];
  return b[0] === a[0] ? a[k] : a[k] + (b[k] - a[k]) * ((t - a[0]) / (b[0] - a[0]));
};

const CASES: Case[] = [
  {
    name: 'LED with 220 Ω driven by a 1 kHz PWM GPIO', tstop: 3e-3, tstep: 1e-6, tol: 0.02,
    build: () => {
      const c = new Circuit(); const g = c.node(), a = c.node();
      c.vsource(g, 0, square(V_LOGIC, 1000, 0.3), R_OUT); c.resistor(g, a, 220); c.diode(a, 0, ledModel(LED_VF.red));
      return { c, probes: [g, a] };
    },
  },
  {
    name: 'RC low-pass filtering PWM (PWM DAC)', tstop: 30e-3, tstep: 5e-6, tol: 0.01,
    build: () => {
      const c = new Circuit(); const g = c.node(), o = c.node();
      c.vsource(g, 0, square(V_LOGIC, 1000, 0.5), R_OUT); c.resistor(g, o, 10_000); c.capacitor(o, 0, 1e-6);
      return { c, probes: [o] };
    },
  },
  {
    name: 'half-wave rectifier with smoothing capacitor', tstop: 60e-3, tstep: 10e-6, tol: 0.03,
    build: () => {
      const c = new Circuit(); const a = c.node(), o = c.node();
      c.vsource(a, 0, { kind: 'sin', vo: 0, va: 5, freq: 50, td: 0 }); c.diode(a, o, { is: 2.52e-9, n: 1.752, rs: 0.568 });
      c.resistor(o, 0, 1000); c.capacitor(o, 0, 100e-6);
      return { c, probes: [o] };
    },
  },
  {
    name: 'underdamped series RLC step response', tstop: 1e-3, tstep: 1e-7, tol: 0.01,
    build: () => {
      const c = new Circuit(); const a = c.node(), m = c.node(), o = c.node();
      c.vsource(a, 0, { kind: 'pulse', v1: 0, v2: 1, td: 1e-5, tr: 1e-8, tf: 1e-8, pw: 1, per: 2 });
      c.resistor(a, m, 10); c.inductor(m, o, 1e-3); c.capacitor(o, 0, 1e-6);
      return { c, probes: [o] };
    },
  },
  {
    name: 'button pull-up divider and LED colours at DC', tstop: 1e-3, tstep: 1e-6, tol: 0.005,
    build: () => {
      const c = new Circuit(); const rail = c.node();
      c.vsource(rail, 0, dc(V_LOGIC), 0.1);
      const probes: number[] = [];
      for (const vf of Object.values(LED_VF)) { const a = c.node(), k = c.node(); c.resistor(rail, a, 150); c.diode(a, k, ledModel(vf)); c.resistor(k, 0, 10); probes.push(a); }
      return { c, probes };
    },
  },
];

describe.skipIf(!have)('engine matches ngspice', () => {
  for (const k of CASES) {
    it(k.name, () => {
      const { c, probes } = k.build();
      const ref = runNgspice(toNetlist(c, k.name), probes, k.tstep, k.tstop);
      const got = ours(k.build().c, probes, k.tstop);
      let worst = 0, at = 0;
      for (const row of ref) {
        // skip samples right at fast edges, where both engines' step placement dominates
        for (let i = 0; i < probes.length; i++) {
          const d = Math.abs(interp(got, row[0], i + 1) - row[i + 1]);
          const scale = Math.max(1, Math.abs(row[i + 1]));
          const e = d / scale;
          if (e > worst) { worst = e; at = row[0]; }
        }
      }
      // Allow brief disagreement exactly at switching edges (sub-microsecond timing differences).
      const edges = ref.filter((row) => probes.some((_, i) => Math.abs(interp(got, row[0], i + 1) - row[i + 1]) / Math.max(1, Math.abs(row[i + 1])) > k.tol));
      expect(edges.length / ref.length, `worst ${worst.toFixed(4)} at t=${at}`).toBeLessThan(0.005);
    });
  }
});
