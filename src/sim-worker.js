/* CatSim — simulation worker. The user's sketch runs here, away from the page: it has no access to
 * the DOM, localStorage or the editor. The page sends circuit/UI updates in and receives state
 * snapshots out (see js/sim-host.js); every message from here is treated as untrusted on that side. */
import { Simulator, topicMatch } from './runtime.js';
import { AnalogBridge } from './analog/bridge.ts';
import { MultiRun } from './multi.ts';

let project = { components: [], wires: [] };
const post = (m, transfer = []) => self.postMessage(m, transfer);

const host = {
  get project() { return project; },
  log(msg, level, line) { post({ type: 'log', msg: String(msg), level, line }); },
  reportError(e) { post({ type: 'error', message: String((e && e.message) || e), stack: String((e && e.stack) || '') }); },
  iotChanged() { snapshot(); },
  onSimState(on) { post({ type: 'state', on }); if (on) startTicker(); },
  restartSim() { post({ type: 'restart' }); },
  nvChanged(nv) { post({ type: 'nv', nv: structuredClone(nv) }); },
};

const esp = new Simulator(host);
esp.analog = new AnalogBridge(esp);
/** the single-board runtime (ESP32 or Uno rules) */
const sim = esp;
// The MQTT broker and its log live on the page; the device side only forwards what it publishes.
esp.brokerPublish = (topic, payload, from) => {
  const m = { t: sim.millis(), topic: String(topic), payload: String(payload), from };
  if (from === 'device') post({ type: 'pub', m });
  if (sim.mqtt.connected && sim.mqtt.subs.some((f) => topicMatch(f, m.topic))) sim.mqtt.queue.push(m);
};

// ---------- several boards ----------
let multi = null;
const multiHost = {
  get project() { return project; },
  log(msg, level, line, board) { post({ type: 'log', msg: String(msg), level, line, board }); },
  reportError(e, board) { post({ type: 'error', message: String((e && e.message) || e), stack: String((e && e.stack) || ''), board }); },
  onPublish(m) { post({ type: 'pub', m, board: m.board }); },
  onRestart() { post({ type: 'restart' }); },
  onNv(board, nv) { post({ type: 'nv', nv: structuredClone(nv), board }); },
};

function snapshotMulti() {
  const a = multi.bridge, t = multi.clock.millis();
  const samples = a.takeSamples();
  const analog = { mech: a.mechanics(), parts: a.partActivity(), burnt: [...a.burnt], leds: a.ledBrightness(), rtf: multi.running ? a.realTimeFactor() : 1, error: a.error };
  post({ type: 'snap', t, running: multi.running, speed: multi.clock.speed, paused: multi.clock.paused, boards: multi.boardStates(), analog, samples },
    samples ? [samples.t.buffer, ...samples.v.map((v) => v.buffer)] : []);
}

function snapshot() {
  if (multi) { snapshotMulti(); return; }
  let serial = sim.serialOut; sim.serialOut = '';
  const a = sim.analog;
  const samples = a.takeSamples();
  const analog = { mech: a.mechanics(), parts: a.partActivity(), burnt: [...a.burnt], leds: a.ledBrightness(), rtf: sim.running ? a.realTimeFactor() : 1, error: a.error, work: a.workMs, steps: a.sim ? a.sim.stats.steps : 0, newton: a.sim ? a.sim.stats.newton : 0 };
  if (serial.length > 100000) serial = serial.slice(-100000);
  post({
    type: 'snap', t: sim.millis(), running: sim.running, serial, speed: sim.clock.speed, paused: sim.clock.paused,
    mode: sim.mode, out: sim.out, pwm: sim.pwm, servo: sim.servo, tone: sim.tone,
    lcd: sim.lcd, dev: sim.dev, halted: !!sim.halted, i2c: sim.i2c, wifi: { status: sim.wifi.status, ssid: sim.wifi.ssid },
    mqtt: { connected: sim.mqtt.connected, clientId: sim.mqtt.clientId, host: sim.mqtt.host, subs: sim.mqtt.subs },
    analog, samples,
    }, samples ? [samples.t.buffer, ...samples.v.map((v) => v.buffer)] : []);
}

let ticker = 0;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (multi) { if (multi.running) { multi.touch(); snapshotMulti(); } return; }
    if (!sim.running) return;
    sim.updateWifi(); sim.touch(); sim.checkPower(); sim.pollInterrupts(); snapshot();
  }, 16);
}

self.onmessage = (e) => {
  const m = e.data || {};
  switch (m.type) {
    case 'start':
      project = m.project;
      if (Array.isArray(m.boards) && m.boards.length > 1) {
        multi = new MultiRun(multiHost);
        const ok = multi.start(m.boards.map((b) => ({ id: String(b.id), type: String(b.type), code: typeof b.code === 'string' ? b.code : '', nv: b.nv && typeof b.nv === 'object' ? b.nv : {} })), +m.speed || 1);
        if (!ok) { post({ type: 'done', ok: false }); break; }
        post({ type: 'state', on: true }); startTicker();
        break;
      }
      sim.boardType = m.board === 'uno' || m.board === 'esp32c3' ? m.board : 'esp32';
      sim.nv = m.nv && typeof m.nv === 'object' ? m.nv : {};
      sim.invalidate();
      if (m.speed) sim.clock.speed = m.speed;
      sim.start(m.code).then((ok) => { snapshot(); post({ type: 'done', ok }); });
      break;
    case 'project': project = m.project; if (multi) { multi.invalidate(); multi.touch(); } else { sim.invalidate(); sim.pollInterrupts(); } break;
    case 'ui': (multi || sim).setPressed(String(m.id), !!m.pressed, (typeof m.key === 'string' && /^[\w*#+,-]{1,8}$/.test(m.key) ? m.key : undefined)); break;
    case 'pause': (multi || sim).pause(); snapshot(); break;
    case 'probes': (multi ? multi.bridge : sim.analog).setProbes(Array.isArray(m.refs) ? m.refs.map((r) => (typeof r === 'string' ? r : null)) : [], +m.dtMax); break;
    case 'resume': (multi || sim).resume(); snapshot(); break;
    case 'speed': (multi || sim).setSpeed(m.speed); snapshot(); break;
    case 'serial':
      if (multi) multi.sendSerial(String(m.board || ''), String(m.text));
      else sim.serialIn += String(m.text);
      break;
    case 'pub':
      if (multi) multi.publish('dashboard', m.topic, m.payload, 'dashboard');
      else if (sim.mqtt.connected && sim.mqtt.subs.some((f) => topicMatch(f, m.topic))) sim.mqtt.queue.push({ t: sim.millis(), topic: m.topic, payload: m.payload, from: 'dashboard' });
      break;
    default: break;
  }
};
