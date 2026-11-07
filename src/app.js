/* CatSim — application shell: editor, palette, panels, persistence. */
import { DEFS, PALETTE } from './components.js';
import { esc } from './util.ts';
import { EXAMPLES } from './examples.js';
import { SimHost } from './sim-host.js';
import { Canvas, WIRE_COLORS } from './canvas.js';
import { View3D } from './view3d.js';
import { createEditor } from './editor.ts';
import { normalizeProject, encodeShare, decodeShare } from './project.ts';
import { Scope } from './scope.ts';
import { wireNets } from './analog/nets.ts';
import { parseIntelHex } from './avr/hex.ts';
const $ = (s) => document.querySelector(s);
const STORE = 'catsim.project.v1';
const VIEW_STORE = 'catsim.view';
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- audio for buzzers ----------
const Audio = {
  ctx: null, osc: new Map(), muted: false,
  ensure() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* no audio */ } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  set(id, f) {
    if (!this.ctx) return;
    let o = this.osc.get(id);
    if (f > 0 && !this.muted) {
      if (!o) {
        const osc = this.ctx.createOscillator(); const g = this.ctx.createGain();
        osc.type = 'square'; g.gain.value = 0.04; osc.connect(g).connect(this.ctx.destination); osc.start();
        o = { osc, g }; this.osc.set(id, o);
      }
      o.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.005);
    } else if (o) { o.osc.stop(); o.osc.disconnect(); this.osc.delete(id); }
  },
  stopAll() { for (const id of [...this.osc.keys()]) this.set(id, 0); },
};

const App = {
  project: null,
  async init() {
    this.sim = new SimHost(this); // sketch runs in a Web Worker
    this.canvas = new Canvas(this, $('#canvas'));
    this.view3d = new View3D(this, $('#stage'));
    this.scope = new Scope($('#scopePane'), {
      setProbes: (refs, dtMax) => this.sim.setProbes(refs, dtMax),
      simTime: () => this.sim.millis() / 1000,
    });
    this.editor = createEditor($('#code'), { onRun: () => this.toggleRun() });
    this.buildPalette(); this.bindUi(); this.bindSplitters();
    this.load(await this.initialProject());
    this.editor.onChange(() => { this.project.code = this.editor.get(); this.save(); });
    requestAnimationFrame(() => this.frame());
    let v = '2d'; try { v = localStorage.getItem(VIEW_STORE) || '2d'; } catch (_) { /* ignore */ }
    if (v === '3d') this.setView('3d');
    window.addEventListener('resize', () => this.editor.refresh());
  },

  async initialProject() {
    if (location.hash.length > 3) {
      try {
        const p = await decodeShare(location.hash);
        if (p) { history.replaceState(null, '', location.pathname); return p; }
      } catch (e) { this.log(`Could not read the shared project link: ${e.message}`, 'warn'); }
    }
    try { const s = localStorage.getItem(STORE); if (s) return JSON.parse(s); } catch (_) { /* storage unavailable */ }
    return this.fromExample('blink');
  },

  fromExample(key) {
    const ex = EXAMPLES.find((e) => e.key === key);
    return { name: ex.name, code: ex.code, components: clone(ex.components), wires: ex.wires.map((w, i) => ({ id: 'w' + (i + 1), ...w })), ...(ex.firmware ? { firmware: { ...ex.firmware } } : {}) };
  },

  normalize(p) { return normalizeProject(p, DEFS); },

  load(p) {
    this.stop();
    this.project = this.normalize(p);
    $('#projectName').value = this.project.name;
    this.editor.set(this.project.code); this.editor.clear();
    this.sim.resetHw(); this.sim.invalidate();
    this.canvas.select(null);
    this.canvas.renderAll();
    requestAnimationFrame(() => this.canvas.fit());
    this.view3d.dirty = true; this.view3d.camFitted = false;
    if (this.view3d.active) requestAnimationFrame(() => this.view3d.fit());
    this.refreshScopeNets(); this.scope.clear(); this.refreshBoardUi();
    this.renderIot(); this.save();
  },

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(this.project)); } catch (_) { /* ignore */ } }, 250);
  },

  changed({ structure = true } = {}) {
    if (structure) { this.sim.invalidate(); this.canvas.renderAll(); this.refreshScopeNets(); }
    this.sim.syncProject();
    this.view3d.dirty = true;
    this.save();
  },

  // ---------- parts & wires ----------
  nextId(type) {
    const base = { led: 'led', resistor: 'r', button: 'btn', pot: 'pot', dht22: 'dht', ldr: 'ldr', pir: 'pir', buzzer: 'bz', servo: 'servo', lcd: 'lcd', npn: 'q', pnp: 'q', nmos: 'm', diode: 'd', opamp: 'u', capacitor: 'c' }[type] || (DEFS[type] && DEFS[type].dip ? 'u' : type);
    let i = 1; while (this.project.components.some((c) => c.id === base + i)) i++;
    return base + i;
  },
  addComponent(type, x, y) {
    const d = DEFS[type];
    if (x === undefined) { const c = this.canvas.centerPoint(); x = c.x - d.w / 2 + (Math.random() * 60 - 30); y = c.y - d.h / 2 + (Math.random() * 60 - 30); }
    const c = { id: this.nextId(type), type, x: Math.round(x / 5) * 5, y: Math.round(y / 5) * 5, props: { ...d.props } };
    this.project.components.push(c);
    this.changed();
    this.canvas.select({ kind: 'comp', id: c.id });
  },
  addWire(from, to) {
    if (from.split(':')[0] === to.split(':')[0] && !DEFS[this.project.components.find((c) => c.id === from.split(':')[0]).type].board) { this.toast('Connect pins of different parts'); return; }
    if (this.project.wires.some((w) => (w.from === from && w.to === to) || (w.from === to && w.to === from))) return;
    let i = 1; while (this.project.wires.some((w) => w.id === 'w' + i)) i++;
    this.project.wires.push({ id: 'w' + i, from, to });
    this.changed();
  },
  deleteSelection() {
    const s = this.canvas.sel; if (!s) return;
    if (s.kind === 'wire') this.project.wires = this.project.wires.filter((w) => w.id !== s.id);
    else {
      const c = this.project.components.find((x) => x.id === s.id);
      if (!c || DEFS[c.type].fixed) { this.toast('The ESP32 board cannot be removed'); return; }
      this.project.components = this.project.components.filter((x) => x.id !== s.id);
      this.project.wires = this.project.wires.filter((w) => !w.from.startsWith(s.id + ':') && !w.to.startsWith(s.id + ':'));
      Audio.set(s.id, 0);
    }
    this.canvas.select(null); this.changed();
  },

  // ---------- simulation ----------
  toggleRun() { if (this.sim.running) this.stop(); else this.start(); },
  start() {
    Audio.ensure();
    this.editor.clear();
    $('#serialOut').textContent = '';
    this.clearConsole();
    this.project.code = this.editor.get();
    if (this.boardType() === 'uno' && !this.project.firmware) {
      this.log('The Arduino Uno runs compiled firmware. Click "Upload .hex" and pick the .hex file (Arduino IDE: Sketch → Export Compiled Binary), or load one of the Uno examples.', 'error');
      this.showTab('bottom', 'consolePane');
      return;
    }
    this.sim.start(this.project.code).then((ok) => { if (ok === false) this.showTab('bottom', 'consolePane'); });
  },
  stop() { if (this.sim && this.sim.running) this.sim.stop(); },
  restartSim() { this.stop(); this.start(); },
  togglePause() {
    if (!this.sim.running) return;
    if (this.sim.paused) this.sim.resume(); else this.sim.pause();
    this.updatePause();
  },
  updatePause() {
    const b = $('#btnPause'), p = this.sim.running && this.sim.paused;
    b.disabled = !this.sim.running;
    b.textContent = p ? '▶' : '⏸';
    b.title = p ? 'Resume simulation' : 'Pause simulation';
    b.setAttribute('aria-label', p ? 'Resume' : 'Pause');
    $('#simDot').classList.toggle('paused', p);
  },
  onSimState(on) {
    const b = $('#btnRun');
    b.classList.toggle('running', on);
    b.querySelector('.ico').textContent = on ? '■' : '▶';
    b.querySelector('.lbl').textContent = on ? 'Stop' : 'Start';
    $('#simDot').classList.toggle('on', on);
    this.updatePause();
    if (!on) { Audio.stopAll(); this.flushSerial(); this.canvas.renderDynamic(); this.updateClock(); this.renderIot(); }
    else this.log('Simulation started', 'info');
  },

  frame() {
    if (this.sim.running) {
      this.canvas.renderDynamic();
      for (const c of this.project.components) {
        if (c.type === 'buzzer') { const s = DEFS.buzzer.state(c, this.sim); Audio.set(c.id, this.sim.paused ? 0 : s.f); }
      }
      this.flushSerial(); this.updateClock();
      if (this._iotDirty) this.renderIot();
      if ($('#scopePane').classList.contains('active')) this.scope.render();
    }
    requestAnimationFrame(() => this.frame());
  },

  onScopeSamples(t, v) { this.scope.addSamples(t, v); },
  boardType() { const b = this.project.components.find((c) => DEFS[c.type] && DEFS[c.type].board); return b ? b.type : 'esp32'; },
  /** Switch the project's microcontroller board. Wires to the old board's pins are removed. */
  setBoard(type) {
    if (type === this.boardType() || !DEFS[type] || !DEFS[type].board) return;
    this.stop();
    const old = this.project.components.find((c) => DEFS[c.type].board);
    const id = type === 'uno' ? 'uno' : 'esp';
    const before = this.project.wires.length;
    if (old) {
      this.project.wires = this.project.wires.filter((w) => !w.from.startsWith(old.id + ':') && !w.to.startsWith(old.id + ':'));
      this.project.components = this.project.components.filter((c) => c !== old);
    }
    this.project.components.unshift({ id, type, x: old ? old.x : 300, y: old ? old.y : 80, props: {} });
    this.changed(); this.refreshBoardUi(); requestAnimationFrame(() => this.canvas.fit());
    const removed = before - this.project.wires.length;
    this.toast(`Switched to ${DEFS[type].name}${removed ? `. ${removed} wire${removed > 1 ? 's' : ''} to the old board removed` : ''}`);
  },
  refreshBoardUi() {
    const uno = this.boardType() === 'uno';
    $('#boardSelect').value = this.boardType();
    document.querySelector('.brand .chip').textContent = uno ? 'UNO' : 'ESP32';
    $('#serialInput').placeholder = `Message to ${uno ? 'Arduino' : 'ESP32'} (Enter to send)`;
    $('#btnFirmware').hidden = !uno;
    const b = $('#unoBanner'); b.hidden = !uno;
    if (uno) {
      const fw = this.project.firmware;
      b.textContent = '';
      const msg = document.createElement('span');
      msg.textContent = fw ? `Running firmware “${fw.name}”. This sketch is shown for reference: edit it in the Arduino IDE, export the compiled binary and upload the .hex.` : 'The Uno runs real compiled firmware. Compile this sketch in the Arduino IDE (Sketch → Export Compiled Binary) and click “Upload .hex”.';
      b.appendChild(msg);
    }
  },
  async loadFirmware(file) {
    if (!file) return;
    if (file.size > 200_000) { this.toast('That file is too large for an ATmega328P'); return; }
    const text = await file.text();
    try {
      const flash = parseIntelHex(text);
      let used = flash.length; while (used > 0 && flash[used - 1] === 0) used--;
      this.stop();
      this.project.firmware = { name: file.name.slice(0, 120), hex: text };
      this.save(); this.refreshBoardUi();
      this.toast(`Loaded ${file.name} (${used.toLocaleString()} bytes)`);
    } catch (e) {
      this.log(`Could not load ${file.name}: ${e.message}`, 'error'); this.showTab('bottom', 'consolePane');
    }
  },
  /** Net choices for the scope, labelled by the pins on each net (ESP32 pins first). */
  refreshScopeNets() {
    const { members } = wireNets(this.project, DEFS);
    const espId = (this.project.components.find((c) => DEFS[c.type].board) || {}).id; // pins of the board are listed by name
    const isEsp = (k) => k.startsWith(espId + ':');
    const opts = [];
    for (const keys0 of members.values()) {
      if (keys0.length < 2) continue; // only nets with something wired
      const keys = [...keys0].sort((a, b) => Number(isEsp(b)) - Number(isEsp(a)));
      const label = keys.map((k) => { const [id, pin] = k.split(':'); return isEsp(k) ? pin : `${id}.${pin}`; }).join(' · ');
      opts.push({ value: keys[0], label: label.length > 42 ? label.slice(0, 41) + '…' : label, wired: 1 });
    }
    opts.sort((a, b) => (b.wired - a.wired) || a.label.localeCompare(b.label, undefined, { numeric: true }));
    this.scope.setNets(opts);
  },
  updateClock() {
    const rtf = this.sim.running && this.sim.analog ? this.sim.analog.rtf / (this.sim.speed || 1) : 1;
    const load = $('#simLoad'); load.hidden = !(rtf < 0.9); if (!load.hidden) load.textContent = `${Math.max(1, Math.round(rtf * 100))}% speed`;
    const ms = Math.floor(this.sim.millis());
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    $('#simTime').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  },

  flushSerial() {
    if (!this.sim.serialOut) return;
    const el = $('#serialOut');
    let t = el.textContent + this.sim.serialOut; this.sim.serialOut = '';
    if (t.length > 60000) t = t.slice(-50000);
    el.textContent = t;
    if ($('#autoScroll').checked) el.scrollTop = el.scrollHeight;
  },

  // ---------- console ----------
  log(msg, level = 'info', line) {
    const out = $('#consoleOut');
    const d = document.createElement('div'); d.className = `log ${level}`;
    const ms = Math.floor(this.sim ? this.sim.millis() : 0);
    d.innerHTML = `<span class="tm">${(ms / 1000).toFixed(3)}s</span><span></span>`;
    d.lastChild.textContent = msg;
    if (line) { const a = document.createElement('a'); a.href = '#'; a.textContent = ` → line ${line}`; a.onclick = (e) => { e.preventDefault(); this.showTab('editor', 'editorPane'); this.editor.focusLine(line); }; d.lastChild.appendChild(a); this.editor.mark(line); }
    out.appendChild(d); while (out.children.length > 300) out.firstChild.remove();
    out.parentElement.scrollTop = out.parentElement.scrollHeight;
    if (level !== 'info' && !$('#consolePane').classList.contains('active')) {
      this._unseen = (this._unseen || 0) + 1;
      const b = $('#consoleBadge'); b.hidden = false; b.textContent = this._unseen;
    }
  },
  clearConsole() { $('#consoleOut').textContent = ''; this._unseen = 0; $('#consoleBadge').hidden = true; },
  reportError(e) {
    const m = String(e && e.stack || '').match(/(?:<anonymous>|Function):(\d+):\d+/);
    const line = m ? +m[1] - 2 : undefined;
    let msg = (e && e.message) || String(e);
    if (/is not defined/.test(msg)) msg += ' — it may be a function or library CatSim does not simulate yet';
    this.log(`Runtime error: ${msg}`, 'error', line > 0 ? line : undefined);
    this.showTab('bottom', 'consolePane');
  },

  // ---------- IoT panel ----------
  iotChanged() { this._iotDirty = true; if (!this.sim.running) this.renderIot(); },
  renderIot() {
    this._iotDirty = false;
    const s = this.sim; const w = s.wifi;
    const wifiEl = $('#iotWifi');
    const ws = !s.running || w.status === 0 ? ['off', ''] : w.status === 3 ? [`connected · ${w.ssid}`, 'ok'] : w.status === 6 ? ['connecting…', 'wait'] : ['failed', ''];
    wifiEl.textContent = ws[0]; wifiEl.className = 'v ' + ws[1];
    $('#iotIp').textContent = s.running && w.status === 3 ? '10.13.37.42' : '—';
    const mq = $('#iotMqtt'); const on = s.running && s.mqtt.connected;
    mq.textContent = on ? `${s.mqtt.clientId} @ ${s.mqtt.host}` : 'disconnected'; mq.className = 'v ' + (on ? 'ok' : '');
    $('#iotSubs').textContent = on && s.mqtt.subs.length ? s.mqtt.subs.join(', ') : '—';
    $('#iotDot').classList.toggle('on', on);
    const topics = [...s.broker.topics.entries()].slice(-12);
    $('#iotTopics').innerHTML = topics.map(([t, v]) => `<button class="topic-card" data-topic="${esc(t)}" title="${esc(t)}"><span class="t">${esc(t)}</span><span class="p">${esc(v.payload)}</span></button>`).join('');
    const log = $('#iotLog');
    if (!s.broker.log.length) {
      log.innerHTML = '<div class="iot-empty">The built-in MQTT broker shows traffic here. Load the <b>IoT: WiFi + MQTT</b> example, start it, then publish <code>ON</code> to <code>catsim/esp32/led</code>.</div>';
    } else {
      log.innerHTML = s.broker.log.slice(-150).map((m) => `<div class="m ${m.from === 'device' ? 'dev' : 'ui'}"><span class="tm">${(m.t / 1000).toFixed(2)}s</span><span class="dir" title="${m.from === 'device' ? 'from ESP32' : 'from dashboard'}">${m.from === 'device' ? '↑' : '↓'}</span><span class="tp">${esc(m.topic)}</span><span class="pl">${esc(m.payload)}</span></div>`).join('');
      log.scrollTop = log.scrollHeight;
    }
  },

  // ---------- UI ----------
  hint(html) { const h = $('#stageHint'); h.innerHTML = html; h.classList.toggle('show', !!html); },
  toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(this._toastT); this._toastT = setTimeout(() => t.classList.remove('show'), 2200); },
  async setView(mode) {
    const b2 = $('#view2d'), b3 = $('#view3d');
    if (mode === '3d') {
      if (this.view3d.active) return;
      b3.disabled = true;
      try { await this.view3d.show(); } catch (e) { console.error(e); b3.disabled = false; this.toast('Could not load the 3D view (offline?)'); return; }
      b3.disabled = false;
      this.canvas.cancelWire && this.canvas.wireStart && this.canvas.cancelWire();
      $('#zoomLabel').textContent = '3D';
      this.hint('Drag to orbit 360° · right-drag to pan · scroll to zoom · switch to 2D to wire parts');
      clearTimeout(this._hintT); this._hintT = setTimeout(() => this.hint(''), 3500);
    } else {
      if (!this.view3d.active) return;
      this.view3d.hide(); this.onZoom(this.canvas.view.k); this.hint('');
    }
    b2.classList.toggle('on', mode !== '3d'); b3.classList.toggle('on', mode === '3d');
    try { localStorage.setItem(VIEW_STORE, mode); } catch (_) { /* ignore */ }
  },
  onZoom(k) { if (this.view3d && this.view3d.active) return; $('#zoomLabel').textContent = Math.round(k * 100) + '%'; },

  showTab(group, id) {
    const tabs = document.querySelector(`.tabs[data-group="${group}"]`);
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
    const pane = $('#' + id); pane.parentElement.querySelectorAll(':scope > .tabpane').forEach((p) => p.classList.toggle('active', p === pane));
    if (id === 'consolePane') { this._unseen = 0; $('#consoleBadge').hidden = true; }
    if (id === 'editorPane') this.editor.refresh();
    if (id === 'iotPane') this.renderIot();
    if (id === 'scopePane') this.scope.render(true);
  },

  buildPalette() {
    const list = $('#paletteList');
    const draw = (type) => {
      const d = DEFS[type]; const c = { id: '_', type, props: { ...d.props } };
      const pins = d.pins.map((p) => `<rect x="${p.x - 2.5}" y="${p.y - 2.5}" width="5" height="5" fill="#c9a227"/>`).join('');
      return `<svg viewBox="-8 -8 ${d.w + 16} ${d.h + 16}" preserveAspectRatio="xMidYMid meet">${d.render(c, { b: 0, angle: 90, f: 0 })}${pins}</svg>`;
    };
    list.innerHTML = PALETTE.map((g) => `<div class="palette-group"><div class="palette-cat">${g.cat}</div>${g.types.map((t) => `<button class="part" draggable="true" data-type="${t}" title="Add ${esc(DEFS[t].name)}">${draw(t)}<span>${esc(DEFS[t].name)}</span></button>`).join('')}</div>`).join('');
    list.addEventListener('click', (e) => { const b = e.target.closest('.part'); if (b) this.addComponent(b.dataset.type); });
    list.addEventListener('dragstart', (e) => { const b = e.target.closest('.part'); if (b) { e.dataTransfer.setData('text/catsim-part', b.dataset.type); e.dataTransfer.effectAllowed = 'copy'; } });
    $('#paletteSearch').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      list.querySelectorAll('.part').forEach((b) => { b.hidden = q && !DEFS[b.dataset.type].name.toLowerCase().includes(q) && !b.dataset.type.includes(q); });
      list.querySelectorAll('.palette-group').forEach((g) => { g.hidden = ![...g.querySelectorAll('.part')].some((b) => !b.hidden); });
    });
  },

  onSelection(sel) {
    const panel = $('#props');
    if (!sel) { panel.hidden = true; return; }
    if (sel.kind === 'wire') {
      const w = this.project.wires.find((x) => x.id === sel.id); if (!w) { panel.hidden = true; return; }
      const cur = this.canvas.wireColor(w, this.project.wires.indexOf(w));
      const cols = ['#5c6370', '#ff4d4d', ...WIRE_COLORS];
      panel.innerHTML = `<h4>Wire</h4><div class="sub">${esc(w.from)} → ${esc(w.to)}</div>
        <div class="row"><label>Color</label><div class="swatches">${cols.map((c) => `<button class="swatch${c === cur ? ' on' : ''}" style="background:${esc(c)}" data-color="${esc(c)}" aria-label="Color ${esc(c)}"></button>`).join('')}</div></div>
        <div class="actions"><button class="btn btn-sm danger" data-act="delete">Delete wire</button></div>`;
      panel.querySelectorAll('.swatch').forEach((b) => b.onclick = () => { w.color = b.dataset.color; this.changed({ structure: false }); this.canvas.renderWires(); this.onSelection(sel); });
    } else {
      const c = this.project.components.find((x) => x.id === sel.id); if (!c) { panel.hidden = true; return; }
      const d = DEFS[c.type];
      const rows = (d.controls || []).map((ct) => {
        const v = c.props[ct.key];
        if (ct.type === 'range') return `<div class="row"><label>${ct.label}<b data-out="${ct.key}">${esc(ct.fmt ? ct.fmt(v) : v)}</b></label><input type="range" min="${ct.min}" max="${ct.max}" step="${ct.step}" value="${esc(v)}" data-key="${ct.key}"></div>`;
        if (ct.type === 'select') return `<div class="row"><label>${ct.label}</label><select data-key="${ct.key}">${ct.options.map((o) => `<option${String(o) === String(v) ? ' selected' : ''}>${o}</option>`).join('')}</select></div>`;
        if (ct.type === 'toggle') return `<div class="row"><label class="toggle"><input type="checkbox" data-key="${ct.key}"${v ? ' checked' : ''}> ${ct.label}</label></div>`;
        return '';
      }).join('');
      const hint = d.hint ? `<p class="hint">${d.hint}</p>` : d.type === 'esp32' ? '<p class="hint">Hover a pin to see its GPIO number and functions. The blue LED is on GPIO2.</p>' : '';
      panel.innerHTML = `<h4>${esc(d.name)}</h4><div class="sub">${esc(c.id)}</div>${rows}${hint}
        ${d.fixed ? '' : '<div class="actions"><button class="btn btn-sm danger" data-act="delete">Delete part</button></div>'}`;
      panel.querySelectorAll('[data-key]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const ct = d.controls.find((x) => x.key === inp.dataset.key);
          c.props[ct.key] = ct.type === 'toggle' ? inp.checked : ct.type === 'range' ? +inp.value : inp.value;
          const out = panel.querySelector(`[data-out="${ct.key}"]`); if (out) out.textContent = ct.fmt ? ct.fmt(c.props[ct.key]) : c.props[ct.key];
          this.canvas.renderDynamic(); this.sim.syncProject(); this.save();
        });
      });
    }
    const del = panel.querySelector('[data-act="delete"]'); if (del) del.onclick = () => this.deleteSelection();
    panel.hidden = false;
  },

  bindUi() {
    $('#btnRun').onclick = () => this.toggleRun();
    $('#btnRestart').onclick = () => this.restartSim();
    $('#btnPause').onclick = () => this.togglePause();
    $('#boardSelect').onchange = (e) => this.setBoard(e.target.value);
    $('#btnFirmware').onclick = () => $('#firmwareFile').click();
    $('#firmwareFile').onchange = (e) => { this.loadFirmware(e.target.files[0]); e.target.value = ''; };
    $('#simSpeed').onchange = (e) => this.sim.setSpeed(+e.target.value);
    $('#addPart').onclick = () => this.showTab('editor', 'partsPane');
    const is3d = () => this.view3d.active;
    $('#zoomIn').onclick = () => (is3d() ? this.view3d.zoom(1.2) : this.canvas.zoomCenter(1.2));
    $('#zoomOut').onclick = () => (is3d() ? this.view3d.zoom(1 / 1.2) : this.canvas.zoomCenter(1 / 1.2));
    $('#zoomFit').onclick = () => (is3d() ? this.view3d.fit() : this.canvas.fit());
    $('#view2d').onclick = () => this.setView('2d');
    $('#view3d').onclick = () => this.setView('3d');
    $('#projectName').addEventListener('input', (e) => { this.project.name = e.target.value; this.save(); });

    const sel = $('#exampleSelect');
    sel.innerHTML += EXAMPLES.map((e) => `<option value="${e.key}">${esc(e.name)}</option>`).join('');
    sel.onchange = () => { if (sel.value) { this.load(this.fromExample(sel.value)); this.toast(`Loaded “${EXAMPLES.find((e) => e.key === sel.value).name}”`); } sel.value = ''; };

    $('#btnNew').onclick = () => {
      if (!confirm('Start a new empty project? The current one will be replaced (export it first to keep it).')) return;
      this.load({ name: 'Untitled project', code: 'void setup() {\n  Serial.begin(115200);\n  Serial.println("Hello, ESP32!");\n}\n\nvoid loop() {\n  delay(1000);\n}\n', components: [], wires: [] });
    };
    $('#btnExport').onclick = () => {
      const blob = new Blob([JSON.stringify(this.project, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = (this.project.name || 'catsim').replace(/[^\w-]+/g, '_') + '.catsim.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('#btnImport').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { this.load(JSON.parse(await f.text())); this.toast('Project imported'); } catch (err) { this.toast('Not a valid CatSim project file'); }
    };
    $('#btnShare').onclick = async () => {
      const url = location.href.split('#')[0] + await encodeShare(this.project);
      try { await navigator.clipboard.writeText(url); this.toast('Share link copied to clipboard'); } catch (_) { prompt('Copy this link:', url); }
    };
    $('#btnMute').onclick = (e) => { Audio.muted = !Audio.muted; e.currentTarget.textContent = Audio.muted ? '🔇' : '🔊'; if (Audio.muted) Audio.stopAll(); };

    document.querySelectorAll('.tabs').forEach((tabs) => tabs.addEventListener('click', (e) => {
      const t = e.target.closest('.tab'); if (t) this.showTab(tabs.dataset.group, t.dataset.tab);
    }));
    $('#btnClear').onclick = () => {
      const active = document.querySelector('.tabs[data-group="bottom"] .tab.active').dataset.tab;
      if (active === 'serialPane') $('#serialOut').textContent = '';
      else if (active === 'consolePane') this.clearConsole();
      else { this.sim.broker.log = []; this.sim.broker.topics.clear(); this.renderIot(); }
    };
    $('#serialForm').onsubmit = (e) => {
      e.preventDefault();
      const inp = $('#serialInput'); const end = $('#lineEnding').value.replace('\\r', '\r').replace('\\n', '\n');
      if (!this.sim.running) { this.toast('Start the simulation first'); return; }
      this.sim.sendSerial(inp.value + end); inp.value = '';
    };
    $('#mqttForm').onsubmit = (e) => {
      e.preventDefault();
      const topic = $('#mqttTopic').value.trim(); const payload = $('#mqttPayload').value;
      if (!topic) { $('#mqttTopic').focus(); return; }
      if (/[+#]/.test(topic)) { this.toast('Wildcards are not allowed when publishing'); return; }
      this.sim.brokerPublish(topic, payload, 'dashboard');
      if (!this.sim.running || !this.sim.mqtt.connected) this.toast('Published — but no ESP32 is connected to the broker');
      this.renderIot();
    };
    $('#iotTopics').addEventListener('click', (e) => { const c = e.target.closest('.topic-card'); if (c) { $('#mqttTopic').value = c.dataset.topic; $('#mqttPayload').focus(); } });

    document.addEventListener('keydown', (e) => {
      const typing = e.target.closest('input, textarea, select, .cm-editor');
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.toggleRun(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.save(); this.toast('Saved in this browser'); return; }
      if (typing) return;
      if (e.key === 'Escape') { this.canvas.cancelWire(); this.canvas.select(null); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
    });
  },

  bindSplitters() {
    const ws = $('#workspace'); const side = $('#side');
    const drag = (el, onMove) => el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.classList.add('dragging'); el.setPointerCapture(e.pointerId);
      const mv = (ev) => onMove(ev); const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); this.editor.refresh(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
    drag($('#splitV'), (e) => { const r = ws.getBoundingClientRect(); const w = Math.min(r.width * 0.7, Math.max(320, e.clientX - r.left)); document.documentElement.style.setProperty('--side-w', w + 'px'); });
    drag($('#splitH'), (e) => { const r = side.getBoundingClientRect(); const h = Math.min(r.height - 140, Math.max(120, r.bottom - e.clientY)); document.documentElement.style.setProperty('--bottom-h', h + 'px'); this.editor.refresh(); });
  },
};


export { App };
