/* Stepper (Arduino), AccelStepper (Mike McCauley) and Ticker (ESP32). The stepper libraries only drive
 * the pins; the 28BYJ-48 part turns because of the coil pattern it sees, so pin order matters as on a real board. */
import { callable } from './util.js';

const OUTPUT = 0x03;

export function motionLibs({ sim, api, gpioCheck, sleep, check, runId }) {
  const pins = (list) => list.filter((p) => p !== undefined && p !== null).map(Number);
  const out = (p) => { if (gpioCheck(p, 'Stepper')) api.pinMode(p, OUTPUT); };

  // ---------- Stepper.h ----------
  class Stepper {
    constructor(steps, p1, p2, p3, p4, p5) {
      this.steps = Math.max(1, +steps | 0); this.pins = pins([p1, p2, p3, p4, p5]); this.n = 0; this.delayUs = 0; this.dir = 0;
      this.pins.forEach(out);
    }
    setSpeed(rpm) { this.delayUs = rpm > 0 ? (60 * 1000 * 1000) / this.steps / rpm : 0; }
    version() { return 5; }
    _motor(s) {
      const P = this.pins, w = (i, v) => api.digitalWrite(P[i], v);
      if (P.length === 2) { const pat = [[0, 1], [1, 1], [1, 0], [0, 0]][s % 4]; w(0, pat[0]); w(1, pat[1]); return; }
      if (P.length >= 4) { const pat = [[1, 0, 1, 0], [0, 1, 1, 0], [0, 1, 0, 1], [1, 0, 0, 1]][s % 4]; pat.forEach((v, i) => w(i, v)); }
    }
    async step(n) {
      n = Math.trunc(+n || 0);
      if (!this.delayUs) { sim.warnOnce('st-speed', 'Stepper: call setSpeed(rpm) before step() — the motor would not move.'); this.setSpeed(1); }
      for (let left = Math.abs(n); left > 0; left--) {
        check(); await sleep(this.delayUs / 1000); check();
        if (n > 0) { this.n++; if (this.n === this.steps) this.n = 0; } else { if (this.n === 0) this.n = this.steps; this.n--; }
        this._motor(this.n % 4);
      }
    }
  }

  // ---------- AccelStepper ----------
  const FUNCTION = 0, DRIVER = 1, FULL2WIRE = 2, FULL3WIRE = 3, FULL4WIRE = 4, HALF3WIRE = 6, HALF4WIRE = 8;
  class AccelStepper {
    constructor(iface = FULL4WIRE, p1 = 2, p2 = 3, p3 = 4, p4 = 5, enable = true) {
      this.iface = +iface; this.pins = [p1, p2, p3, p4].map(Number);
      this.pos = 0; this.target = 0; this.speed_ = 0; this.maxSpeed_ = 1; this.accel = 0; this.interval = 0; this.lastStep = 0;
      this.minPulse = 1; this.n = 0; this.c0 = 0; this.cn = 0; this.cmin = 1; this.dir = 0; this.inv = [0, 0, 0, 0];
      const used = { [DRIVER]: 2, [FULL2WIRE]: 2, [FULL3WIRE]: 3, [HALF3WIRE]: 3, [FULL4WIRE]: 4, [HALF4WIRE]: 4 }[this.iface] || 0;
      if (enable) this.pins.slice(0, used).forEach(out);
      this.used = used;
      this.setAcceleration(1);
      this.setMaxSpeed(1);
    }
    _us() { return sim.millis() * 1000; }
    moveTo(abs) { if (this.target !== +abs) { this.target = +abs; this._newSpeed(); } }
    move(rel) { this.moveTo(this.pos + +rel); }
    distanceToGo() { return this.target - this.pos; }
    targetPosition() { return this.target; } currentPosition() { return this.pos; }
    setCurrentPosition(p) { this.target = this.pos = +p; this.n = 0; this.interval = 0; this.speed_ = 0; }
    speed() { return this.speed_; } maxSpeed() { return this.maxSpeed_; } acceleration() { return this.accel; }
    setMaxSpeed(s) {
      s = Math.abs(+s);
      if (this.maxSpeed_ !== s) { this.maxSpeed_ = s; this.cmin = 1e6 / s; if (this.n > 0) { this.n = Math.trunc((this.speed_ * this.speed_) / (2 * this.accel)); this._newSpeed(); } }
    }
    setAcceleration(a) {
      a = Math.abs(+a); if (!a) return;
      if (this.accel !== a) { this.n = this.accel ? this.n * (this.accel / a) : this.n; this.c0 = 0.676 * Math.sqrt(2 / a) * 1e6; this.accel = a; this._newSpeed(); }
    }
    setSpeed(s) {
      s = +s; if (s === this.speed_) return;
      s = Math.max(-this.maxSpeed_, Math.min(this.maxSpeed_, s));
      if (s === 0) this.interval = 0; else { this.interval = Math.abs(1e6 / s); this.dir = s > 0 ? 1 : 0; }
      this.speed_ = s;
    }
    _newSpeed() {
      const dist = this.distanceToGo(); const toStop = Math.trunc((this.speed_ * this.speed_) / (2 * this.accel));
      if (dist === 0 && toStop <= 1) { this.interval = 0; this.speed_ = 0; this.n = 0; return; }
      if (dist > 0) {
        if (this.n > 0) { if (toStop >= dist || this.dir === 0) this.n = -toStop; } else if (this.n < 0) { if (toStop < dist && this.dir === 1) this.n = -this.n; }
      } else if (dist < 0) {
        if (this.n > 0) { if (toStop >= -dist || this.dir === 1) this.n = -toStop; } else if (this.n < 0) { if (toStop < -dist && this.dir === 0) this.n = -this.n; }
      }
      if (this.n === 0) { this.cn = this.c0; this.dir = dist > 0 ? 1 : 0; } else { this.cn = this.cn - (2 * this.cn) / (4 * this.n + 1); this.cn = Math.max(this.cn, this.cmin); }
      this.n++; this.interval = this.cn; this.speed_ = 1e6 / this.cn; if (this.dir === 0) this.speed_ = -this.speed_;
    }
    runSpeed() {
      if (!this.interval) return false;
      const t = this._us();
      if (t - this.lastStep >= this.interval) { this.pos += this.dir ? 1 : -1; this._step(this.pos); this.lastStep = t; return true; }
      return false;
    }
    run() { if (this.runSpeed()) this._newSpeed(); return this.speed_ !== 0 || this.distanceToGo() !== 0; }
    isRunning() { return !(this.speed_ === 0 && this.target === this.pos); }
    async runToPosition() { while (this.run()) { check(); await api.__y(); } }
    runSpeedToPosition() { if (this.target === this.pos) return false; this.dir = this.target > this.pos ? 1 : 0; return this.runSpeed(); }
    async runToNewPosition(p) { this.moveTo(p); await this.runToPosition(); }
    stop() { if (this.speed_ !== 0) { const s = Math.trunc((this.speed_ * this.speed_) / (2 * this.accel)) + 1; this.move(this.speed_ > 0 ? s : -s); } }
    _out(mask) { for (let i = 0; i < this.used; i++) api.digitalWrite(this.pins[i], ((mask >> i) & 1) ^ this.inv[i]); }
    _step(p) {
      switch (this.iface) {
        case DRIVER: api.digitalWrite(this.pins[1], this.dir ^ this.inv[1]); api.digitalWrite(this.pins[0], 1 ^ this.inv[0]); api.digitalWrite(this.pins[0], 0 ^ this.inv[0]); break;
        case FULL2WIRE: this._out([0b10, 0b11, 0b01, 0b00][p & 3]); break;
        case FULL3WIRE: this._out([0b100, 0b001, 0b010][((p % 3) + 3) % 3]); break;
        case HALF3WIRE: this._out([0b100, 0b101, 0b001, 0b011, 0b010, 0b110][((p % 6) + 6) % 6]); break;
        case FULL4WIRE: this._out([0b0101, 0b0110, 0b1010, 0b1001][p & 3]); break;
        case HALF4WIRE: this._out([0b0001, 0b0101, 0b0100, 0b0110, 0b0010, 0b1010, 0b1000, 0b1001][p & 7]); break;
        default: break;
      }
    }
    disableOutputs() { if (this.iface !== FUNCTION) this._out(0); }
    enableOutputs() { this.pins.slice(0, this.used).forEach(out); }
    setMinPulseWidth(w) { this.minPulse = +w; } setEnablePin() {}
    setPinsInverted(a = false, b = false, c = false, d = false) { this.inv = [a, b, c, d].map((x) => (x ? 1 : 0)); }
  }
  Object.assign(AccelStepper, { FUNCTION, DRIVER, FULL2WIRE, FULL3WIRE, FULL4WIRE, HALF3WIRE, HALF4WIRE });

  // ---------- Ticker (ESP32) ----------
  class Ticker {
    constructor() { this.gen = 0; this.on = false; }
    _start(ms, repeat, fn, arg) {
      this.detach(); const gen = ++this.gen; this.on = true;
      const fire = () => {
        if (gen !== this.gen || sim.runId !== runId || !sim.running) return;
        if (repeat) sim.clock.schedule(ms, fire); else this.on = false;
        sim.callUser(fn, arg);
      };
      sim.clock.schedule(Math.max(1, ms), fire);
    }
    attach(s, fn, arg) { this._start(+s * 1000, true, fn, arg); }
    attach_ms(ms, fn, arg) { this._start(+ms, true, fn, arg); }
    once(s, fn, arg) { this._start(+s * 1000, false, fn, arg); }
    once_ms(ms, fn, arg) { this._start(+ms, false, fn, arg); }
    detach() { this.gen++; this.on = false; }
    active() { return this.on; }
  }

  return { Stepper: callable(Stepper), AccelStepper: callable(AccelStepper), Ticker: callable(Ticker) };
}
