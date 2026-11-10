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
import { Plotter } from './plotter.js';
import { wireNets } from './analog/nets.ts';
import { snapToBreadboard } from './contacts.js';
import { spiceLib } from './analog/models.ts';
const $ = (s) => document.querySelector(s);
const STORE = 'catsim.project.v1';
const VIEW_STORE = 'catsim.view';
// starting programs for boards added to a project
const ESP_TEMPLATE = `// This board runs its own sketch, alongside the other boards in the circuit.
// Wire its pins to another board to make them talk.
void setup() {
  Serial.begin(115200);
  Serial.println("ready");
}

void loop() {
  delay(1000);
}
`;
const UNO_TEMPLATE = `// Arduino Uno: blink the on-board LED (pin 13).
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;
const SIDE_STORE = 'catsim.sideHidden';
const DOCK_STORE = 'catsim.dockCollapsed';
const clone = (o) => JSON.parse(JSON.stringify(o));
/** Simulated time since boot as mm:ss.mmm (the clock on the run bar, and the Terminal's line stamps). */
const simStamp = (ms) => {
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
/** Terminal text as lines, each stamped with the simulated time (ms) its first byte arrived. println's CR LF becomes LF. */
function addSerial(lines, text, ms) {
  for (const piece of text.replace(/\r\n?/g, '\n').split(/(?<=\n)/)) {
    const last = lines[lines.length - 1];
    if (last && !last.s.endsWith('\n')) last.s += piece; else lines.push({ t: ms, s: piece });
  }
  let size = 0; for (const l of lines) size += l.s.length;
  while (size > 60000 && lines.length > 1) size -= lines.shift().s.length; // keep the newest output
  return lines;
}
const serialText = (lines) => lines.map((l) => l.s).join('');

// ---------- audio for buzzers ----------
const Audio = {
  ctx: null, osc: new Map(),
  ensure() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* no audio */ } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  set(id, f) {
    if (!this.ctx) return;
    let o = this.osc.get(id);
    if (f > 0) {
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
    this.plotter = new Plotter($('#plotCanvas'), $('#plotLegend'), $('#plotEmpty'));
    this.editor = createEditor($('#code'), { onRun: () => this.toggleRun() });
    this.buildPalette(); this.bindUi(); this.bindSplitters(); this.bindSheetHandle();
    this.load(await this.initialProject());
    this.editor.onChange(() => { if (this._loadingEditor) return; this.setProgram(this.activeBoard || this.primaryId(), { code: this.editor.get() }); this.save(); });
    requestAnimationFrame(() => this.frame());
    let v = '2d'; try { v = localStorage.getItem(VIEW_STORE) || '2d'; } catch (_) { /* ignore */ }
    try { if (localStorage.getItem(SIDE_STORE)) this.toggleSidebar(true); } catch (_) { /* ignore */ }
    // on a phone the sidebar is a sheet that opens from the hamburger: it starts closed, so the diagram is on screen
    if (window.matchMedia('(max-width: 900px)').matches) this.toggleSidebar(true, false);
    try { if (localStorage.getItem(DOCK_STORE)) this.toggleDock(true); } catch (_) { /* ignore */ }
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
    return { name: ex.name, code: ex.code, components: clone(ex.components), wires: ex.wires.map((w, i) => ({ id: 'w' + (i + 1), ...w })), ...(ex.programs ? { programs: clone(ex.programs) } : {}) };
  },

  normalize(p) { return normalizeProject(p, DEFS); },

  load(p) {
    this.stop();
    this.project = this.normalize(p);
    $('#projectName').value = this.project.name;
    this.activeBoard = ''; this.term = {};
    this.switchBoard(this.primaryId());
    this.sim.resetHw(); this.sim.invalidate();
    this.canvas.select(null);
    this.canvas.renderAll();
    requestAnimationFrame(() => this.canvas.fit());
    this.view3d.dirty = true; this.view3d.camFitted = false;
    if (this.view3d.active) requestAnimationFrame(() => this.view3d.fit());
    this.refreshScopeNets(); this.scope.clear(); this.refreshBoardUi(); this.refreshTidy();
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
    const base = { led: 'led', resistor: 'r', button: 'btn', pot: 'pot', dht22: 'dht', ldr: 'ldr', pir: 'pir', buzzer: 'bz', servo: 'servo', lcd: 'lcd', npn: 'q', pnp: 'q', nmos: 'm', diode: 'd', opamp: 'u', capacitor: 'c', motor: 'mot', relay: 'k', rgb_led: 'rgb', seg7: 'seg', slide_switch: 'sw', battery: 'bat', fsr: 'fsr', vibmotor: 'vib', tp4056: 'chg', buckboost: 'reg', joystick: 'joy', encoder: 'enc', l298n: 'drv', sound: 'mic', soil: 'soil', mq2: 'gas', breadboard: 'bb', bme280: 'bme', mpu6050: 'imu', lcd_parallel: 'lcd', oled: 'oled', tm1637: 'disp', ws2812_strip: 'strip', ws2812_ring: 'ring', ds18b20: 'temp', hcsr04: 'sonar', ds3231: 'rtc', keypad: 'keypad', ir_receiver: 'ir', ir_remote: 'remote', stepper: 'step' }[type] || (DEFS[type] && DEFS[type].dip ? 'u' : type);
    let i = 1; while (this.project.components.some((c) => c.id === base + i)) i++;
    return base + i;
  },
  addComponent(type, x, y) {
    const d = DEFS[type];
    if (d.board) { this.addBoard(type); return; }
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
  /** Turn the selected part a quarter turn clockwise. Boards and breadboards stay upright (their pins are fixed). */
  rotateSelection() {
    const s = this.canvas.sel; if (!s || s.kind !== 'comp') return;
    const c = this.project.components.find((x) => x.id === s.id); if (!c) return;
    const d = DEFS[c.type]; if (d.board || d.type === 'breadboard') { this.toast('Boards and breadboards stay upright'); return; }
    c.rot = ((c.rot || 0) + 90) % 360; if (!c.rot) delete c.rot;
    const snap = snapToBreadboard(this.project, DEFS, c); // a part plugged into a breadboard stays on its holes
    if (snap) Object.assign(c, snap);
    this.changed();
    this.onSelection(this.canvas.sel);
  },
  deleteSelection() {
    const s = this.canvas.sel; if (!s) return;
    if (s.kind === 'wire') this.project.wires = this.project.wires.filter((w) => w.id !== s.id);
    else {
      const c = this.project.components.find((x) => x.id === s.id);
      if (!c) return;
      if (DEFS[c.type].board) { this.removeBoard(c); return; }
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
    this.term = {}; this.renderTerminal(); this.plotter.clear();
    this.clearConsole(); this.clearAlerts();
    this.setProgram(this.activeBoard || this.primaryId(), { code: this.editor.get() });
    this.sim.start(this.project.code).then((ok) => { if (ok === false) this.showTab('bottom', 'consolePane'); });
  },
  stop() { if (this.sim && this.sim.running) this.sim.stop(); },
  restartSim() { this.stop(); this.start(); },
  /** Show or hide the left sidebar (editor, parts, terminal…). The choice is remembered. */
  /** Phones: the sheet's height. Closed, half the screen (the default) or full (under the top bar). */
  setSheetHeight(px) { const s = $('#side'); s.style.height = px == null ? '' : `${Math.round(px)}px`; },
  /** Drag the sheet's handle: up enlarges it to the full screen, down collapses it (past a quarter of its height it closes). */
  bindSheetHandle() {
    const h = $('#sheetHandle'), side = $('#side');
    let drag = null;
    const full = () => window.innerHeight - $('.topbar').getBoundingClientRect().bottom;
    h.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, h: side.getBoundingClientRect().height }; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.setSheetHeight(Math.min(full(), Math.max(0, drag.h - (e.clientY - drag.y))));
    });
    const end = () => {
      if (!drag) return;
      const cur = side.getBoundingClientRect().height, half = window.innerHeight / 2, top = full();
      drag = null;
      if (cur < half * 0.5) { this.setSheetHeight(null); this.toggleSidebar(true, false); return; } // closed
      this.setSheetHeight(cur > (half + top) / 2 ? top : half); // snap: half or full
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  },
  toggleSidebar(hidden = !$('#workspace').classList.contains('side-hidden'), remember = true) {
    if (hidden) this.setSheetHeight(null); // the next opening starts at half the screen again
    $('#workspace').classList.toggle('side-hidden', hidden);
    const b = $('#btnSide');
    b.setAttribute('aria-expanded', String(!hidden));
    b.title = hidden ? 'Show the sidebar (Ctrl+B)' : 'Hide the sidebar (Ctrl+B)';
    if (remember) { try { localStorage.setItem(SIDE_STORE, hidden ? '1' : ''); } catch (_) { /* ignore */ } }
    if (!hidden && window.matchMedia('(max-width: 900px)').matches) this.showTab('editor', 'partsPane'); // a phone's sheet opens on the Parts
    if (!hidden) requestAnimationFrame(() => this.editor.refresh());
  },
  /** Fold the Terminal/MQTT/Scope/Console panel down to its tab bar, or open it again. Remembered. */
  toggleDock(collapsed = !$('#bottom').classList.contains('collapsed')) {
    $('#bottom').classList.toggle('collapsed', collapsed);
    $('#center').classList.toggle('dock-collapsed', collapsed);
    const b = $('#btnDock'), label = collapsed ? 'Show the panel' : 'Hide the panel';
    b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(DOCK_STORE, collapsed ? '1' : ''); } catch (_) { /* ignore */ }
    if (!collapsed && $('#scopePane').classList.contains('active')) requestAnimationFrame(() => this.scope.render(true));
  },
  /** Switch wires between free curves and tidy right-angle routes (saved with the project). */
  toggleTidy() {
    const tidy = this.project.wireStyle !== 'tidy';
    if (tidy) this.project.wireStyle = 'tidy'; else delete this.project.wireStyle;
    this.refreshTidy(); this.canvas.renderWires(); this.save();
    this.toast(tidy ? 'Wires tidied: they now route around parts as you edit' : 'Wires back to curves');
  },
  refreshTidy() {
    const on = this.project.wireStyle === 'tidy', b = $('#btnTidy');
    b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
    b.title = on ? 'Wires are tidy (click for curves)' : 'Tidy wires: route them at right angles around parts';
  },
  onSimState(on) {
    const b = $('#btnRun');
    b.classList.toggle('running', on);
    b.querySelector('.ico').textContent = on ? '■' : '▶';
    b.querySelector('.lbl').textContent = on ? 'Stop' : 'Start';
    // starting: the card shrinks to its live-only form; stopping: drop the selection, so a part clicked
    // during the run (e.g. a pressed button) doesn't pop up its card
    if (on) this.onSelection(this.canvas.sel); else this.canvas.select(null);
    if (!on) { Audio.stopAll(); this.flushSerial(); this.canvas.renderDynamic(); this.renderIot(); }
    else this.log('Simulation started', 'info');
  },

  frame() {
    if (this.sim.running) {
      this.canvas.renderDynamic();
      for (const c of this.project.components) {
        if (c.type === 'buzzer') { const s = DEFS.buzzer.state(c, this.sim); Audio.set(c.id, c.props.muted ? 0 : s.f); }
      }
      this.flushSerial();
      if (this._iotDirty) this.renderIot();
      if ($('#scopePane').classList.contains('active')) this.scope.render();
    }
    if ($('#plotPane').classList.contains('active')) this.plotter.render();
    if (!$('#props').hidden) this.positionProps(); // follows pan, zoom, drag and 3D orbit
    requestAnimationFrame(() => this.frame());
    },

    /** Float the edit card just above the selected part or wire (below it if there's no room), inside the canvas. */
    positionProps() {
    const panel = $('#props'), sel = this.canvas.sel; if (!sel) return;
    const stage = $('#stage').getBoundingClientRect();
    let box = null;
    if (this.view3d.active && sel.kind === 'comp') {
      const c = this.project.components.find((x) => x.id === sel.id); const d = c && DEFS[c.type];
      if (d) {
        const a = this.view3d.screenPoint(c.x, 30, c.y), b = this.view3d.screenPoint(c.x + d.w, 0, c.y + d.h);
        box = { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
      }
    } else {
      const el = sel.kind === 'comp' ? this.canvas.compsG.querySelector(`.cs-comp[data-id="${CSS.escape(sel.id)}"] .cs-body`)
        : this.canvas.wiresG.querySelector(`.cs-wire[data-id="${CSS.escape(sel.id)}"] .cs-wire-line`);
      if (el) box = el.getBoundingClientRect();
    }
    if (!box) return;
    const w = panel.offsetWidth, h = panel.offsetHeight, gap = 12, m = 8;
    // the part's box in stage coordinates
    const L = box.left - stage.left, R = box.right - stage.left, T = box.top - stage.top, B = box.bottom - stage.top;
    const cx = (L + R) / 2, cy = (T + B) / 2;
    const clampX = (x) => Math.min(Math.max(m, x), stage.width - w - m);
    const clampY = (y) => Math.min(Math.max(m, y), stage.height - h - m);
    // above, below, right, left: take the first spot that leaves the part uncovered, else the one covering least
    const spots = [[cx - w / 2, T - h - gap], [cx - w / 2, B + gap], [R + gap, cy - h / 2], [L - w - gap, cy - h / 2]]
      .map(([x, y]) => { const left = clampX(x), top = clampY(y);
        const ox = Math.max(0, Math.min(R, left + w) - Math.max(L, left)), oy = Math.max(0, Math.min(B, top + h) - Math.max(T, top));
        return { left, top, cover: ox * oy }; });
    const best = spots.find((s) => s.cover === 0) || spots.reduce((a, b) => (b.cover < a.cover ? b : a));
    panel.style.left = `${Math.round(best.left)}px`; panel.style.top = `${Math.round(best.top)}px`;
    },

    onScopeSamples(t, v) { this.scope.addSamples(t, v); },
  /** Human-readable summary of pasted SPICE text: what it defines, or where it fails to parse. */
  spiceStatus(text) {
    const lib = spiceLib(text);
    if (!lib) return 'Using the built-in model. Paste a .model or .subckt from a datasheet or vendor library.';
    if (lib instanceof Error) return `Not valid: ${lib.message}`;
    const found = [...[...lib.models.entries()].map(([n, m]) => `.model ${n} (${m.type.toUpperCase()})`), ...[...lib.subckts.values()].map((s) => `.subckt ${s.name} (${s.ports.length} pins)`)];
    return found.length ? `Found ${found.join(', ')}` : 'No .model or .subckt found.';
  },
  // ---------- boards and their programs ----------
  boards() { return this.project.components.filter((c) => DEFS[c.type] && DEFS[c.type].board); },
  primaryId() { const b = this.boards()[0]; return b ? b.id : ''; },
  /** type of the board whose program is open in the editor */
  boardType() { const b = this.boards().find((x) => x.id === this.activeBoard) || this.boards()[0]; return b ? b.type : 'esp32'; },
  /** A board's program. The first board's lives in project.code (single-board projects unchanged). */
  program(id) {
    if (!id || id === this.primaryId()) return { code: this.project.code };
    return (this.project.programs && this.project.programs[id]) || {};
  },
  setProgram(id, patch) {
    if (!id || id === this.primaryId()) {
      if ('code' in patch) this.project.code = patch.code;
      return;
    }
    this.project.programs = this.project.programs || {};
    this.project.programs[id] = { ...(this.project.programs[id] || {}), ...patch };
  },
  /** Open a board's program in the editor (and its serial output in the Terminal). */
  switchBoard(id) {
    if (!this.boards().some((b) => b.id === id)) id = this.primaryId();
    if (this.activeBoard && this.activeBoard !== id && this.boards().some((b) => b.id === this.activeBoard)) this.setProgram(this.activeBoard, { code: this.editor.get() });
    this.activeBoard = id;
    this._loadingEditor = true; this.editor.set(this.program(id).code || ''); this._loadingEditor = false;
    this.editor.clear();
    this.refreshBoardUi(); this.renderTerminal();
    this.plotter.clear(); this.plotter.feed(serialText((this.term && this.term[id]) || []));
  },
  /** Add another microcontroller; it gets its own program tab. */
  addBoard(type) {
    const base = type === 'uno' ? 'uno' : type === 'esp32c3' ? 'c3' : 'esp';
    let id = base, i = 2; while (this.project.components.some((c) => c.id === id)) id = base + i++;
    let maxX = 0, minY = Infinity;
    for (const c of this.project.components) { const d = DEFS[c.type]; if (d) { maxX = Math.max(maxX, c.x + d.w); minY = Math.min(minY, c.y); } }
    this.project.components.push({ id, type, x: Math.round((maxX + 80) / 5) * 5, y: Number.isFinite(minY) ? minY : 80, props: {} });
    if (this.boards().length > 1) this.setProgram(id, { code: type === 'uno' ? UNO_TEMPLATE : ESP_TEMPLATE });
    this.changed(); requestAnimationFrame(() => this.canvas.fit());
    this.switchBoard(id);
    this.showTab('editor', 'editorPane'); // land on the new board's program
    this.toast(`Added ${DEFS[type].name} "${id}": its program is in the ${id} tab above the editor`);
  },
  removeBoard(c) {
    const boards = this.boards();
    if (boards.length < 2) { this.toast('A project needs at least one board'); return; }
    this.stop();
    if (this.activeBoard) this.setProgram(this.activeBoard, { code: this.editor.get() });
    if (boards[0].id === c.id) { // the next board becomes the first one: its program moves into code
      const next = boards[1], np = this.program(next.id);
      this.project.code = np.code || '';
      if (this.project.programs) delete this.project.programs[next.id];
    } else if (this.project.programs) delete this.project.programs[c.id];
    this.project.components = this.project.components.filter((x) => x !== c);
    this.project.wires = this.project.wires.filter((w) => !w.from.startsWith(c.id + ':') && !w.to.startsWith(c.id + ':'));
    this.activeBoard = '';
    this.canvas.select(null); this.changed();
    this.switchBoard(this.primaryId());
  },
  refreshBoardUi() {
    const uno = this.boardType() === 'uno', boards = this.boards(), multi = boards.length > 1;
    const tabs = $('#boardTabs'); tabs.hidden = !multi;
    if (multi) {
      tabs.textContent = '';
      for (const b of boards) {
        const t = document.createElement('button');
        t.className = 'board-tab' + (b.id === this.activeBoard ? ' active' : '');
        t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(b.id === this.activeBoard));
        t.dataset.board = b.id;
        t.textContent = `${b.id} · sketch`;
        t.title = `${DEFS[b.type].name} "${b.id}"`;
        t.onclick = () => this.switchBoard(b.id);
        tabs.appendChild(t);
      }
    }
    document.querySelectorAll('#paletteList .part').forEach((b) => { if (DEFS[b.dataset.type].board) b.title = `Add a ${DEFS[b.dataset.type].name}`; });
    const c3 = this.boardType() === 'esp32c3';
    document.querySelector('.brand .chip').textContent = uno ? 'UNO' : c3 ? 'ESP32-C3' : 'ESP32';
    $('#serialInput').placeholder = `Message to ${multi ? this.activeBoard : uno ? 'Arduino' : c3 ? 'ESP32-C3' : 'ESP32'} (Enter to send)`;
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

  /** Serial output per board; the Terminal shows the board whose program is open. */
  flushSerial() {
    const chunks = this.sim.takeSerial ? this.sim.takeSerial() : {};
    const ms = Math.floor(this.sim.millis());
    let mine = false;
    for (const [id0, text] of Object.entries(chunks)) {
      if (!text) continue;
      const id = id0 || this.primaryId();
      this.term[id] = addSerial(this.term[id] || [], text, ms);
      if (id === this.activeBoard) this.plotter.feed(text);
      if (id === this.activeBoard) mine = true;
      else { const tab = document.querySelector(`#boardTabs [data-board="${CSS.escape(id)}"]`); if (tab) tab.classList.add('unseen'); }
    }
    if (!mine) return;
    this.renderTerminal();
    // new output you can't see (panel folded, or another tab open): mark the Terminal tab
    if ($('#bottom').classList.contains('collapsed') || !$('#serialPane').classList.contains('active')) $('.tab[data-tab="serialPane"]').classList.add('unseen');
  },
  renderTerminal() {
    const el = $('#serialOut');
    el.replaceChildren(...((this.term && this.term[this.activeBoard]) || []).map((l) => {
      const s = document.createElement('span'); s.className = 'ln'; s.dataset.t = simStamp(l.t); s.textContent = l.s; return s;
    }));
    if ($('#autoScroll').checked) el.scrollTop = el.scrollHeight;
    const tab = document.querySelector(`#boardTabs [data-board="${CSS.escape(this.activeBoard || '')}"]`); if (tab) tab.classList.remove('unseen');
  },

  // ---------- console ----------
  log(msg, level = 'info', line, board) {
    const out = $('#consoleOut');
    const d = document.createElement('div'); d.className = `log ${level}`;
    const ms = Math.floor(this.sim ? this.sim.millis() : 0);
    const multi = this.project && this.boards().length > 1;
    d.innerHTML = `<span class="tm">${(ms / 1000).toFixed(3)}s</span><span></span>`;
    d.lastChild.textContent = (multi && board ? `[${board}] ` : '') + msg;
    if (line) {
      const a = document.createElement('a'); a.href = '#'; a.textContent = ` → line ${line}`;
      a.onclick = (e) => { e.preventDefault(); if (board && board !== this.activeBoard) this.switchBoard(board); this.showTab('editor', 'editorPane'); this.editor.focusLine(line); this.editor.mark(line); };
      d.lastChild.appendChild(a);
      if (!board || board === this.activeBoard) this.editor.mark(line);
    }
    out.appendChild(d); while (out.children.length > 300) out.firstChild.remove();
    out.parentElement.scrollTop = out.parentElement.scrollHeight;
    if (level !== 'info') this.alert(msg, level, board);
    if (level !== 'info' && !$('#consolePane').classList.contains('active')) {
      this._unseen = (this._unseen || 0) + 1;
      const b = $('#consoleBadge'); b.hidden = false; b.textContent = this._unseen;
    }
  },
  /** A problem the user should see now (wiring, current, sketch error): a popup that names and flags the part. */
  alert(msg, level = 'warn', board) {
    const box = $('#alerts'); if (!box) return;
    const text = (board && this.boards().length > 1 ? `[${board}] ` : '') + msg;
    if ([...box.children].some((a) => a.dataset.text === text)) return;
    const part = this.project.components.find((c) => !DEFS[c.type]?.board && new RegExp(`(^|[\\s'"(])${c.id.replace(/[^\w-]/g, '')}(?=[\\s:'’)]|$)`).test(msg));
    const a = document.createElement('div');
    a.className = `alert ${level}`; a.dataset.text = text;
    a.innerHTML = `<span class="ico">${level === 'error' ? '⛔' : '⚠️'}</span><span class="msg"></span><button class="x" aria-label="Dismiss">×</button>`;
    a.querySelector('.msg').textContent = text;
    const close = () => { a.classList.add('out'); setTimeout(() => a.remove(), 200); };
    a.querySelector('.x').onclick = (e) => { e.stopPropagation(); close(); };
    a.onclick = () => { if (part) this.canvas.select({ kind: 'comp', id: part.id }); this.showTab('bottom', 'consolePane'); close(); };
    box.appendChild(a);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(close, level === 'error' ? 15000 : 9000);
    if (part) { // flash the part on the diagram
      const g = document.querySelector(`.cs-comp[data-id="${CSS.escape(part.id)}"]`);
      if (g) { g.classList.remove('cs-flag'); void g.getBoundingClientRect(); g.classList.add('cs-flag'); setTimeout(() => g.classList.remove('cs-flag'), 3200); }
    }
  },
  clearAlerts() { const box = $('#alerts'); if (box) box.textContent = ''; },
  clearConsole() { $('#consoleOut').textContent = ''; this._unseen = 0; $('#consoleBadge').hidden = true; },
  reportError(e, board) {
    const m = String(e && e.stack || '').match(/(?:<anonymous>|Function):(\d+):\d+/);
    const line = m ? +m[1] - 2 : undefined;
    let msg = (e && e.message) || String(e);
    if (/is not defined/.test(msg)) msg += ' — it may be a function or library CatSim does not simulate yet';
    this.log(`Runtime error: ${msg}`, 'error', line > 0 ? line : undefined, board);
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
    if (group === 'bottom') {
      $('#autoScrollWrap').hidden = id !== 'serialPane'; // only the terminal scrolls
      if (id === 'serialPane') $('.tab[data-tab="serialPane"]').classList.remove('unseen');
      if ($('#bottom').classList.contains('collapsed')) this.toggleDock(false);
    }
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
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.part'); if (!b) return;
      this.addComponent(b.dataset.type);
      // on a phone the diagram is above the Parts list: bring it into view so the new part can be seen and moved
      if (window.matchMedia('(max-width: 900px)').matches && !DEFS[b.dataset.type].board) {
        this.toggleSidebar(true, false); // the sheet closes, so the diagram is what you see next
        $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
        this.toast(`Added ${DEFS[b.dataset.type].name}: drag it into place, or tap it to set it`);
      }
    });
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
    const live = this.sim.running; // while running, the card holds only live inputs so it doesn't cover the circuit
    if (sel.kind === 'wire') {
      const w = this.project.wires.find((x) => x.id === sel.id); if (!w) { panel.hidden = true; return; }
      const cur = this.canvas.wireColor(w, this.project.wires.indexOf(w));
      const cols = ['#1f2328', '#5c6370', '#ff4d4d', '#8b4513', ...WIRE_COLORS];
      panel.innerHTML = `<h4>Wire</h4><div class="sub">${esc(w.from)} → ${esc(w.to)}</div>
        <div class="row"><label>Color</label><div class="swatches">${cols.map((c) => `<button class="swatch${c === cur ? ' on' : ''}" style="background:${esc(c)}" data-color="${esc(c)}" aria-label="Color ${esc(c)}"></button>`).join('')}</div></div>
        ${live ? '' : '<div class="actions"><button class="btn btn-sm danger" data-act="delete">Delete wire</button></div>'}`;
      panel.querySelectorAll('.swatch').forEach((b) => b.onclick = () => { w.color = b.dataset.color; this.changed({ structure: false }); this.canvas.renderWires(); this.onSelection(sel); });
    } else {
      const c = this.project.components.find((x) => x.id === sel.id); if (!c) { panel.hidden = true; return; }
      const d = DEFS[c.type];
      // boards have no settings and can't be deleted: nothing worth a card (pin info is in the tooltips)
      // a lone board has no settings and can't be deleted; with several boards its card offers Delete
      if (d.board && this.boards().length < 2 && !(d.controls || []).length) { panel.hidden = true; return; }
      const controls = (d.controls || []).filter((ct) => !live || ct.type === 'range' || ct.type === 'toggle');
      if (live && !controls.length) { panel.hidden = true; return; }
      const rows = controls.map((ct) => {
        const v = c.props[ct.key];
        if (ct.type === 'range') return `<div class="row"><label>${ct.label}<b data-out="${ct.key}">${esc(ct.fmt ? ct.fmt(v) : v)}</b></label><input type="range" min="${ct.min}" max="${ct.max}" step="${ct.step}" value="${esc(v)}" data-key="${ct.key}"></div>`;
        if (ct.type === 'select') return `<div class="row"><label>${ct.label}</label><select data-key="${ct.key}">${ct.options.map((o) => `<option value="${esc(o)}"${String(o) === String(v) ? ' selected' : ''}>${esc(ct.fmt ? ct.fmt(o) : o)}</option>`).join('')}</select></div>`;
        if (ct.type === 'toggle') return `<div class="row"><label class="toggle"><input type="checkbox" data-key="${ct.key}"${v ? ' checked' : ''}> ${ct.label}</label></div>`;
        if (ct.type === 'spice') {
          return `<details class="row spice"${v ? ' open' : ''}><summary>${ct.label}</summary>
            <textarea data-spice="${ct.key}" spellcheck="false" rows="5" placeholder="${esc(ct.accepts)}">${esc(v || '')}</textarea>
            <div class="spice-actions"><button class="btn btn-sm" data-spice-apply="${ct.key}">Apply</button><button class="btn btn-sm" data-spice-clear="${ct.key}">Clear</button></div>
            <div class="spice-status" data-spice-status="${ct.key}">${esc(this.spiceStatus(v))}</div></details>`;
        }
        return '';
      }).join('');
      const hint = d.hint && !live ? `<p class="hint">${d.hint}</p>` : '';
      panel.innerHTML = `<h4>${esc(d.name)}</h4><div class="sub">${esc(c.id)}</div>${rows}${hint}
        ${live ? '' : d.board ? (this.boards().length > 1 ? `<p class="hint">Its program is in the <b>${esc(c.id)}</b> tab above the editor.</p><div class="actions"><button class="btn btn-sm danger" data-act="delete">Delete board</button></div>` : '') : d.fixed ? '' : (d.board || d.type === 'breadboard' ? '' : '<div class="actions"><button class="btn btn-sm" data-act="rotate" title="Turn clockwise (R)">Rotate</button></div>') + '<div class="actions"><button class="btn btn-sm danger" data-act="delete">Delete part</button></div>'}`;
      panel.querySelectorAll('[data-key]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const ct = d.controls.find((x) => x.key === inp.dataset.key);
          c.props[ct.key] = ct.type === 'toggle' ? inp.checked : ct.type === 'range' ? +inp.value : inp.value;
          const out = panel.querySelector(`[data-out="${ct.key}"]`); if (out) out.textContent = ct.fmt ? ct.fmt(c.props[ct.key]) : c.props[ct.key];
          this.canvas.renderDynamic(); this.sim.syncProject(); this.save();
        });
      });
    }
    panel.querySelectorAll('[data-spice-apply], [data-spice-clear]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.spiceApply || b.dataset.spiceClear;
      const part = this.project.components.find((x) => x.id === sel.id); if (!part) return;
      const ct = DEFS[part.type].controls.find((x) => x.key === key);
      const ta = panel.querySelector(`[data-spice="${key}"]`);
      if (b.dataset.spiceClear) ta.value = '';
      const text = ta.value.slice(0, ct.maxLength);
      part.props[key] = text;
      panel.querySelector(`[data-spice-status="${key}"]`).textContent = this.spiceStatus(text);
      this.changed({ structure: false });
      this.toast(text ? 'Custom SPICE model applied' : 'Back to the built-in model');
    }));
    const del = panel.querySelector('[data-act="delete"]'); if (del) del.onclick = () => this.deleteSelection();
    const rot = panel.querySelector('[data-act="rotate"]'); if (rot) rot.onclick = () => this.rotateSelection();
    panel.hidden = false;
    this.positionProps();
    },

  bindUi() {
    $('#btnRun').onclick = () => this.toggleRun();
    $('#btnSide').onclick = () => this.toggleSidebar();
    $('#btnDock').onclick = () => this.toggleDock();
    $('#btnTidy').onclick = () => this.toggleTidy();
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
    // the sketch of the board open in the editor, ready for the Arduino IDE (File → Open), with the wiring as a comment
    $('#btnIno').onclick = () => {
      const id = this.activeBoard || this.primaryId(), board = this.project.components.find((c) => c.id === id);
      const code = this.editor.get();
      const wiring = this.project.wires.filter((w) => w.from.startsWith(id + ':') || w.to.startsWith(id + ':')).map((w) => `//   ${w.from}  ->  ${w.to}`);
      const boardName = board ? DEFS[board.type].name : 'board';
      const ide = board && board.type === 'uno' ? 'Arduino Uno' : board && board.type === 'esp32c3' ? 'ESP32C3 Dev Module (or "Nologo ESP32C3 Super Mini")' : 'ESP32 Dev Module';
      const head = `// ${this.project.name} — exported from CatSim for the Arduino IDE\n// Board: ${boardName}  (Tools → Board → ${ide})\n// Libraries used by #include lines: install them with Tools → Manage Libraries.\n${wiring.length ? `// Wiring:\n${wiring.join('\n')}\n` : ''}\n`;
      const name = (this.project.name || 'sketch').replace(/[^\w-]+/g, '_');
      const blob = new Blob([head + code], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.ino`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this.toast('Sketch downloaded: open it in the Arduino IDE and press Upload');
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

    document.querySelectorAll('.tabs').forEach((tabs) => tabs.addEventListener('click', (e) => {
      const t = e.target.closest('.tab'); if (!t) return;
      // clicking the open tab of the bottom panel folds the panel away (like an IDE)
      if (tabs.dataset.group === 'bottom' && t.classList.contains('active') && !$('#bottom').classList.contains('collapsed')) { this.toggleDock(true); return; }
      this.showTab(tabs.dataset.group, t.dataset.tab);
    }));
    $('#btnClear').onclick = () => {
      const active = document.querySelector('.tabs[data-group="bottom"] .tab.active').dataset.tab;
      if (active === 'serialPane') { this.term[this.activeBoard] = []; this.renderTerminal(); }
      else if (active === 'plotPane') { this.plotter.clear(); this.plotter.render(true); }
      else if (active === 'consolePane') this.clearConsole();
      else { this.sim.broker.log = []; this.sim.broker.topics.clear(); this.renderIot(); }
    };
    $('#serialForm').onsubmit = (e) => {
      e.preventDefault();
      const inp = $('#serialInput'); const end = $('#lineEnding').value.replace('\\r', '\r').replace('\\n', '\n');
      if (!this.sim.running) { this.toast('Start the simulation first'); return; }
      this.sim.sendSerial(inp.value + end, this.activeBoard); inp.value = '';
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.target.closest('.cm-editor')) { e.preventDefault(); this.toggleSidebar(); return; }
      if (typing) return;
      if (e.key === 'Escape') { this.canvas.cancelWire(); this.canvas.select(null); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) { this.rotateSelection(); }
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
    // the terminal/scope dock sits under the canvas: drag the divider to share the centre column
    drag($('#splitH'), (e) => { const r = $('#center').getBoundingClientRect(); const h = Math.min(r.height - 160, Math.max(120, r.bottom - e.clientY)); document.documentElement.style.setProperty('--bottom-h', h + 'px'); });
  },
};


export { App, Audio };
