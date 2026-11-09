/* Input: Keypad (4×4 matrix), Bounce2 (debouncing) and IRremote (VS1838B receiver + NEC remote). */
import { callable, partsOn } from './util.js';
import { encoderState, encoderContacts } from '../analog/models-extra.ts';

/** The remote's keys and their NEC commands (address 0x00). */
export const IR_KEYS = [
  ['ch-', 0x45], ['ch', 0x46], ['ch+', 0x47],
  ['prev', 0x44], ['next', 0x40], ['play', 0x43],
  ['vol-', 0x07], ['vol+', 0x15], ['eq', 0x09],
  ['0', 0x16], ['100+', 0x19], ['200+', 0x0d],
  ['1', 0x0c], ['2', 0x18], ['3', 0x5e],
  ['4', 0x08], ['5', 0x1c], ['6', 0x5a],
  ['7', 0x42], ['8', 0x52], ['9', 0x4a],
];
const IR_CMD = Object.fromEntries(IR_KEYS);
const rev8 = (b) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i); return r; };
const NEC = 8;

/** New key events of component `id` since `seen` (events are { seq, key, down, t }). */
function newEvents(sim, id, seen) {
  const u = sim.ui[id]; if (!u || !u.events) return [];
  return u.events.filter((e) => e.seq > seen);
}

export function inputLibs({ sim, api, gpioCheck, check }) {
  // ---------- Keypad (Mark Stanley, Alexander Brevig) ----------
  const IDLE = 0, PRESSED = 1, HOLD = 2, RELEASED = 3;
  class Keypad {
    constructor(map, rowPins, colPins, rows, cols) {
      this.map = map; this.rows = Array.from(rowPins || []).slice(0, rows).map(Number); this.cols = Array.from(colPins || []).slice(0, cols).map(Number);
      this.seen = new Map(); this.state = IDLE; this.key = 0; this.downAt = 0; this.holdMs = 500; this.listener = null; this.queue = [];
      for (const p of [...this.rows, ...this.cols]) gpioCheck(p, 'Keypad');
    }
    /** Which character a press of the part's key "r,c" gives, following the wiring. */
    _char(c, key) {
      const [r, k] = String(key).split(',').map(Number);
      const i = this.rows.findIndex((g) => sim.pinGpios(c, 'R' + (r + 1)).includes(g));
      const j = this.cols.findIndex((g) => sim.pinGpios(c, 'C' + (k + 1)).includes(g));
      if (i < 0 || j < 0) { sim.warnOnce('kp' + c.id + key, `Keypad: ${c.id}'s row ${r + 1} / column ${k + 1} is not wired to the rowPins / colPins given to Keypad().`); return 0; }
      const row = this.map[i]; return row ? row[j] ?? 0 : 0;
    }
    _poll() {
      for (const c of sim.app.project.components) {
        if (c.type !== 'keypad') continue;
        const evs = newEvents(sim, c.id, this.seen.get(c.id) || 0);
        for (const e of evs) { this.seen.set(c.id, e.seq); const ch = this._char(c, e.key); if (ch) this.queue.push({ ch, down: e.down, t: e.t }); }
      }
    }
    _set(state, ch) { this.state = state; if (this.listener) sim.callUser(this.listener, ch); }
    getKey() {
      this._poll();
      if (this.state === PRESSED && sim.millis() - this.downAt >= this.holdMs) this._set(HOLD, this.key);
      while (this.queue.length) {
        const e = this.queue.shift();
        if (e.down) { this.key = e.ch; this.downAt = e.t; this._set(PRESSED, e.ch); return e.ch; }
        if (e.ch === this.key) { this._set(RELEASED, e.ch); this.state = IDLE; }
      }
      return 0; // NO_KEY
    }
    getKeys() { const k = this.getKey(); return !!k || this.state !== IDLE; }
    async waitForKey() { for (;;) { const k = this.getKey(); if (k) return k; check(); await api.delay(5); } }
    getState() { this.getKey(); return this.state; }
    keyStateChanged() { return false; }
    isPressed(ch) { return this.state !== IDLE && this.key === ch; }
    setDebounceTime() {} setHoldTime(ms) { this.holdMs = +ms; }
    addEventListener(fn) { this.listener = fn; }
    numKeys() { return this.rows.length * this.cols.length; }
    begin(map) { if (map) this.map = map; }
  }

  // ---------- Bounce2 ----------
  class Bounce {
    constructor(pin, interval) { this.pin = pin === undefined ? -1 : +pin; this.ms = interval === undefined ? 10 : +interval; this.state = 0; this.raw = 0; this.t = 0; this.since = 0; this.prevDur = 0; this.chg = false; if (this.pin >= 0) this._init(); }
    _init() { this.state = this.raw = api.digitalRead(this.pin); this.t = this.since = sim.millis(); }
    attach(pin, mode) { this.pin = +pin; if (mode !== undefined) api.pinMode(this.pin, mode); this._init(); }
    interval(ms) { this.ms = +ms; }
    update() {
      this.chg = false;
      const now = sim.millis(), v = api.digitalRead(this.pin);
      if (v !== this.raw) { this.raw = v; this.t = now; }
      if (this.raw !== this.state && now - this.t >= this.ms) { this.state = this.raw; this.prevDur = now - this.since; this.since = now; this.chg = true; }
      return this.chg;
    }
    read() { return this.state; } changed() { return this.chg; }
    fell() { return this.chg && this.state === 0; } rose() { return this.chg && this.state === 1; }
    duration() { return sim.millis() - this.since; } currentDuration() { return this.duration(); } previousDuration() { return this.prevDur; }
  }
  class Button extends Bounce {
    constructor(...a) { super(...a); this.pressedState = 0; }
    setPressedState(s) { this.pressedState = +s ? 1 : 0; } getPressedState() { return this.pressedState; }
    isPressed() { return this.state === this.pressedState; }
    pressed() { return this.chg && this.state === this.pressedState; }
    released() { return this.chg && this.state !== this.pressedState; }
  }

  // ---------- IRremote ----------
  class IRrecv {
    constructor(pin) { this.pin = pin === undefined ? -1 : +pin; this.seen = new Map(); this.held = null; this.nextRepeat = 0; this.decodedIRData = blank(); }
    begin(pin, feedback) { if (pin !== undefined) this.pin = +pin; if (this.pin >= 0) gpioCheck(this.pin, 'IrReceiver'); this.enabled = true; }
    enableIRIn() { this.begin(); } start() { this.enabled = true; } stop() { this.enabled = false; } resume() {} blink13() {} enableLEDFeedback() {} disableLEDFeedback() {}
    isIdle() { return true; }
    _receivers() { return partsOn(sim, this.pin, 'ir_receiver', 'OUT').filter((c) => sim.powered(c)); }
    _next() {
      if (!this.enabled || !this._receivers().length) {
        if (this.enabled && !partsOn(sim, this.pin, 'ir_receiver', 'OUT').length) sim.warnOnce('ir' + this.pin, `IRremote: no IR receiver's OUT pin is wired to pin ${this.pin}.`);
        return null;
      }
      let frame = null;
      for (const c of sim.app.project.components) {
        if (c.type !== 'ir_remote') continue;
        for (const e of newEvents(sim, c.id, this.seen.get(c.id) || 0)) {
          this.seen.set(c.id, e.seq);
          if (e.down && IR_CMD[e.key] !== undefined) { frame = frame || { cmd: IR_CMD[e.key], repeat: false }; this.held = { id: c.id, key: e.key }; this.nextRepeat = e.t + 108; }
          else if (!e.down && this.held && this.held.id === c.id) this.held = null;
        }
      }
      if (!frame && this.held && sim.ui[this.held.id]?.pressed && sim.millis() >= this.nextRepeat) { // holding a key sends NEC repeat frames
        frame = { cmd: IR_CMD[this.held.key], repeat: true }; this.nextRepeat = sim.millis() + 108;
      }
      return frame;
    }
    decode(results) {
      const f = this._next(); if (!f) return false;
      const raw = ((((~f.cmd) & 0xff) << 24) | (f.cmd << 16) | (0xff << 8) | 0x00) >>> 0;
      this.decodedIRData = { protocol: NEC, address: 0, command: f.cmd, extra: 0, numberOfBits: f.repeat ? 0 : 32, flags: f.repeat ? 0x01 : 0, decodedRawData: raw, rawDataPtr: null };
      if (results && typeof results === 'object') {
        results.decode_type = NEC; results.bits = 32; results.address = 0; results.command = f.cmd;
        results.value = f.repeat ? 0xffffffff : ((0x00ff << 16) | (rev8(f.cmd) << 8) | rev8((~f.cmd) & 0xff)) >>> 0;
      }
      return true;
    }
    available() { return this.decode(); }
    printIRResultShort(out) {
      const d = this.decodedIRData;
      const line = `Protocol=NEC Address=0x${d.address.toString(16).toUpperCase()} Command=0x${d.command.toString(16).toUpperCase()}${d.flags & 1 ? ' Repeat gap=108000us' : ` Raw-Data=0x${d.decodedRawData.toString(16).toUpperCase()} 32 bits LSB first`}`;
      (out && out.println ? out : api.Serial).println(line);
    }
    printIRResultMinimal(out) { (out && out.print ? out : api.Serial).print(`P=NEC A=0x0 C=0x${this.decodedIRData.command.toString(16).toUpperCase()}`); }
    printIRSendUsage(out) { (out && out.println ? out : api.Serial).println(`Send with: IrSender.sendNEC(0x0, 0x${this.decodedIRData.command.toString(16).toUpperCase()}, <numberOfRepeats>);`); }
  }
  const blank = () => ({ protocol: 0, address: 0, command: 0, extra: 0, numberOfBits: 0, flags: 0, decodedRawData: 0, rawDataPtr: null });
  class decode_results { constructor() { this.decode_type = 0; this.value = 0; this.bits = 0; this.address = 0; this.command = 0; } }
  const IrReceiver = new IRrecv();

  // ---------- rotary encoders: Encoder (PJRC) and ESP32Encoder ----------
  /** Quadrature counts (4 per detent) of the KY-040 whose CLK/DT are on pins a/b; null if none is wired. */
  const encCount = (a, b) => {
    let c = partsOn(sim, a, 'encoder', 'CLK').find((x) => sim.pinGpios(x, 'DT').includes(b)), sign = 1;
    if (!c) { c = partsOn(sim, b, 'encoder', 'CLK').find((x) => sim.pinGpios(x, 'DT').includes(a)); sign = -1; }
    if (!c) { sim.warnOnce('enc' + a, `Encoder: no KY-040 has CLK and DT on pins ${a} and ${b}.`); return null; }
    sim.touch();
    const st = encoderState(c.id);
    const [ca, cb] = encoderContacts(st, sim.millis());
    const dir = st.queue.length ? st.queue[0].dir : 0;
    const partial = dir ? (ca && cb ? 2 : ca || cb ? (dir > 0 === ca ? 1 : 3) : 0) : 0;
    return sign * (st.pos * 4 + dir * partial);
  };
  class Encoder {
    constructor(a, b) { this.a = +a; this.b = +b; this.offset = 0; gpioCheck(this.a, 'Encoder'); gpioCheck(this.b, 'Encoder'); }
    read() { const n = encCount(this.a, this.b); return n == null ? 0 : n - this.offset; }
    write(v) { const n = encCount(this.a, this.b); this.offset = (n ?? 0) - (+v || 0); }
    readAndReset() { const v = this.read(); this.write(0); return v; }
  }
  class ESP32Encoder {
    constructor() { this.div = 4; this.offset = 0; this.paused = null; }
    _at(a, b, per) { this.a = +a; this.b = +b; this.div = per; gpioCheck(this.a, 'ESP32Encoder'); gpioCheck(this.b, 'ESP32Encoder'); }
    attachFullQuad(a, b) { this._at(a, b, 4); } attach(a, b) { this._at(a, b, 4); }
    attachHalfQuad(a, b) { this._at(a, b, 2); } attachSingleEdge(a, b) { this._at(a, b, 1); }
    _raw() { const n = this.a === undefined ? null : encCount(this.a, this.b); return n == null ? 0 : Math.trunc((n * this.div) / 4); }
    getCount() { return this.paused ?? this._raw() - this.offset; }
    setCount(v) { this.offset = this._raw() - (+v || 0); return this.getCount(); }
    clearCount() { return this.setCount(0); }
    pauseCount() { this.paused = this.getCount(); } resumeCount() { this.paused = null; }
  }

  return {
    Keypad: callable(Keypad), makeKeymap: (k) => k, NO_KEY: 0, IDLE, PRESSED, HOLD, RELEASED,
    Bounce: callable(Bounce), Bounce2: { Button: callable(Button), Bounce: callable(Bounce) },
    IRrecv: callable(IRrecv), decode_results: callable(decode_results), IrReceiver,
    Encoder: callable(Encoder), ESP32Encoder: Object.assign(callable(ESP32Encoder), { useInternalWeakPullResistors: 0 }), puType: { up: 1, down: 2, none: 0 }, UP: 1, DOWN: 2, NONE: 0,
    NEC, UNKNOWN: 0, REPEAT: 0xffffffff, IRDATA_FLAGS_IS_REPEAT: 0x01, IRDATA_FLAGS_IS_AUTO_REPEAT: 0x02, IRDATA_FLAGS_PARITY_FAILED: 0x04,
    ENABLE_LED_FEEDBACK: true, DISABLE_LED_FEEDBACK: false, USE_DEFAULT_FEEDBACK_LED_PIN: 0,
    getProtocolString: (p) => (p === NEC ? 'NEC' : 'UNKNOWN'),
  };
}
