/* Serial Plotter, like the Arduino IDE's: every line of numbers the sketch prints becomes one point per series.
 * "12 34", "12,34" or "temp:21.5 hum:40" (labels name the series) all work. */
const COLORS = ['#2563eb', '#ef4444', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
const MAX_POINTS = 500;

export class Plotter {
  constructor(canvas, legend, empty) {
    this.cv = canvas; this.legend = legend; this.empty = empty;
    this.series = new Map(); // label → number[]
    this.partial = ''; this.dirty = true;
  }

  clear() { this.series.clear(); this.partial = ''; this.dirty = true; }

  /** Feed raw serial text (any chunking). */
  feed(text) {
    const lines = (this.partial + text).split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    if (this.partial.length > 2000) this.partial = '';
    for (const line of lines) this.addLine(line);
  }

  addLine(line) {
    const tokens = line.trim().split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) return;
    const vals = [];
    let unnamed = 0;
    for (const t of tokens) {
      const m = t.match(/^([^:]+):(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/i);
      if (m) vals.push([m[1], +m[2]]);
      else if (/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(t)) vals.push([`value ${++unnamed}`, +t]);
      else return; // a text line ("Distance: 12 cm" with words) is not plotted
    }
    for (const [label, v] of vals) {
      let s = this.series.get(label);
      if (!s) { if (this.series.size >= COLORS.length) continue; s = []; this.series.set(label, s); }
      s.push(v); if (s.length > MAX_POINTS) s.shift();
    }
    this.dirty = true;
  }

  render(force) {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const cv = this.cv, r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, padL = 48, padR = 10, padT = 10, padB = 18;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--text').trim() || '#222', grid = css.getPropertyValue('--line').trim() || '#e5e7eb';
    x.clearRect(0, 0, W, H);
    this.empty.hidden = this.series.size > 0;
    this.legend.textContent = '';
    [...this.series.keys()].forEach((k, i) => {
      const s = document.createElement('span'), dot = document.createElement('i');
      dot.style.background = COLORS[i]; s.append(dot, k); this.legend.appendChild(s);
    });
    if (!this.series.size) return;
    let lo = Infinity, hi = -Infinity, n = 0;
    for (const s of this.series.values()) { for (const v of s) { if (v < lo) lo = v; if (v > hi) hi = v; } n = Math.max(n, s.length); }
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo; lo -= span * 0.05; hi += span * 0.05;
    const X = (i) => padL + (i / Math.max(1, MAX_POINTS - 1)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    x.font = '10px ui-monospace, monospace'; x.fillStyle = ink; x.strokeStyle = grid; x.lineWidth = 1; x.textAlign = 'right'; x.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4, y = Y(v);
      x.beginPath(); x.moveTo(padL, y); x.lineTo(W - padR, y); x.stroke();
      x.fillText(Math.abs(v) >= 1000 || Number.isInteger(+v.toFixed(2)) ? v.toFixed(0) : v.toFixed(2), padL - 6, y);
    }
    let i = 0;
    for (const s of this.series.values()) {
      x.strokeStyle = COLORS[i++]; x.lineWidth = 1.6; x.beginPath();
      const off = MAX_POINTS - s.length; // newest point at the right edge
      s.forEach((v, j) => { const px = X(off + j), py = Y(v); if (j) x.lineTo(px, py); else x.moveTo(px, py); });
      x.stroke();
    }
  }
}
