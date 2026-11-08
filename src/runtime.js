/* CatSim — ESP32 runtime: circuit nets, Arduino-ESP32 API, WiFi/MQTT/HTTP simulation. */
import { INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN } from './pins.js';
import { DEFS, ESP } from './components.js';
import { transpile } from './transpiler.js';
import { SimClock } from './clock.ts';
const STOP = { stop: true };
const STRICT_RESERVED = new Set(['yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'eval', 'arguments', 'await', 'enum']);
const VALID_GPIO = new Set([0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39]);
const DEVKIT_GPIO = new Set([1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39]);
// Base constants are Number objects so Serial.print(x, BIN) can tell a base from a decimal count.
const BASE = { BIN: new Number(2), OCT: new Number(8), DEC: new Number(10), HEX: new Number(16) };

const mc = new MessageChannel(); const mcQueue = [];
mc.port1.onmessage = () => { const f = mcQueue.shift(); if (f) f(); };
const macrotask = () => new Promise((r) => { mcQueue.push(r); mc.port2.postMessage(0); });

function makeUF() {
  const p = new Map();
  const find = (k) => {
    if (!p.has(k)) p.set(k, k);
    let r = k; while (p.get(r) !== r) r = p.get(r);
    while (p.get(k) !== r) { const n = p.get(k); p.set(k, r); k = n; }
    return r;
  };
  return { find, union: (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p.set(ra, rb); } };
}

function topicMatch(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function fmtValue(v, f) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Number && !(f instanceof Number)) v = +v;
  if (typeof v === 'number') {
    if (f instanceof Number) { const n = Math.trunc(v); return +f === 10 ? String(n) : (n < 0 ? n >>> 0 : n).toString(+f).toUpperCase(); }
    if (f !== undefined) return v.toFixed(Math.max(0, Math.min(20, +f)));
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (v == null) return '';
  return String(v);
}

function sprintf(fmt, ...a) {
  let i = 0;
  return String(fmt).replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?(?:ll|l|hh|h|z)?([diufFeEgGxXoscp%])/g, (m, flags, width, prec, conv) => {
    if (conv === '%') return '%';
    if (width === '*') width = String(a[i++]);
    const v = a[i++]; let s;
    switch (conv) {
      case 'd': case 'i': s = String(Math.trunc(Number(v))); break;
      case 'u': s = String(Math.trunc(Number(v)) >>> 0); break;
      case 'f': case 'F': s = Number(v).toFixed(prec === undefined ? 6 : +prec); break;
      case 'e': case 'E': s = Number(v).toExponential(prec === undefined ? 6 : +prec); if (conv === 'E') s = s.toUpperCase(); break;
      case 'g': case 'G': s = String(+Number(v).toPrecision(prec === undefined ? 6 : +prec || 1)); break;
      case 'x': s = (Number(v) >>> 0).toString(16); break;
      case 'X': s = (Number(v) >>> 0).toString(16).toUpperCase(); break;
      case 'o': s = (Number(v) >>> 0).toString(8); break;
      case 'c': s = typeof v === 'number' ? String.fromCharCode(v) : String(v ?? '')[0] || ''; break;
      case 'p': s = '0x3ffb' + Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0'); break;
      default: s = String(v ?? ''); if (prec !== undefined) s = s.slice(0, +prec);
    }
    if (flags.includes('+') && /[dif]/i.test(conv) && Number(v) >= 0) s = '+' + s;
    const w = width ? +width : 0;
    if (s.length < w) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && !/[sc]/.test(conv)) { const neg = s[0] === '-' || s[0] === '+'; s = (neg ? s[0] : '') + s.slice(neg ? 1 : 0).padStart(w - (neg ? 1 : 0), '0'); }
      else s = s.padStart(w);
    }
    return s;
  });
}

// Arduino String methods on JS strings (this app only).
const SP = String.prototype;
const def = (name, fn) => { if (!(name in SP)) Object.defineProperty(SP, name, { value: fn, configurable: true, writable: true }); };
def('toInt', function () { return parseInt(this, 10) || 0; });
def('toFloat', function () { return parseFloat(this) || 0; });
def('toDouble', function () { return parseFloat(this) || 0; });
def('equals', function (s) { return String(this) === String(s); });
def('equalsIgnoreCase', function (s) { return String(this).toLowerCase() === String(s).toLowerCase(); });
def('compareTo', function (s) { return String(this) < s ? -1 : String(this) > s ? 1 : 0; });
def('isEmpty', function () { return this.length === 0; });
def('remove', function (i, n) { return n === undefined ? this.slice(0, i) : this.slice(0, i) + this.slice(i + n); });

class Simulator {
  constructor(app) {
    this.app = app; this.running = false; this.runId = 0; this.ui = {};
    this.clock = new SimClock(); this.sleeps = new Set(); // pending delay() promises, rejected on stop
    this.analog = null; // AnalogBridge (set in the worker); null = logic-level simulation only
    // With several boards the clock and the circuit are shared: only their owner resets them.
    this.ownsClock = true; this.ownsAnalog = true;
    this.boardId = undefined; // which board this runtime drives in the circuit (undefined = the only one)
    this.resetHw();
  }

  resetHw() {
    this.mode = {}; this.out = {}; this.pwm = {}; this.servo = {}; this.tone = {}; this.dac = {};
    this.interrupts = []; this.serialIn = ''; this.serialOut = ''; this.lcd = null;
    this.wifi = { status: 0, ssid: '', connectAt: 0, mode: 'off' };
    this.mqtt = { connected: false, clientId: '', host: '', subs: [], queue: [] };
    this.broker = { log: [], topics: new Map() };
    this.ledcPin = {}; this.ledcCh = {}; this.warned = new Set();
    this.i2c = { sda: 21, scl: 22 }; this.adcBits = 12; this.pwmBits = 8;
    this.lastYield = performance.now(); this.stoppedAt = 0;
    this._nets = null;
  }

  millis() { return this.running ? this.clock.millis() : this.stoppedAt; }
  pause() { if (this.running) this.clock.pause(); }
  resume() { this.clock.resume(); }
  setSpeed(s) { this.clock.setSpeed(+s); }
  invalidate() { this._nets = null; }
  comp(id) { return this.app.project.components.find((c) => c.id === id); }

  warnOnce(key, msg, level = 'warn') {
    if (this.warned.has(key)) return;
    this.warned.add(key); this.app.log(msg, level);
  }

  // ---------- circuit ----------
  nets() {
    if (this._nets) return this._nets;
    const uf = makeUF(); const p = this.app.project;
    const myBoard = (p.components.find((c) => DEFS[c.type] && DEFS[c.type].board && c.type === 'esp32') || {}).id;
    for (const c of p.components) {
      const d = DEFS[c.type]; if (!d) continue;
      for (const pin of d.pins) uf.find(c.id + ':' + pin.id);
      if (d.internal) for (const [a, b] of d.internal(c, this)) uf.union(c.id + ':' + a, c.id + ':' + b);
    }
    for (const w of p.wires) uf.union(w.from, w.to);
    const keyNet = new Map(); const info = new Map(); const gpioNet = new Map();
    for (const c of p.components) {
      const d = DEFS[c.type]; if (!d) continue;
      for (const pin of d.pins) {
        const k = c.id + ':' + pin.id; const r = uf.find(k); keyNet.set(k, r);
        let n = info.get(r);
        if (!n) { n = { gnd: false, vcc: false, gpios: [], drivers: [], analog: [], keys: [] }; info.set(r, n); }
        n.keys.push(k);
        if (d.board) {
          // only this runtime's own board provides "my" GPIOs; other boards share ground and supplies,
          // and their GPIOs mean the net is driven from elsewhere (not floating)
          const mine = this.boardId ? c.id === this.boardId : c.id === myBoard;
          if (pin.kind === 'gnd') n.gnd = true;
          else if (pin.kind === 'vcc') n.vcc = true;
          else if (pin.kind === 'gpio') {
            if (mine && c.type === 'esp32') { n.gpios.push(pin.gpio); gpioNet.set(pin.gpio, n); } else n.foreign = true;
          }
        }
        if (d.drive && d.drive[pin.id]) n.drivers.push({ c, fn: d.drive[pin.id] });
        if (d.analog && d.analog[pin.id]) n.analog.push({ c, fn: d.analog[pin.id] });
      }
    }
    this._nets = { keyNet, info, gpioNet };
    return this._nets;
  }

  netOf(key) { const n = this.nets(); return n.info.get(n.keyNet.get(key)); }
  netOfGpio(g) { return this.nets().gpioNet.get(+g); }

  level(n, exclude) {
    if (!n) return null;
    if (n.gnd) return 0;
    if (n.vcc) return 1;
    for (const g of n.gpios) {
      if (g === exclude || this.mode[g] !== OUTPUT) continue;
      return this.pwm[g] ?? (this.out[g] ? 1 : 0);
    }
    for (const d of n.drivers) if (this.running) return d.fn(d.c, this);
    return null;
  }

  pinLevel(c, pinId) { return this.running ? this.level(this.netOf(c.id + ':' + pinId)) : null; }
  pinGpios(c, pinId) { const n = this.netOf(c.id + ':' + pinId); return n ? n.gpios : []; }
  powered(c, vcc = 'VCC', gnd = 'GND') { return this.pinLevel(c, vcc) === 1 && this.pinLevel(c, gnd) === 0; }

  /** Pin state changed (or is about to be read): bring the analog solution up to date. */
  touch() { if (this.analog && this.running) this.analog.sync(); }

  readPin(g) {
    if (this.mode[g] === OUTPUT) return this.out[g] ? 1 : 0;
    if (this.analog && this.running) {
      this.analog.sync();
      const a = this.analog.readDigital(g, this.boardId);
      if (a != null) return a;
    }
    let v = this.level(this.netOfGpio(g), g);
    if (v == null) v = (this.mode[g] === INPUT_PULLUP && g < 34) ? 1 : 0;
    return v >= 0.5 ? 1 : 0;
  }

  setPressed(id, on) {
    this.ui[id] = { ...(this.ui[id] || {}), pressed: on };
    this.invalidate(); this.pollInterrupts();
  }

  pollInterrupts() {
    if (!this.running) return;
    for (const it of this.interrupts) {
      const v = this.readPin(it.pin);
      if (v === it.last) continue;
      it.last = v;
      const fire = it.mode === 3 || (it.mode === 1 && v === 1) || (it.mode === 2 && v === 0);
      if (fire) this.callUser(it.fn);
    }
  }

  callUser(fn, ...args) {
    try {
      Promise.resolve(fn(...args)).catch((e) => { if (e !== STOP) this.app.reportError(e); });
    } catch (e) { if (e !== STOP) this.app.reportError(e); }
  }

  updateWifi() {
    const w = this.wifi;
    if (w.status === 6 && w.connectAt && this.millis() >= w.connectAt) {
      w.status = 3; w.connectAt = 0;
      this.app.log(`WiFi connected to "${w.ssid}" — IP 10.13.37.42`, 'info');
      this.app.iotChanged();
    }
  }

  brokerPublish(topic, payload, from) {
    const m = { t: this.millis(), topic, payload, from };
    this.broker.log.push(m); if (this.broker.log.length > 400) this.broker.log.shift();
    this.broker.topics.set(topic, { payload, from, at: Date.now() });
    if (this.mqtt.connected && this.mqtt.subs.some((f) => topicMatch(f, topic))) this.mqtt.queue.push(m);
    this.app.iotChanged();
  }

  // ---------- lifecycle ----------
  async start(code) {
    this.stop(true);
    this.resetHw(); this.ui = {};
    let js;
    try { js = transpile(code).js; } catch (e) {
      this.app.log(`Compile error${e.line ? ` (line ${e.line})` : ''}: ${e.message}`, 'error', e.line);
      return false;
    }
    const runId = ++this.runId;
    const api = this.createApi(runId);
    let factory;
    try {
      // Strict mode, no `with`: the API is unpacked into consts, and the sketch runs in an inner block so
      // its own declarations may shadow API names. Everything before the sketch stays on line 1 so that
      // error line numbers match the editor.
      const names = Object.keys(api).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !STRICT_RESERVED.has(k));
      // eslint-disable-next-line no-new-func
      factory = new Function('__api', `"use strict"; return (async function(){ const { ${names.join(', ')} } = __api; { ${js}\n;return { setup: typeof setup === 'function' ? setup : null, loop: typeof loop === 'function' ? loop : null }; } })();`);
    } catch (e) {
      this.app.log(`Compile error: ${e.message}. CatSim supports a subset of Arduino C++.`, 'error');
      console.debug('[CatSim] transpiled sketch:\n' + js);
      return false;
    }
    if (this.ownsClock) this.clock.reset();
    this.running = true; this.lastYield = performance.now();
    if (this.analog && this.ownsAnalog) this.analog.reset();
    this.app.onSimState(true);
    try {
      const mod = await factory(api);
      if (!mod.setup || !mod.loop) throw new Error('The sketch must define both setup() and loop()');
      await mod.setup();
      while (this.running && this.runId === runId) {
        await mod.loop();
        await api.__y();
      }
    } catch (e) {
      if (e === STOP) return true;
      this.app.reportError(e);
      if (this.runId === runId) this.stop();
    }
    return true;
  }

  stop(silent) {
    if (!this.running) return;
    this.stoppedAt = this.clock.millis(); this.running = false; this.runId++;
    // a shared clock keeps running for the other boards; this run's timers just turn into no-ops
    if (this.ownsClock) { this.clock.cancelAll(); this.clock.resume(); }
    for (const s of this.sleeps) s.reject(STOP);
    this.sleeps.clear();
    this.mqtt.connected = false;
    if (!silent) this.app.onSimState(false);
  }

  // ---------- Arduino API ----------
  createApi(runId) {
    const sim = this; const app = this.app;
    const check = () => { if (sim.runId !== runId || !sim.running) throw STOP; };
    const sleep = (ms) => new Promise((resolve, reject) => {
      const entry = { reject };
      sim.sleeps.add(entry);
      sim.clock.schedule(Math.max(0, ms), () => {
        sim.sleeps.delete(entry);
        if (sim.runId === runId && sim.running) { sim.lastYield = performance.now(); resolve(); } else reject(STOP);
      });
    });
    const gpioCheck = (pin, what) => {
      pin = +pin;
      if (pin >= 6 && pin <= 11) { sim.warnOnce('flash' + pin, `GPIO${pin} is wired to the SPI flash on ESP32 — using it will crash a real board.`, 'error'); return false; }
      if (!VALID_GPIO.has(pin)) { sim.warnOnce('inv' + pin, `GPIO${pin} does not exist on the ESP32 (${what}).`, 'error'); return false; }
      if (!DEVKIT_GPIO.has(pin)) sim.warnOnce('nb' + pin, `GPIO${pin} is not broken out on the 30-pin DevKit V1 board.`);
      return true;
    };
    const setPwm = (pin, frac) => {
      sim.mode[pin] = OUTPUT; sim.pwm[pin] = Math.min(1, Math.max(0, frac));
      sim.touch();
    };

    const Serial = {
      begin(baud) { sim.baud = baud; },
      end() {}, flush() {}, setTimeout() {}, setDebugOutput() {},
      print(v, f) { const s = fmtValue(v, f); sim.serialOut += s; return s.length; },
      println(v, f) { const s = (v === undefined ? '' : fmtValue(v, f)) + '\n'; sim.serialOut += s; return s.length; },
      printf(fmt, ...a) { const s = sprintf(fmt, ...a); sim.serialOut += s; return s.length; },
      write(b) { const s = typeof b === 'number' ? String.fromCharCode(b) : String(b); sim.serialOut += s; return s.length; },
      available() { return sim.serialIn.length; },
      read() { if (!sim.serialIn.length) return -1; const c = sim.serialIn[0]; sim.serialIn = sim.serialIn.slice(1); return c; },
      peek() { return sim.serialIn.length ? sim.serialIn[0] : -1; },
      readString() { const s = sim.serialIn; sim.serialIn = ''; return s; },
      readStringUntil(ch) {
        const i = sim.serialIn.indexOf(ch);
        const s = i < 0 ? sim.serialIn : sim.serialIn.slice(0, i);
        sim.serialIn = i < 0 ? '' : sim.serialIn.slice(i + 1); return s;
      },
      parseInt() { const m = sim.serialIn.match(/^\D*?(-?\d+)/); if (!m) return 0; sim.serialIn = sim.serialIn.slice(m[0].length); return +m[1]; },
      parseFloat() { const m = sim.serialIn.match(/^[^\d-]*?(-?\d+(?:\.\d+)?)/); if (!m) return 0; sim.serialIn = sim.serialIn.slice(m[0].length); return +m[1]; },
    };

    const IP = (s) => ({ toString: () => s, valueOf: () => s, toJSON: () => s });
    const SCAN = ['CatSim-Guest', 'Workshop-IoT', 'Home-2.4G'];
    const WiFi = {
      mode(m) { sim.wifi.mode = m; }, setHostname() { return true; }, setAutoReconnect() {}, persistent() {}, config() { return true; },
      begin(ssid, pass) {
        check();
        sim.wifi.ssid = String(ssid ?? '');
        if (!sim.wifi.ssid) { sim.wifi.status = 1; app.log('WiFi.begin(): empty SSID', 'warn'); return 1; }
        sim.wifi.status = 6; sim.wifi.connectAt = sim.millis() + 1200 + Math.random() * 800;
        app.log(`WiFi connecting to "${sim.wifi.ssid}"… (simulated network — any SSID/password works)`, 'info');
        app.iotChanged(); return 6;
      },
      status() { sim.updateWifi(); return sim.wifi.status; },
      isConnected() { return WiFi.status() === 3; },
      localIP() { return IP(WiFi.status() === 3 ? '10.13.37.42' : '0.0.0.0'); },
      gatewayIP() { return IP('10.13.37.1'); }, subnetMask() { return IP('255.255.255.0'); }, dnsIP() { return IP('10.13.37.1'); },
      macAddress() { return '24:0A:C4:CA:75:1A'; },
      RSSI() { return WiFi.status() === 3 ? -42 - Math.round(Math.random() * 12) : 0; },
      SSID(i) { return i === undefined ? sim.wifi.ssid : SCAN[i] || ''; },
      disconnect() { sim.wifi.status = 6; sim.wifi.connectAt = 0; sim.mqtt.connected = false; app.iotChanged(); return true; },
      reconnect() { if (sim.wifi.ssid) WiFi.begin(sim.wifi.ssid); return true; },
      scanNetworks() { return SCAN.length; }, encryptionType() { return 3; },
      softAP(ssid) { app.log(`Soft-AP "${ssid}" started at 192.168.4.1 (simulated)`, 'info'); return true; },
      softAPIP() { return IP('192.168.4.1'); },
    };

    class PubSubClient {
      constructor() { this.host = 'broker.catsim.local'; this.port = 1883; this.cb = null; this._state = -1; }
      setServer(h, p) { this.host = String(h); this.port = p || 1883; return this; }
      setCallback(fn) { this.cb = fn; return this; }
      setClient() { return this; } setKeepAlive() { return this; } setSocketTimeout() { return this; } setBufferSize() { return true; }
      connect(id) {
        check();
        if (WiFi.status() !== 3) { this._state = -2; return false; }
        Object.assign(sim.mqtt, { connected: true, clientId: String(id), host: `${this.host}:${this.port}`, subs: [], queue: [] });
        this._state = 0; app.log(`MQTT connected to ${this.host}:${this.port} as "${id}"`, 'info'); app.iotChanged();
        return true;
      }
      connected() { return sim.mqtt.connected && sim.wifi.status === 3; }
      state() { return this.connected() ? 0 : this._state; }
      publish(topic, payload) {
        if (!this.connected()) return false;
        sim.brokerPublish(String(topic), payload == null ? '' : fmtValue(payload), 'device'); return true;
      }
      subscribe(topic) { if (!this.connected()) return false; topic = String(topic); if (!sim.mqtt.subs.includes(topic)) sim.mqtt.subs.push(topic); app.iotChanged(); return true; }
      unsubscribe(topic) { sim.mqtt.subs = sim.mqtt.subs.filter((t) => t !== String(topic)); app.iotChanged(); return true; }
      loop() {
        check(); if (!this.connected()) return false;
        const q = sim.mqtt.queue.splice(0);
        for (const m of q) if (this.cb) sim.callUser(this.cb, m.topic, m.payload, m.payload.length);
        return true;
      }
      disconnect() { sim.mqtt.connected = false; app.iotChanged(); }
    }

    class WiFiClient { connect() { return WiFi.status() === 3; } connected() { return WiFi.status() === 3; } stop() {} setInsecure() {} setCACert() {} }

    class HTTPClient {
      begin(a, b) { this.url = String(b !== undefined ? b : a); this.headers = {}; this.body = ''; return true; }
      addHeader(k, v) { this.headers[k] = String(v); }
      setTimeout() {} setUserAgent() {} useHTTP10() {} setReuse() {}
      async _req(method, body) {
        check();
        if (WiFi.status() !== 3) return -1;
        try {
          const r = await fetch(this.url, { method, headers: this.headers, body: body === undefined ? undefined : String(body) });
          this.body = await r.text(); check(); return r.status;
        } catch (e) {
          if (e === STOP) throw e;
          check(); this.body = '';
          app.log(`HTTP ${method} ${this.url} failed: ${e.message}. Browsers only allow requests to servers that send CORS headers (and HTTPS on HTTPS pages).`, 'warn');
          return -1;
        }
      }
      GET() { return this._req('GET'); } POST(b) { return this._req('POST', b); } PUT(b) { return this._req('PUT', b); }
      PATCH(b) { return this._req('PATCH', b); } sendRequest(m, b) { return this._req(String(m), b); }
      getString() { return this.body || ''; } getSize() { return (this.body || '').length; }
      errorToString(c) { return c === -1 ? 'connection refused' : `HTTP error ${c}`; }
      end() {}
    }

    class DHT {
      constructor(pin, type) { this.pin = +pin; this.type = type || 22; }
      begin() { gpioCheck(this.pin, 'DHT'); }
      _sensor() {
        const n = sim.netOfGpio(this.pin);
        const c = n && n.keys.map((k) => k.split(':')).map(([id, pid]) => pid === 'DATA' && sim.comp(id)).find((x) => x && x.type === 'dht22');
        if (!c) { sim.warnOnce('dht' + this.pin, `DHT: no DHT22 DATA pin is wired to GPIO${this.pin} — reads return NaN.`); return null; }
        if (!sim.powered(c)) { sim.warnOnce('dhtp' + c.id, `DHT: ${c.id} has no power — wire VCC to 3V3 and GND to GND.`); return null; }
        return c;
      }
      readTemperature(f) { const c = this._sensor(); if (!c) return NaN; const t = Math.round(+c.props.temp * 10) / 10; return f ? t * 1.8 + 32 : t; }
      readHumidity() { const c = this._sensor(); return c ? Math.round(+c.props.hum * 10) / 10 : NaN; }
      convertCtoF(c) { return c * 1.8 + 32; } convertFtoC(f) { return (f - 32) / 1.8; }
      computeHeatIndex(t, h, isF = true) {
        const T = isF ? t : t * 1.8 + 32;
        let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + h * 0.094);
        if (hi > 79) hi = -42.379 + 2.04901523 * T + 10.14333127 * h - 0.22475541 * T * h - 0.00683783 * T * T - 0.05481717 * h * h + 0.00122874 * T * T * h + 0.00085282 * T * h * h - 0.00000199 * T * T * h * h;
        return isF ? hi : (hi - 32) / 1.8;
      }
    }

    class Servo {
      attach(pin) { pin = +pin; gpioCheck(pin, 'Servo'); this.pin = pin; sim.mode[pin] = OUTPUT; if (sim.servo[pin] == null) sim.servo[pin] = 90; sim.touch(); return 1; }
      write(a) { if (this.pin == null) return; a = +a; if (a > 200) return this.writeMicroseconds(a); sim.servo[this.pin] = Math.min(180, Math.max(0, a)); sim.touch(); }
      writeMicroseconds(us) { this.write(((+us - 544) / (2400 - 544)) * 180); }
      read() { return Math.round(sim.servo[this.pin] ?? 90); }
      attached() { return this.pin != null; } detach() { this.pin = null; } setPeriodHertz() {}
    }

    class LiquidCrystal_I2C {
      constructor(addr, cols = 16, rows = 2) {
        if (!sim.lcd) sim.lcd = { cols: 16, rows: 2, buf: [], cx: 0, cy: 0, backlight: false, display: true };
        this.s = sim.lcd; this.clear();
      }
      init() { this.clear(); } begin() { this.clear(); }
      clear() { this.s.buf = [0, 1].map(() => Array(16).fill(' ')); this.s.cx = 0; this.s.cy = 0; }
      home() { this.s.cx = 0; this.s.cy = 0; }
      setCursor(c, r) { this.s.cx = Math.trunc(c); this.s.cy = Math.trunc(r); }
      print(v, f) {
        const str = fmtValue(v, f);
        for (const ch of str) { if (this.s.cy >= 0 && this.s.cy < 2 && this.s.cx >= 0 && this.s.cx < 16) this.s.buf[this.s.cy][this.s.cx] = ch; this.s.cx++; }
        return str.length;
      }
      write(ch) { return this.print(typeof ch === 'number' ? (ch === 223 ? '°' : String.fromCharCode(ch)) : ch); }
      backlight() { this.s.backlight = true; } noBacklight() { this.s.backlight = false; } setBacklight(v) { this.s.backlight = !!v; }
      display() { this.s.display = true; } noDisplay() { this.s.display = false; }
      cursor() {} noCursor() {} blink() {} noBlink() {} createChar() {}
      scrollDisplayLeft() { this.s.buf.forEach((r) => r.push(r.shift())); }
      scrollDisplayRight() { this.s.buf.forEach((r) => r.unshift(r.pop())); }
    }

    const writeLedc = (x, duty) => {
      const pins = sim.ledcPin[x] && sim.ledcPin[x].direct ? [x] : (sim.ledcCh[x] ? sim.ledcCh[x].pins : null);
      if (!pins) { sim.warnOnce('ledc' + x, `ledcWrite(${x}): pin/channel not attached — call ledcAttach(pin, freq, bits) first.`); return false; }
      for (const p of pins) {
        const bits = (sim.ledcPin[p] && sim.ledcPin[p].bits) || 8;
        setPwm(p, duty / ((1 << bits) - 1));
      }
      return true;
    };

    const api = {
      __y() {
        check();
        const paused = sim.clock.whenRunning();
        if (paused) return paused.then(check);
        if (performance.now() - sim.lastYield > 12) { sim.lastYield = performance.now(); return macrotask().then(check); }
        return undefined;
      },
      __i: (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : v),
      __arr: function mk(n, ...rest) { return Array.from({ length: Math.max(0, n | 0) }, () => (rest.length ? mk(...rest) : 0)); },
      __sizeof: (x) => (Array.isArray(x) || typeof x === 'string' ? x.length : 4),

      HIGH: 1, LOW: 0, INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN, PULLUP: 0x04, PULLDOWN: 0x08,
      RISING: 1, FALLING: 2, CHANGE: 3, ONLOW: 4, ONHIGH: 5, LED_BUILTIN: 2,
      ...BASE,
      A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35, A10: 4, A11: 0, A12: 2, A13: 15, A14: 13, A15: 12, A16: 14, A17: 27, A18: 25, A19: 26,
      T0: 4, T1: 0, T2: 2, T3: 15, T4: 13, T5: 12, T6: 14, T7: 27, T8: 33, T9: 32, DAC1: 25, DAC2: 26,
      SDA: 21, SCL: 22, MOSI: 23, MISO: 19, SCK: 18, SS: 5, TX: 1, RX: 3,
      WL_IDLE_STATUS: 0, WL_NO_SSID_AVAIL: 1, WL_SCAN_COMPLETED: 2, WL_CONNECTED: 3, WL_CONNECT_FAILED: 4, WL_CONNECTION_LOST: 5, WL_DISCONNECTED: 6,
      WIFI_STA: 1, WIFI_AP: 2, WIFI_AP_STA: 3, WIFI_OFF: 0, HTTP_CODE_OK: 200,
      DHT11: 11, DHT22: 22, DHT21: 21, AM2301: 21,
      ADC_0db: 0, ADC_2_5db: 1, ADC_6db: 2, ADC_11db: 3,
      PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI, EULER: Math.E,

      Serial, Serial2: Serial, WiFi, PubSubClient, WiFiClient, WiFiClientSecure: WiFiClient, HTTPClient, DHT, Servo, LiquidCrystal_I2C,
      Wire: { begin(sda, scl) { if (sda != null && scl != null) sim.i2c = { sda: +sda, scl: +scl }; return true; }, setClock() {} },
      ESP: {
        restart() { app.log('ESP.restart()', 'info'); setTimeout(() => app.restartSim(), 50); throw STOP; },
        getFreeHeap: () => 284000 + Math.round(Math.random() * 2000), getHeapSize: () => 327680,
        getChipModel: () => 'ESP32-D0WDQ6', getChipRevision: () => 3, getChipCores: () => 2, getCpuFreqMHz: () => 240,
        getFlashChipSize: () => 4194304, getSdkVersion: () => 'catsim-sim', getEfuseMac: () => 0x1A75CAC40A24,
      },

      pinMode(pin, m) {
        pin = +pin; if (!gpioCheck(pin, 'pinMode')) return;
        if (pin >= 34 && m === OUTPUT) sim.warnOnce('io' + pin, `GPIO${pin} is input-only on ESP32 — it cannot be an OUTPUT.`, 'error');
        if (pin >= 34 && (m === INPUT_PULLUP || m === INPUT_PULLDOWN)) sim.warnOnce('pu' + pin, `GPIO${pin} has no internal pull-up/pull-down on ESP32 — add an external resistor.`);
        sim.mode[pin] = pin >= 34 && m === OUTPUT ? INPUT : m;
        if (m === OUTPUT && sim.out[pin] === undefined) sim.out[pin] = 0;
        sim.touch();
        sim.interrupts.forEach((it) => { if (it.pin === pin) it.last = sim.readPin(pin); });
      },
      digitalWrite(pin, v) {
        pin = +pin;
        if (sim.mode[pin] !== OUTPUT) {
          if (!VALID_GPIO.has(pin)) return gpioCheck(pin, 'digitalWrite');
          sim.warnOnce('dw' + pin, `digitalWrite(${pin}) on a pin that is not an OUTPUT — call pinMode(${pin}, OUTPUT) first.`);
          return;
        }
        delete sim.pwm[pin]; delete sim.dac[pin]; sim.out[pin] = v && v !== '0' ? 1 : 0;
        sim.touch();
      },
      digitalRead(pin) {
        pin = +pin;
        if (sim.mode[pin] === undefined) sim.warnOnce('dr' + pin, `digitalRead(${pin}) before pinMode() — pin is floating.`);
        else if (sim.mode[pin] === INPUT && sim.level(sim.netOfGpio(pin), pin) == null && !(sim.netOfGpio(pin) || {}).foreign) sim.warnOnce('fl' + pin, `GPIO${pin} is floating (nothing drives it). Use INPUT_PULLUP or a pull resistor.`);
        return sim.readPin(pin);
      },
      analogRead(pin) {
        pin = +pin;
        if (!(pin in ESP.ADC1) && !(pin in ESP.ADC2)) { sim.warnOnce('adc' + pin, `GPIO${pin} is not an ADC pin.`, 'error'); return 0; }
        if (pin in ESP.ADC2 && sim.wifi.status !== 0) {
          sim.warnOnce('adc2' + pin, `GPIO${pin} is on ADC2, which is unavailable while WiFi is on. Use an ADC1 pin (32–39).`, 'error');
          return 0;
        }
        const max = (1 << sim.adcBits) - 1;
        if (sim.analog && sim.running) {
          sim.analog.sync();
          const v = sim.analog.gpioVoltage(pin, sim.boardId);
          if (v != null) return Math.round(Math.min(1, Math.max(0, v / 3.3)) * max);
        }
        const n = sim.netOfGpio(pin);
        if (n && n.analog.length) return Math.round(Math.min(1, Math.max(0, n.analog[0].fn(n.analog[0].c, sim))) * max);
        const lv = sim.level(n, pin);
        return lv == null ? Math.round(Math.random() * 40) : Math.round(lv * max);
      },
      analogReadMilliVolts(pin) { return Math.round((api.analogRead(pin) / ((1 << sim.adcBits) - 1)) * 3300); },
      analogReadResolution(b) { sim.adcBits = Math.min(16, Math.max(1, b | 0)); },
      analogSetAttenuation() {}, analogSetPinAttenuation() {}, analogSetWidth(b) { sim.adcBits = b | 0; },
      analogWrite(pin, v) { pin = +pin; if (!gpioCheck(pin, 'analogWrite')) return; setPwm(pin, v / ((1 << sim.pwmBits) - 1)); },
      analogWriteResolution(b) { sim.pwmBits = b | 0; }, analogWriteFrequency() {},
      dacWrite(pin, v) { if (pin !== 25 && pin !== 26) { sim.warnOnce('dac' + pin, `dacWrite: GPIO${pin} is not a DAC pin (only 25 and 26).`, 'error'); return; } sim.dac[+pin] = Math.min(255, Math.max(0, +v)) / 255; setPwm(+pin, v / 255); },
      touchRead(pin) { return 60 + Math.round(Math.random() * 8); },
      hallRead() { return Math.round(Math.random() * 10 - 5); },
      temperatureRead() { return 46 + Math.random(); },

      ledcSetup(ch, freq, bits) { sim.ledcCh[ch] = { freq, bits, pins: [] }; return freq; },
      ledcAttachPin(pin, ch) { pin = +pin; if (!sim.ledcCh[ch]) sim.ledcCh[ch] = { freq: 5000, bits: 8, pins: [] }; sim.ledcCh[ch].pins.push(pin); sim.ledcPin[pin] = { bits: sim.ledcCh[ch].bits, ch }; setPwm(pin, 0); },
      ledcAttach(pin, freq, bits) { pin = +pin; if (!gpioCheck(pin, 'ledcAttach')) return false; sim.ledcPin[pin] = { bits: bits || 8, freq, direct: true }; setPwm(pin, 0); return true; },
      ledcAttachChannel(pin, freq, bits, ch) { api.ledcSetup(ch, freq, bits); api.ledcAttachPin(pin, ch); return true; },
      ledcWrite(x, duty) { return writeLedc(+x, +duty); },
      ledcWriteTone(x, freq) {
        const pins = sim.ledcPin[x] && sim.ledcPin[x].direct ? [x] : (sim.ledcCh[x] ? sim.ledcCh[x].pins : [x]);
        pins.forEach((p) => { sim.mode[p] = OUTPUT; if (freq > 0) sim.tone[p] = freq; else delete sim.tone[p]; });
        sim.touch();
        return freq;
      },
      ledcDetach(pin) { delete sim.ledcPin[pin]; delete sim.pwm[pin]; sim.touch(); return true; }, ledcDetachPin(pin) { api.ledcDetach(pin); },
      tone(pin, freq, dur) {
        pin = +pin; sim.mode[pin] = OUTPUT; sim.tone[pin] = +freq;
        sim.touch();
        if (dur) sim.clock.schedule(+dur, () => { if (sim.tone[pin] === +freq) { delete sim.tone[pin]; sim.touch(); } });
      },
      noTone(pin) { delete sim.tone[+pin]; sim.touch(); },

      MSBFIRST: 1, LSBFIRST: 0,
      shiftOut(dataPin, clockPin, bitOrder, val) {
        for (let i = 0; i < 8; i++) {
          const bit = bitOrder === 0 ? (val >> i) & 1 : (val >> (7 - i)) & 1;
          api.digitalWrite(dataPin, bit);
          api.digitalWrite(clockPin, 1);
          api.digitalWrite(clockPin, 0);
        }
      },
      attachInterrupt(pin, fn, mode) { pin = +pin; sim.interrupts = sim.interrupts.filter((i) => i.pin !== pin); sim.interrupts.push({ pin, fn, mode, last: sim.readPin(pin) }); },
      detachInterrupt(pin) { sim.interrupts = sim.interrupts.filter((i) => i.pin !== +pin); },
      digitalPinToInterrupt: (p) => p, interrupts() {}, noInterrupts() {},

      millis: () => Math.floor(sim.millis()),
      micros: () => Math.floor(sim.millis() * 1000),
      delay(ms) { check(); return sleep(+ms || 0).then(check); },
      delayMicroseconds(us) { check(); return us >= 1000 ? sleep(us / 1000).then(check) : api.__y(); },
      yield() { return api.__y(); },

      map: (x, a, b, c, d) => (b === a ? c : Math.trunc(((x - a) * (d - c)) / (b - a) + c)),
      constrain: (x, a, b) => Math.min(b, Math.max(a, x)),
      min: Math.min, max: Math.max, abs: Math.abs, fabs: Math.abs, pow: Math.pow, sqrt: Math.sqrt, sq: (x) => x * x,
      sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
      exp: Math.exp, log: Math.log, log10: Math.log10, floor: Math.floor, ceil: Math.ceil, round: Math.round, fmod: (a, b) => a % b,
      isnan: Number.isNaN, isinf: (x) => !Number.isFinite(x) && !Number.isNaN(x),
      random: (a, b) => (b === undefined ? Math.floor(Math.random() * a) : Math.floor(a + Math.random() * (b - a))),
      randomSeed() {}, esp_random: () => Math.floor(Math.random() * 0xffffffff),
      lowByte: (x) => x & 0xff, highByte: (x) => (x >> 8) & 0xff, bit: (n) => 1 << n,
      bitRead: (x, n) => (x >> n) & 1, bitSet: (x, n) => x | (1 << n), bitClear: (x, n) => x & ~(1 << n),
      bitWrite: (x, n, b) => (b ? x | (1 << n) : x & ~(1 << n)),
      isDigit: (c) => /^[0-9]$/.test(c), isAlpha: (c) => /^[A-Za-z]$/.test(c), isSpace: (c) => /^\s$/.test(c),
      atoi: (s) => parseInt(s, 10) || 0, atol: (s) => parseInt(s, 10) || 0, atof: (s) => parseFloat(s) || 0,
      strlen: (s) => String(s).length, strcmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      String: (v, f) => (v === undefined ? '' : (typeof v === 'number' && f !== undefined) ? fmtValue(v, f) : fmtValue(v)),
      int: (x) => Math.trunc(Number(x)) || 0, long: (x) => Math.trunc(Number(x)) || 0, float: Number, double: Number, byte: (x) => x & 0xff,
      F: (s) => s, PSTR: (s) => s,
      __sprintf: (fmt, ...a) => sprintf(fmt, ...a), __snprintf: (n, fmt, ...a) => sprintf(fmt, ...a).slice(0, Math.max(0, n - 1)),
      __dtostrf: (v, w, p) => Number(v).toFixed(p).padStart(w),
    };
    return api;
  }
}

export { topicMatch, Simulator, STOP };
