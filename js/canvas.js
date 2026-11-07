/* CatSim — diagram canvas: parts, wires, pan/zoom, selection, wiring. */
(function (NS) {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DIRS = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
  const WIRE_COLORS = ['#2ecc71', '#3d8bff', '#f39c12', '#b06cff', '#ffd60a', '#1abc9c', '#ff6b9a', '#e8eaed'];
  NS.WIRE_COLORS = WIRE_COLORS;

  class Canvas {
    constructor(app, svg) {
      this.app = app; this.svg = svg;
      this.vp = svg.querySelector('#cs-viewport');
      this.grid = svg.querySelector('#cs-grid');
      this.wiresG = svg.querySelector('#cs-wires');
      this.compsG = svg.querySelector('#cs-comps');
      this.temp = svg.querySelector('#cs-temp');
      this.view = { x: 0, y: 0, k: 1 };
      this.sel = null; this.wireStart = null; this.drag = null; this.pan = null; this.pressing = null;
      this.cache = new Map();
      this.bind();
    }

    get project() { return this.app.project; }
    def(c) { return NS.DEFS[c.type]; }

    toLocal(e) {
      const r = this.svg.getBoundingClientRect();
      return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k };
    }

    applyView() {
      const { x, y, k } = this.view;
      this.vp.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
      this.grid.setAttribute('patternTransform', `translate(${x} ${y}) scale(${k})`);
      this.app.onZoom(k);
    }

    zoomAt(factor, cx, cy) {
      const k = Math.min(3, Math.max(0.25, this.view.k * factor));
      const f = k / this.view.k;
      this.view.x = cx - (cx - this.view.x) * f; this.view.y = cy - (cy - this.view.y) * f; this.view.k = k;
      this.applyView();
    }

    zoomCenter(factor) { const r = this.svg.getBoundingClientRect(); this.zoomAt(factor, r.width / 2, r.height / 2); }

    fit() {
      const cs = this.project.components; if (!cs.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of cs) { const d = this.def(c); if (!d) continue; x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + d.w); y1 = Math.max(y1, c.y + d.h); }
      const r = this.svg.getBoundingClientRect(); const pad = 50;
      if (r.width < 50 || r.height < 50) return;
      const k = Math.min(1.6, Math.max(0.3, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0))));
      this.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
      this.applyView();
    }

    centerPoint() {
      const r = this.svg.getBoundingClientRect();
      return { x: (r.width / 2 - this.view.x) / this.view.k, y: (r.height / 2 - this.view.y) / this.view.k };
    }

    pinPos(ref) {
      const [id, pid] = ref.split(':');
      const c = this.project.components.find((x) => x.id === id); if (!c) return null;
      const p = this.def(c).pins.find((x) => x.id === pid); if (!p) return null;
      return { x: c.x + p.x, y: c.y + p.y, dir: p.dir, pin: p, comp: c };
    }

    wirePath(a, b) {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const d = Math.min(110, Math.max(18, dist * 0.42));
      const da = DIRS[a.dir] || [0, 0]; const db = DIRS[b.dir] || [0, 0];
      return `M${a.x} ${a.y} C${a.x + da[0] * d} ${a.y + da[1] * d} ${b.x + db[0] * d} ${b.y + db[1] * d} ${b.x} ${b.y}`;
    }

    wireColor(w, i) {
      if (w.color) return w.color;
      const kinds = [w.from, w.to].map((r) => { const p = this.pinPos(r); return p && (p.pin.kind || (/^GND/.test(p.pin.id) ? 'gnd' : /^(VCC|V\+)$/.test(p.pin.id) ? 'vcc' : '')); });
      if (kinds.includes('gnd')) return '#5c6370';
      if (kinds.includes('vcc')) return '#ff4d4d';
      return WIRE_COLORS[i % 6];
    }

    // ---------- rendering ----------
    renderAll() {
      this.cache.clear();
      this.compsG.textContent = '';
      const connected = new Set(this.project.wires.flatMap((w) => [w.from, w.to]));
      for (const c of this.project.components) {
        const d = this.def(c); if (!d) continue;
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('class', `cs-comp${d.interactive ? ' cs-interactive' : ''}`);
        g.dataset.id = c.id;
        g.setAttribute('transform', `translate(${c.x} ${c.y})`);
        let pins = '';
        for (const p of d.pins) {
          const key = `${c.id}:${p.id}`;
          pins += `<g class="cs-pin${connected.has(key) ? ' cs-connected' : ''}" data-ref="${key}"><circle cx="${p.x}" cy="${p.y}" r="7" class="cs-pin-hit"/><rect x="${p.x - 3}" y="${p.y - 3}" width="6" height="6" rx="1.2" class="cs-pin-dot"/><title>${NS.esc(p.title || p.label)}</title></g>`;
        }
        g.innerHTML = `<rect class="cs-sel" x="-6" y="-6" width="${d.w + 12}" height="${d.h + 12}" rx="6"/><g class="cs-body"></g><text class="cs-id" x="${d.w / 2}" y="${d.h + 16}">${NS.esc(c.id)}</text><g class="cs-pins">${pins}</g>`;
        this.compsG.appendChild(g);
      }
      this.renderWires();
      this.renderDynamic(true);
      this.renderSelection();
    }

    renderWires() {
      let html = '';
      this.project.wires.forEach((w, i) => {
        const a = this.pinPos(w.from), b = this.pinPos(w.to);
        if (!a || !b) return;
        const d = this.wirePath(a, b); const col = this.wireColor(w, i);
        const sel = this.sel && this.sel.kind === 'wire' && this.sel.id === w.id;
        html += `<g class="cs-wire${sel ? ' cs-selected' : ''}" data-id="${w.id}"><path d="${d}" class="cs-wire-hit"/><path d="${d}" class="cs-wire-under"/><path d="${d}" class="cs-wire-line" stroke="${col}"/></g>`;
      });
      this.wiresG.innerHTML = html;
    }

    renderDynamic(force) {
      const sim = this.app.sim;
      for (const g of this.compsG.children) {
        const c = this.project.components.find((x) => x.id === g.dataset.id); if (!c) continue;
        const d = this.def(c);
        let svg;
        try { svg = d.render(c, d.state ? d.state(c, sim) : {}); } catch (e) { console.error(e); continue; }
        if (!force && this.cache.get(c.id) === svg) continue;
        this.cache.set(c.id, svg);
        g.querySelector('.cs-body').innerHTML = svg;
      }
    }

    updateComp(c) {
      const g = this.compsG.querySelector(`.cs-comp[data-id="${CSS.escape(c.id)}"]`);
      if (g) g.setAttribute('transform', `translate(${c.x} ${c.y})`);
    }

    renderSelection() {
      for (const g of this.compsG.children) g.classList.toggle('cs-selected', !!(this.sel && this.sel.kind === 'comp' && this.sel.id === g.dataset.id));
      for (const g of this.wiresG.children) g.classList.toggle('cs-selected', !!(this.sel && this.sel.kind === 'wire' && this.sel.id === g.dataset.id));
      this.app.onSelection(this.sel);
    }

    select(sel) { this.sel = sel; this.renderSelection(); }

    // ---------- wiring ----------
    startWire(ref) {
      this.wireStart = ref;
      this.svg.classList.add('cs-wiring');
      this.compsG.querySelectorAll(`.cs-pin[data-ref="${CSS.escape(ref)}"]`).forEach((p) => p.classList.add('cs-active'));
      this.app.hint(`Wiring from <b>${NS.esc(ref)}</b> — click another pin to connect · <kbd>Esc</kbd> to cancel`);
    }

    cancelWire() {
      this.wireStart = null; this.temp.setAttribute('d', '');
      this.svg.classList.remove('cs-wiring');
      this.compsG.querySelectorAll('.cs-pin.cs-active').forEach((p) => p.classList.remove('cs-active'));
      this.app.hint('');
    }

    // ---------- events ----------
    bind() {
      const svg = this.svg;
      svg.addEventListener('pointerdown', (e) => this.onDown(e));
      window.addEventListener('pointermove', (e) => this.onMove(e));
      window.addEventListener('pointerup', (e) => this.onUp(e));
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      svg.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      svg.addEventListener('drop', (e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData('text/catsim-part'); if (!type) return;
        const p = this.toLocal(e); const d = NS.DEFS[type];
        this.app.addComponent(type, p.x - d.w / 2, p.y - d.h / 2);
      });
    }

    onDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const pin = e.target.closest('.cs-pin');
      const wire = e.target.closest('.cs-wire');
      const comp = e.target.closest('.cs-comp');
      if (pin) {
        e.stopPropagation();
        const ref = pin.dataset.ref;
        if (!this.wireStart) this.startWire(ref);
        else if (this.wireStart === ref) this.cancelWire();
        else { const from = this.wireStart; this.cancelWire(); this.app.addWire(from, ref); }
        return;
      }
      if (this.wireStart) { this.cancelWire(); }
      if (wire) { this.select({ kind: 'wire', id: wire.dataset.id }); return; }
      if (comp) {
        const c = this.project.components.find((x) => x.id === comp.dataset.id);
        const d = this.def(c);
        this.select({ kind: 'comp', id: c.id });
        if (this.app.sim.running && d.interactive === 'press') {
          this.pressing = c.id; this.app.sim.setPressed(c.id, true); this.renderDynamic();
          return;
        }
        const p = this.toLocal(e);
        this.drag = { c, dx: p.x - c.x, dy: p.y - c.y, sx: e.clientX, sy: e.clientY, moved: false };
        svg_capture(this.svg, e);
        return;
      }
      this.select(null);
      this.pan = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.classList.add('cs-panning');
      svg_capture(this.svg, e);
    }

    onMove(e) {
      if (this.wireStart) {
        const a = this.pinPos(this.wireStart); const p = this.toLocal(e);
        if (a) this.temp.setAttribute('d', this.wirePath(a, { x: p.x, y: p.y, dir: '' }));
      }
      if (this.drag) {
        const dr = this.drag;
        if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 3) return;
        dr.moved = true;
        const p = this.toLocal(e);
        dr.c.x = Math.round((p.x - dr.dx) / 5) * 5; dr.c.y = Math.round((p.y - dr.dy) / 5) * 5;
        this.updateComp(dr.c); this.renderWires();
      } else if (this.pan) {
        this.view.x = this.pan.vx + (e.clientX - this.pan.sx);
        this.view.y = this.pan.vy + (e.clientY - this.pan.sy);
        this.applyView();
      }
    }

    onUp() {
      if (this.pressing) { this.app.sim.setPressed(this.pressing, false); this.pressing = null; this.renderDynamic(); }
      if (this.drag) { if (this.drag.moved) this.app.changed({ structure: false }); this.drag = null; }
      if (this.pan) { this.pan = null; this.svg.classList.remove('cs-panning'); }
    }
  }

  function svg_capture(svg, e) { try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }

  NS.Canvas = Canvas;
})(window.CatSim = window.CatSim || {});
