/* CatSim — oscilloscope panel. Up to four channels probe circuit nets; samples come from the analog
 * engine in the worker (one point per accepted solver step). Roll mode or edge trigger on CH1. */

export const SCOPE_COLORS = ['#f5b301', '#3d8bff', '#22c55e', '#e5484d'];
const TIMEBASES = [10e-6, 20e-6, 50e-6, 100e-6, 200e-6, 500e-6, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 100e-3, 200e-3, 500e-3, 1];
const VOLTS = [0.1, 0.2, 0.5, 1, 2];
const DIV_X = 10, DIV_Y = 8;
const MAX_POINTS = 400_000;

export interface NetOption { value: string; label: string }

export interface ScopeHost {
  setProbes(refs: Array<string | null>, dtMax: number): void;
  simTime(): number;
}

const fmtTime = (s: number) => (s >= 1 ? `${+s.toPrecision(3)} s` : s >= 1e-3 ? `${+(s * 1e3).toPrecision(3)} ms` : `${+(s * 1e6).toPrecision(3)} µs`);
const fmtV = (v: number) => `${v.toFixed(2)} V`;

export class Scope {
  private t: number[] = [];
  private v: number[][] = [[], [], [], []];
  private probes: Array<string | null> = [null, null, null, null];
  tdiv = 1e-3;
  vdiv = 0.5;
  trigger: 'auto' | 'rise' | 'fall' = 'rise';
  hold = false;
  private ctx: CanvasRenderingContext2D;
  private dirty = true;

  constructor(private readonly root: HTMLElement, private readonly host: ScopeHost) {
    root.innerHTML = `
      <div class="scope-bar">
        ${[0, 1, 2, 3].map((i) => `<label class="scope-ch" style="--ch:${SCOPE_COLORS[i]}"><span>CH${i + 1}</span><select data-ch="${i}" aria-label="Channel ${i + 1} net"><option value="">off</option></select></label>`).join('')}
        <label class="scope-ctl">Time<select data-ctl="tdiv">${TIMEBASES.map((t) => `<option value="${t}"${t === this.tdiv ? ' selected' : ''}>${fmtTime(t)}/div</option>`).join('')}</select></label>
        <label class="scope-ctl">Volts<select data-ctl="vdiv">${VOLTS.map((v) => `<option value="${v}"${v === this.vdiv ? ' selected' : ''}>${v} V/div</option>`).join('')}</select></label>
        <label class="scope-ctl">Trigger<select data-ctl="trigger"><option value="rise" selected>CH1 rising</option><option value="fall">CH1 falling</option><option value="auto">Roll (none)</option></select></label>
        <button class="btn btn-sm" data-ctl="hold" aria-pressed="false">Hold</button>
      </div>
      <div class="scope-screen"><canvas aria-label="Oscilloscope display"></canvas><div class="scope-empty">Pick a net for CH1 above, then start the simulation.</div></div>
      <div class="scope-meas"></div>`;
    this.ctx = root.querySelector('canvas')!.getContext('2d')!;
    root.querySelectorAll<HTMLSelectElement>('select[data-ch]').forEach((s) => s.addEventListener('change', () => {
      this.probes[+s.dataset.ch!] = s.value || null; this.applyProbes();
    }));
    root.querySelector<HTMLSelectElement>('[data-ctl="tdiv"]')!.addEventListener('change', (e) => { this.tdiv = +(e.target as HTMLSelectElement).value; this.applyProbes(false); });
    root.querySelector<HTMLSelectElement>('[data-ctl="vdiv"]')!.addEventListener('change', (e) => { this.vdiv = +(e.target as HTMLSelectElement).value; this.dirty = true; });
    root.querySelector<HTMLSelectElement>('[data-ctl="trigger"]')!.addEventListener('change', (e) => { this.trigger = (e.target as HTMLSelectElement).value as Scope['trigger']; this.dirty = true; });
    const hold = root.querySelector<HTMLButtonElement>('[data-ctl="hold"]')!;
    hold.addEventListener('click', () => { this.hold = !this.hold; hold.setAttribute('aria-pressed', String(this.hold)); hold.classList.toggle('on', this.hold); this.dirty = true; });
    new ResizeObserver(() => { this.dirty = true; }).observe(root.querySelector('.scope-screen')!);
  }

  get activeProbes(): Array<string | null> { return this.probes; }

  /** Solver step limit that keeps traces smooth at the current timebase. */
  private dtMax(): number { return Math.min(1e-3, Math.max(1e-7, this.tdiv / 25)); }

  private applyProbes(clear = true): void {
    if (clear) this.clear();
    this.host.setProbes(this.probes, this.dtMax());
    this.root.querySelector<HTMLElement>('.scope-empty')!.hidden = this.probes.some(Boolean);
    this.dirty = true;
  }

  clear(): void { this.t = []; this.v = [[], [], [], []]; this.dirty = true; }

  /** Refresh the net choices (after wiring changes). Keeps current selections when they still exist. */
  setNets(nets: NetOption[]): void {
    this.root.querySelectorAll<HTMLSelectElement>('select[data-ch]').forEach((s) => {
      const cur = s.value;
      s.textContent = '';
      s.append(new Option('off', ''));
      for (const n of nets) s.append(new Option(n.label, n.value));
      s.value = nets.some((n) => n.value === cur) ? cur : '';
      const i = +s.dataset.ch!;
      if (s.value !== cur) { this.probes[i] = s.value || null; }
    });
  }

  /** Select a net on a channel programmatically (e.g. from a "probe" action). */
  probe(ch: number, ref: string): void {
    const s = this.root.querySelector<HTMLSelectElement>(`select[data-ch="${ch}"]`);
    if (!s || ![...s.options].some((o) => o.value === ref)) return;
    s.value = ref; this.probes[ch] = ref; this.applyProbes();
  }

  addSamples(t: Float64Array, v: Float32Array[]): void {
    if (this.hold) return;
    // A restart begins at t = 0 again: drop old data.
    if (t.length && this.t.length && t[0] < this.t[this.t.length - 1] - 1e-9) this.clear();
    for (let i = 0; i < t.length; i++) { this.t.push(t[i]); for (let c = 0; c < 4; c++) this.v[c].push(v[c] ? v[c][i] : NaN); }
    const keep = Math.max(this.tdiv * DIV_X * 3, 0.05);
    const tEnd = this.t[this.t.length - 1];
    let cut = 0;
    while (cut < this.t.length && this.t[cut] < tEnd - keep) cut++;
    if (this.t.length - cut > MAX_POINTS) cut = this.t.length - MAX_POINTS;
    if (cut > 0) { this.t.splice(0, cut); this.v.forEach((a) => a.splice(0, cut)); }
    this.dirty = true;
  }

  private valueAt(ch: number, time: number): number {
    const t = this.t; let lo = 0, hi = t.length - 1;
    if (hi < 0) return NaN;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= time) lo = m; else hi = m; }
    const a = this.v[ch][lo], b = this.v[ch][hi];
    return t[hi] === t[lo] ? b : a + (b - a) * ((time - t[lo]) / (t[hi] - t[lo]));
  }

  /** Window start time: edge trigger on CH1 if found, otherwise roll. */
  private windowStart(): { t0: number; triggered: boolean } {
    const span = this.tdiv * DIV_X, t = this.t, v = this.v[0];
    const tEnd = t[t.length - 1];
    if (this.trigger !== 'auto' && this.probes[0]) {
      const level = this.vdiv * DIV_Y * 0.4;
      for (let i = t.length - 1; i > 0; i--) {
        if (t[i] + span * 0.9 > tEnd) continue; // need a full screen after the trigger
        const rise = v[i - 1] < level && v[i] >= level, fall = v[i - 1] > level && v[i] <= level;
        if ((this.trigger === 'rise' && rise) || (this.trigger === 'fall' && fall)) {
          const tc = t[i - 1] + (t[i] - t[i - 1]) * ((level - v[i - 1]) / (v[i] - v[i - 1] || 1));
          return { t0: tc - this.tdiv, triggered: true };
        }
        if (tEnd - t[i] > span * 4) break;
      }
    }
    return { t0: tEnd - span, triggered: false };
  }

  render(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const cv = this.ctx.canvas, box = cv.parentElement!.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (box.width < 10 || box.height < 10) return;
    if (cv.width !== Math.round(box.width * dpr) || cv.height !== Math.round(box.height * dpr)) {
      cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr);
    }
    const g = this.ctx, W = box.width, H = box.height;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0f1420'; g.fillRect(0, 0, W, H);
    // grid
    g.lineWidth = 1;
    for (let i = 0; i <= DIV_X; i++) { g.strokeStyle = i === DIV_X / 2 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(Math.round((i * W) / DIV_X) + 0.5, 0); g.lineTo(Math.round((i * W) / DIV_X) + 0.5, H); g.stroke(); }
    for (let j = 0; j <= DIV_Y; j++) { g.strokeStyle = j === DIV_Y - 1 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(0, Math.round((j * H) / DIV_Y) + 0.5); g.lineTo(W, Math.round((j * H) / DIV_Y) + 0.5); g.stroke(); }
    g.font = '11px ui-monospace, Menlo, monospace'; g.fillStyle = 'rgba(255,255,255,.45)';
    g.fillText('0 V', 4, ((DIV_Y - 1) * H) / DIV_Y - 4);
    const meas: string[] = [];
    if (this.t.length > 1) {
      const { t0, triggered } = this.windowStart();
      const span = this.tdiv * DIV_X;
      const x = (time: number) => ((time - t0) / span) * W;
      const y = (v: number) => ((DIV_Y - 1) - v / this.vdiv) * (H / DIV_Y);
      const i0 = Math.max(0, this.t.findIndex((tt) => tt >= t0) - 1);
      for (let c = 0; c < 4; c++) {
        if (!this.probes[c]) continue;
        const vs = this.v[c];
        g.strokeStyle = SCOPE_COLORS[c]; g.lineWidth = 1.6; g.beginPath();
        let started = false, vmin = Infinity, vmax = -Infinity, sum = 0, n = 0;
        for (let i = i0; i < this.t.length; i++) {
          const tt = this.t[i]; if (tt > t0 + span) { // finish the line at the screen edge
            const ve = this.valueAt(c, t0 + span); if (started && Number.isFinite(ve)) g.lineTo(W, y(ve));
            break;
          }
          const vv = vs[i]; if (!Number.isFinite(vv)) continue;
          const px = x(tt), py = y(vv);
          if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
          if (tt >= t0) { vmin = Math.min(vmin, vv); vmax = Math.max(vmax, vv); sum += vv; n++; }
        }
        g.stroke();
        if (n) meas.push(`<span style="color:${SCOPE_COLORS[c]}">CH${c + 1}</span> max ${fmtV(vmax)} · min ${fmtV(vmin)} · ${this.freq(c, t0, span)}`);
      }
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.fillText(`${fmtTime(this.tdiv)}/div  ${this.vdiv} V/div  ${this.hold ? 'HOLD' : triggered ? 'TRIG' : 'ROLL'}`, 6, 14);
      if (triggered) { g.fillStyle = SCOPE_COLORS[0]; const tx = x(t0 + this.tdiv); g.beginPath(); g.moveTo(tx - 5, 0); g.lineTo(tx + 5, 0); g.lineTo(tx, 7); g.fill(); }
    }
    this.root.querySelector('.scope-meas')!.innerHTML = meas.join('<br>');
  }

  /** Frequency from rising crossings of the channel's mid level within the window. */
  private freq(c: number, t0: number, span: number): string {
    const t = this.t, v = this.v[c];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < t.length; i++) if (t[i] >= t0 && t[i] <= t0 + span) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    if (!(hi - lo > 0.2)) return 'DC';
    const mid = (lo + hi) / 2; const xs: number[] = [];
    for (let i = 1; i < t.length; i++) if (t[i] >= t0 && t[i] <= t0 + span && v[i - 1] < mid && v[i] >= mid) xs.push(t[i]);
    if (xs.length < 2) return '—';
    const f = (xs.length - 1) / (xs[xs.length - 1] - xs[0]);
    return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(1)} Hz`;
  }
}
