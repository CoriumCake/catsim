/* CatSim — page-side simulator. The sketch itself runs in js/sim-worker.js; this class mirrors the
 * board state from the worker's snapshots so parts can render (net/level logic is inherited from
 * Simulator), and forwards UI input to the worker. A share link can contain any sketch, so every
 * message from the worker is validated and coerced here before it reaches the UI. */
import { Simulator } from './runtime.js';
const LEVELS = new Set(['info', 'warn', 'error']);
const str = (v, max = 2000) => String(v ?? '').slice(0, max);
const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
// { gpio: number } maps only, with small integer keys
const numMap = (o) => {
  const r = {};
  if (o && typeof o === 'object') for (const k of Object.keys(o)) if (/^\d{1,2}$/.test(k) && typeof o[k] === 'number' && Number.isFinite(o[k])) r[k] = o[k];
  return r;
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
    this.resetHw(); this.ui = {};
    this.worker = this.spawn();
    if (!this.worker) return Promise.resolve(false);
    this.paused = false;
    this.worker.postMessage({ type: 'start', code: String(code), project: this.app.project, speed: this.speed });
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
  setPressed(id, on) { this.ui[id] = { ...(this.ui[id] || {}), pressed: on }; this.invalidate(); this.send({ type: 'ui', id, pressed: !!on }); }
  sendSerial(text) { this.send({ type: 'serial', text: String(text) }); }
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
        { const sp = finite(m.speed, this.speed); if (sp >= 0.05 && sp <= 100) this.speed = sp; }
        this.mode = numMap(m.mode); this.out = numMap(m.out); this.pwm = numMap(m.pwm);
        this.servo = numMap(m.servo); this.tone = numMap(m.tone);
        this.lcd = cleanLcd(m.lcd);
        const i2c = m.i2c || {}; this.i2c = { sda: finite(i2c.sda, 21), scl: finite(i2c.scl, 22) };
        const w = m.wifi || {}, q = m.mqtt || {};
        const wifi = { ...this.wifi, status: finite(w.status), ssid: str(w.ssid, 64) };
        const mqtt = { connected: q.connected === true, clientId: str(q.clientId, 64), host: str(q.host, 128), subs: Array.isArray(q.subs) ? q.subs.slice(0, 50).map((s) => str(s, 256)) : [], queue: [] };
        const changed = JSON.stringify([wifi.status, wifi.ssid, mqtt]) !== JSON.stringify([this.wifi.status, this.wifi.ssid, { ...this.mqtt, queue: [] }]);
        this.wifi = wifi; this.mqtt = mqtt;
        if (typeof m.serial === 'string' && m.serial) this.serialOut += m.serial.slice(-100000);
        if (changed) this.app.iotChanged();
        break;
      }
      case 'log': this.app.log(str(m.msg), LEVELS.has(m.level) ? m.level : 'info', Number.isInteger(m.line) && m.line > 0 ? m.line : undefined); break;
      case 'error': this.app.reportError({ message: str(m.message), stack: str(m.stack, 4000) }); break;
      case 'pub': if (this.running && m.m) this.brokerPublish(m.m.topic, m.m.payload, 'device'); break;
      case 'restart': if (this.running) setTimeout(() => this.app.restartSim(), 0); break;
      case 'done': { const r = this.resolveRun; this.resolveRun = null; if (r) r(m.ok !== false); if (m.ok === false) this.stop(true); break; }
      default: break;
    }
  }
}

export { SimHost };
