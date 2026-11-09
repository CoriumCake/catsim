/* CatSim — page-side simulator. The sketch itself runs in js/sim-worker.js; this class mirrors the
 * board state from the worker's snapshots so parts can render (net/level logic is inherited from
 * Simulator), and forwards UI input to the worker. A share link can contain any sketch, so every
 * message from the worker is validated and coerced here before it reaches the UI. */
import { Simulator, pressEvent } from './runtime.js';
const LEVELS = new Set(['info', 'warn', 'error']);
const boardId = (b) => (typeof b === 'string' && /^[\w-]{1,32}$/.test(b) ? b : undefined);
const str = (v, max = 2000) => String(v ?? '').slice(0, max);
const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
// { gpio: number } maps only, with small integer keys
const numMap = (o) => {
  const r = {};
  if (o && typeof o === 'object') for (const k of Object.keys(o)) if (/^\d{1,2}$/.test(k) && typeof o[k] === 'number' && Number.isFinite(o[k])) r[k] = o[k];
  return r;
};
const isId = (k) => /^[\w-]{1,32}$/.test(k);
/** Parts driven by a library: OLED buffer, LED strip colors, 7-segment digits, stepper angle. */
const cleanDev = (d) => {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const [id, v] of Object.entries(d).slice(0, 200)) {
    if (!isId(id) || !v || typeof v !== 'object') continue;
    if (v.kind === 'oled' && v.buf instanceof Uint8Array && v.w === 128 && (v.h === 64 || v.h === 32) && v.buf.length === (v.w * v.h) / 8) {
      out[id] = { kind: 'oled', w: 128, h: v.h, buf: v.buf, invert: v.invert === true, dim: v.dim === true, on: v.on !== false };
    } else if (v.kind === 'pixels' && Array.isArray(v.rgb)) {
      out[id] = { kind: 'pixels', rgb: v.rgb.slice(0, 64).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x & 0xffffff : 0)) };
    } else if (v.kind === 'seg7' && Array.isArray(v.segs)) {
      out[id] = { kind: 'seg7', segs: [0, 1, 2, 3].map((i) => (finite(v.segs[i]) | 0) & 0xff), bright: Math.max(0, Math.min(7, finite(v.bright, 7) | 0)), on: v.on !== false };
    } else if (v.kind === 'stepper') {
      out[id] = { kind: 'stepper', angle: finite(v.angle), coils: [0, 1, 2, 3].map((i) => (Array.isArray(v.coils) && v.coils[i] ? 1 : 0)) };
    }
  }
  return out;
};
/** Saved data a sketch wrote (EEPROM bytes, Preferences, RTC offset), size-limited. */
const prim = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 4000);
const cleanVal = (v) => (prim(v) ? v : Array.isArray(v) && v.length <= 4096 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v.slice() : undefined);
const cleanNv = (nv) => {
  const out = {};
  if (!nv || typeof nv !== 'object') return out;
  if (nv.eeprom instanceof Uint8Array && nv.eeprom.length <= 4096) out.eeprom = nv.eeprom.slice();
  if (nv.eput && typeof nv.eput === 'object') { out.eput = {}; for (const [k, v] of Object.entries(nv.eput).slice(0, 512)) if (/^\d{1,4}$/.test(k) && cleanVal(v) !== undefined) out.eput[k] = cleanVal(v); }
  if (nv.prefs && typeof nv.prefs === 'object') {
    out.prefs = {};
    for (const [ns, tab] of Object.entries(nv.prefs).slice(0, 32)) {
      if (typeof ns !== 'string' || ns.length > 15 || !tab || typeof tab !== 'object') continue;
      out.prefs[ns] = {};
      for (const [k, v] of Object.entries(tab).slice(0, 256)) if (k.length <= 15 && cleanVal(v) !== undefined) out.prefs[ns][k] = cleanVal(v);
    }
  }
  if (typeof nv.rtc === 'number' && Number.isFinite(nv.rtc) && Math.abs(nv.rtc) < 4e9) out.rtc = Math.trunc(nv.rtc);
  return out;
};

const cleanLcd = (l) => {
  if (!l || typeof l !== 'object' || !Array.isArray(l.buf)) return null;
  const buf = [0, 1].map((r) => Array.from({ length: 16 }, (_, i) => { const ch = l.buf[r] && l.buf[r][i]; return typeof ch === 'string' && ch.length ? [...ch][0] : ' '; }));
  return { cols: 16, rows: 2, buf, cx: 0, cy: 0, backlight: l.backlight === true, display: l.display !== false };
};

class SimHost extends Simulator {
  constructor(app) {
    super(app);
    this.worker = null; this.snapT = 0; this.snapAt = 0; this.resolveRun = null;
    this.speed = 1; this.paused = false;
    this.analog = null; // { leds: {id: 0..1}, rtf, error } from the worker's analog engine
    this.boards = null; // several boards: per-board pin state, by board id
    this.nvStore = {}; // saved data of each board (by board id), kept for this page session like real flash
    this.serialBy = {}; // serial output not yet shown, by board id ('' = the only board)
    this.probes = []; this.probeDtMax = 1e-3;
  }

  millis() {
    if (!this.running) return this.stoppedAt;
    if (this.paused) return this.snapT;
    return this.snapT + Math.min(100, performance.now() - this.snapAt) * this.speed;
  }
  pause() { if (!this.running || this.paused) return; this.snapT = this.millis(); this.snapAt = performance.now(); this.paused = true; this.send({ type: 'pause' }); }
  resume() { if (!this.paused) return; this.snapAt = performance.now(); this.paused = false; this.send({ type: 'resume' }); }
  setSpeed(s) {
    s = +s; if (!(s >= 0.05 && s <= 100)) return;
    this.snapT = this.millis(); this.snapAt = performance.now(); this.speed = s; this.send({ type: 'speed', speed: s });
  }

  spawn() {
    let w;
    try { w = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module', name: 'catsim-sketch' }); } catch (e) {
      this.app.log(location.protocol === 'file:'
        ? 'The simulator needs CatSim to be served over http(s), not opened as a file. Run "python3 -m http.server" in the CatSim folder and open http://localhost:8000.'
        : `Could not start the simulator worker: ${e.message}`, 'error');
      return null;
    }
    w.onmessage = (e) => { if (this.worker === w) this.onWorker(e.data); };
    w.onerror = (e) => {
      if (this.worker !== w) return;
      e.preventDefault();
      this.app.log(`Simulator stopped: ${e.message || 'the worker failed to load'}`, 'error');
      this.stop();
    };
    return w;
  }

  start(code) {
    this.stop(true);
    const first = this.app.boards ? this.app.boards()[0] : null;
    this.boardType = first && (first.type === 'uno' || first.type === 'esp32c3') ? first.type : 'esp32'; // whose pins the page-side nets belong to
    this.resetHw(); this.ui = {};
    this.worker = this.spawn();
    if (!this.worker) return Promise.resolve(false);
    this.paused = false;
    this.analog = null;
    if (this.nvProject !== this.app.project) { this.nvStore = {}; this.nvProject = this.app.project; } // saved data belongs to this project
    const boardComps = this.app.boards ? this.app.boards() : [];
    const boards = boardComps.length > 1 ? boardComps.map((b) => { const pr = this.app.program(b.id); return { id: b.id, type: b.type, code: pr.code || '', nv: this.nvStore[b.id] || {} }; }) : undefined;
    const board = boardComps[0] ? boardComps[0].type : 'esp32';
    this.boards = null; this.serialBy = {};
    this.worker.postMessage({ type: 'start', code: String(code), project: this.app.project, speed: this.speed, board, boards, nv: boardComps[0] ? this.nvStore[boardComps[0].id] || {} : {} });
    if (this.probes.some(Boolean)) this.send({ type: 'probes', refs: this.probes, dtMax: this.probeDtMax });
    return new Promise((res) => { this.resolveRun = res; });
  }

  stop(silent) {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    const r = this.resolveRun; this.resolveRun = null;
    if (this.running) {
      this.stoppedAt = this.millis(); this.running = false; this.runId++; this.paused = false;
      this.mqtt.connected = false;
      if (!silent) this.app.onSimState(false);
    }
    if (r) r(true);
  }

  send(m) { if (this.worker) this.worker.postMessage(m); }
  syncProject() {
    if (!this.worker || this._syncQueued) return;
    this._syncQueued = true;
    queueMicrotask(() => { this._syncQueued = false; this.send({ type: 'project', project: this.app.project }); });
  }
  setPressed(id, on, key) { this.ui[id] = pressEvent(this.ui[id], on, key, this.millis()); this.invalidate(); this.send({ type: 'ui', id, pressed: !!on, key }); }
  sendSerial(text, board) { this.send({ type: 'serial', text: String(text), board: board ? String(board) : '' }); }
  /** Serial output received since the last call, by board id ('' = the only board). */
  takeSerial() {
    const out = this.serialBy; this.serialBy = {};
    if (this.serialOut) { out[''] = (out[''] || '') + this.serialOut; this.serialOut = ''; }
    return out;
  }
  /** Pin state of one board (several-board runs), or null. */
  boardState(id) { return (this.boards && this.boards[id]) || null; }
  setProbes(refs, dtMax = 1e-3) { this.probes = refs.slice(0, 4); this.probeDtMax = dtMax; this.send({ type: 'probes', refs: this.probes, dtMax }); }
  // The worker polls interrupts and WiFi itself.
  pollInterrupts() {}
  updateWifi() {}

  brokerPublish(topic, payload, from) {
    const m = { t: this.millis(), topic: str(topic, 256), payload: str(payload, 4096), from: from === 'device' ? 'device' : 'dashboard' };
    this.broker.log.push(m); if (this.broker.log.length > 400) this.broker.log.shift();
    this.broker.topics.set(m.topic, { payload: m.payload, from: m.from, at: Date.now() });
    if (m.from === 'dashboard') this.send({ type: 'pub', topic: m.topic, payload: m.payload });
    this.app.iotChanged();
  }

  onWorker(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'state':
        if (m.on === true && !this.running) {
          this.running = true; this.runId++; this.snapT = 0; this.snapAt = performance.now();
          this.app.onSimState(true);
        } else if (m.on === false) this.stop();
        break;
      case 'snap': {
        this.snapT = Math.max(0, finite(m.t, this.snapT)); this.snapAt = performance.now();
        this.paused = m.paused === true;
        this.txAt = typeof m.serial === 'string' && m.serial ? performance.now() : this.txAt;
        { const sp = finite(m.speed, this.speed); if (sp >= 0.05 && sp <= 100) this.speed = sp; }
        if (m.boards && typeof m.boards === 'object') {
          // several boards: each one's pin state and serial output; the first board also fills the classic fields
          const boards = {};
          for (const [id, b] of Object.entries(m.boards)) {
            if (!/^[\w-]{1,32}$/.test(id) || !b || typeof b !== 'object') continue;
            boards[id] = { type: b.type === 'uno' || b.type === 'esp32c3' ? b.type : 'esp32', running: b.running === true, mode: numMap(b.mode), out: numMap(b.out), pwm: numMap(b.pwm), servo: numMap(b.servo), tone: numMap(b.tone), lcd: cleanLcd(b.lcd), dev: cleanDev(b.dev), halted: b.halted === true };
            if (typeof b.serial === 'string' && b.serial) this.serialBy[id] = ((this.serialBy[id] || '') + b.serial).slice(-100000);
          }
          this.boards = boards;
          const first = Object.keys(m.boards)[0];
          if (first) m = { ...m, ...m.boards[first], serial: '' };
        }
        this.mode = numMap(m.mode); this.out = numMap(m.out); this.pwm = numMap(m.pwm);
        this.servo = numMap(m.servo); this.tone = numMap(m.tone);
        this.lcd = cleanLcd(m.lcd);
        this.halted = m.halted === true;
        this.dev = m.boards ? Object.assign({}, ...Object.values(this.boards || {}).map((b) => b.dev)) : cleanDev(m.dev);
        const i2c = m.i2c || {}; this.i2c = { sda: finite(i2c.sda, 21), scl: finite(i2c.scl, 22) };
        const w = m.wifi || {}, q = m.mqtt || {};
        const wifi = { ...this.wifi, status: finite(w.status), ssid: str(w.ssid, 64) };
        const mqtt = { connected: q.connected === true, clientId: str(q.clientId, 64), host: str(q.host, 128), subs: Array.isArray(q.subs) ? q.subs.slice(0, 50).map((s) => str(s, 256)) : [], queue: [] };
        const changed = JSON.stringify([wifi.status, wifi.ssid, mqtt]) !== JSON.stringify([this.wifi.status, this.wifi.ssid, { ...this.mqtt, queue: [] }]);
        this.wifi = wifi; this.mqtt = mqtt;
        if (typeof m.serial === 'string' && m.serial) this.serialOut += m.serial.slice(-100000);
        const an = m.analog;
        if (an && typeof an === 'object') {
          const leds = {};
          if (an.leds && typeof an.leds === 'object') for (const k of Object.keys(an.leds)) if (/^[\w-]{1,32}(?::\w{1,3})?$/.test(k)) leds[k] = Math.min(1, Math.max(0, finite(an.leds[k]))); // "rgb1:R": one die of a multi-LED part
          const parts = {};
          if (an.parts && typeof an.parts === 'object') for (const k of Object.keys(an.parts)) if (/^[\w-]{1,32}$/.test(k)) parts[k] = Math.min(1, Math.max(0, finite(an.parts[k])));
          const burnt = Array.isArray(an.burnt) ? an.burnt.filter((k) => typeof k === 'string' && /^[\w-]{1,32}(?::\w{1,3})?$/.test(k)).slice(0, 200) : [];
          const mech = { motors: {}, relays: {} };
          if (an.mech && typeof an.mech === 'object') {
            for (const [k, v] of Object.entries(an.mech.motors || {})) if (/^[\w-]{1,32}$/.test(k) && Array.isArray(v)) mech.motors[k] = [finite(v[0]), finite(v[1])];
            for (const [k, v] of Object.entries(an.mech.relays || {})) if (/^[\w-]{1,32}$/.test(k)) mech.relays[k] = v ? 1 : 0;
          }
          this.analog = { mech, leds, parts, burnt, rtf: Math.max(0, finite(an.rtf, 1)), error: an.error ? str(an.error, 300) : null, work: finite(an.work), steps: finite(an.steps), newton: finite(an.newton) };
        }
        const sm = m.samples;
        if (sm && sm.t instanceof Float64Array && Array.isArray(sm.v) && sm.v.every((a) => a instanceof Float32Array && a.length === sm.t.length)) {
          this.app.onScopeSamples?.(sm.t, sm.v);
        }
        if (changed) this.app.iotChanged();
        break;
      }
      case 'log': this.app.log(str(m.msg), LEVELS.has(m.level) ? m.level : 'info', Number.isInteger(m.line) && m.line > 0 ? m.line : undefined, boardId(m.board)); break;
      case 'error': this.app.reportError({ message: str(m.message), stack: str(m.stack, 4000) }, boardId(m.board)); break;
      case 'nv': {
        const id = boardId(m.board) || (this.app.boards && this.app.boards()[0] ? this.app.boards()[0].id : '');
        if (id) this.nvStore[id] = cleanNv(m.nv);
        break;
      }
      case 'pub': if (this.running && m.m) this.brokerPublish(m.m.topic, m.m.payload, 'device'); break;
      case 'restart': if (this.running) setTimeout(() => this.app.restartSim(), 0); break;
      case 'done': { const r = this.resolveRun; this.resolveRun = null; if (r) r(m.ok !== false); if (m.ok === false) this.stop(true); break; }
      default: break;
    }
  }
}

export { SimHost };
