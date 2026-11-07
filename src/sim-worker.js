/* CatSim — simulation worker. The user's sketch runs here, away from the page: it has no access to
 * the DOM, localStorage or the editor. The page sends circuit/UI updates in and receives state
 * snapshots out (see js/sim-host.js); every message from here is treated as untrusted on that side. */
import { Simulator, topicMatch } from './runtime.js';
import { AnalogBridge } from './analog/bridge.ts';

let project = { components: [], wires: [] };
const post = (m, transfer = []) => self.postMessage(m, transfer);

const host = {
  get project() { return project; },
  log(msg, level, line) { post({ type: 'log', msg: String(msg), level, line }); },
  reportError(e) { post({ type: 'error', message: String((e && e.message) || e), stack: String((e && e.stack) || '') }); },
  iotChanged() { snapshot(); },
  onSimState(on) { post({ type: 'state', on }); if (on) startTicker(); },
  restartSim() { post({ type: 'restart' }); },
};

const sim = new Simulator(host);
sim.analog = new AnalogBridge(sim);
// The MQTT broker and its log live on the page; the device side only forwards what it publishes.
sim.brokerPublish = (topic, payload, from) => {
  const m = { t: sim.millis(), topic: String(topic), payload: String(payload), from };
  if (from === 'device') post({ type: 'pub', m });
  if (sim.mqtt.connected && sim.mqtt.subs.some((f) => topicMatch(f, m.topic))) sim.mqtt.queue.push(m);
};

function snapshot() {
  let serial = sim.serialOut; sim.serialOut = '';
  const a = sim.analog;
  const samples = a.takeSamples();
  const analog = { parts: a.partActivity(), burnt: [...a.burnt], leds: a.ledBrightness(), rtf: sim.running ? a.realTimeFactor() : 1, error: a.error, work: a.workMs, steps: a.sim ? a.sim.stats.steps : 0, newton: a.sim ? a.sim.stats.newton : 0 };
  if (serial.length > 100000) serial = serial.slice(-100000);
  post({
    type: 'snap', t: sim.millis(), running: sim.running, serial, speed: sim.clock.speed, paused: sim.clock.paused,
    mode: sim.mode, out: sim.out, pwm: sim.pwm, servo: sim.servo, tone: sim.tone,
    lcd: sim.lcd, i2c: sim.i2c, wifi: { status: sim.wifi.status, ssid: sim.wifi.ssid },
    mqtt: { connected: sim.mqtt.connected, clientId: sim.mqtt.clientId, host: sim.mqtt.host, subs: sim.mqtt.subs },
    analog, samples,
    }, samples ? [samples.t.buffer, ...samples.v.map((v) => v.buffer)] : []);
}

let ticker = 0;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!sim.running) return;
    sim.updateWifi(); sim.touch(); sim.pollInterrupts(); snapshot();
  }, 16);
}

self.onmessage = (e) => {
  const m = e.data || {};
  switch (m.type) {
    case 'start':
      project = m.project; sim.invalidate();
      if (m.speed) sim.clock.speed = m.speed;
      sim.start(m.code).then((ok) => { snapshot(); post({ type: 'done', ok }); });
      break;
    case 'project': project = m.project; sim.invalidate(); sim.pollInterrupts(); break;
    case 'ui': sim.setPressed(m.id, !!m.pressed); break;
    case 'pause': sim.pause(); snapshot(); break;
    case 'probes': sim.analog.setProbes(Array.isArray(m.refs) ? m.refs.map((r) => (typeof r === 'string' ? r : null)) : [], +m.dtMax); break;
    case 'resume': sim.resume(); snapshot(); break;
    case 'speed': sim.setSpeed(m.speed); snapshot(); break;
    case 'serial': sim.serialIn += String(m.text); break;
    case 'pub': if (sim.mqtt.connected && sim.mqtt.subs.some((f) => topicMatch(f, m.topic))) sim.mqtt.queue.push({ t: sim.millis(), topic: m.topic, payload: m.payload, from: 'dashboard' }); break;
    default: break;
  }
};
