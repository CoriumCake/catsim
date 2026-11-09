/* More sensor / display libraries: Adafruit_BME280 + Adafruit_BMP280, MPU6050 (Adafruit_MPU6050 and the classic
 * i2cdevlib / Electronic Cats MPU6050), and LiquidCrystal (16×2 LCD in 4-bit parallel mode). */
import { callable, i2cCheck, partsOn, printMixin } from './util.js';

const G = 9.80665;

export function moreLibs({ sim, fmtValue, sprintf, gpioCheck }) {
  // ---------- BME280 / BMP280 ----------
  const env = (want, addr, what) => {
    const parts = i2cCheck(sim, 'bme280', what);
    const atAddr = parts.filter((c) => (+c.props.addr || 0x76) === addr);
    if (!atAddr.length) {
      if (parts.length) sim.warnOnce('bme-addr' + addr, `${what}: the sensor is at ${parts[0].props.addr}, but begin() looked at 0x${addr.toString(16)}. Use begin(${parts[0].props.addr}).`);
      return null;
    }
    const c = atAddr[0];
    if (c.props.model !== want) { sim.warnOnce('bme-model' + c.id, `${what}: ${c.id} is a ${c.props.model} (chip ID 0x${c.props.model === 'BME280' ? '60' : '58'}), so begin() fails. Use the Adafruit_${c.props.model} library.`); return null; }
    return sim.powered(c, 'VIN', 'GND') ? c : null;
  };
  class EnvSensor {
    constructor(model) { this.model = model; this.c = null; }
    begin(addr = 0x77) { this.addr = +addr; this.c = env(this.model, this.addr, this.model); return !!this.c; }
    _p() { return this.c ? this.c.props : null; }
    readTemperature() { const p = this._p(); return p ? Math.round(+p.temp * 100) / 100 : NaN; }
    readPressure() { const p = this._p(); return p ? +p.pressure * 100 : NaN; } // Pa
    readAltitude(sea = 1013.25) { const pa = this.readPressure(); return 44330 * (1 - Math.pow(pa / 100 / sea, 0.1903)); }
    seaLevelForAltitude(alt, pa) { return pa / Math.pow(1 - alt / 44330, 5.255); }
    sensorID() { return this.model === 'BME280' ? 0x60 : 0x58; }
    setSampling() {} takeForcedMeasurement() { return true; } getTemperatureSensor() { return null; }
  }
  class Adafruit_BME280 extends EnvSensor {
    constructor() { super('BME280'); }
    readHumidity() { const p = this._p(); return p ? Math.round(+p.hum * 100) / 100 : NaN; }
  }
  class Adafruit_BMP280 extends EnvSensor { constructor() { super('BMP280'); } }

  // ---------- MPU6050 ----------
  const imu = (addr) => {
    const parts = i2cCheck(sim, 'mpu6050', 'MPU6050');
    const c = parts.find((x) => (sim.pinLevel(x, 'AD0') === 1 ? 0x69 : 0x68) === addr);
    if (!c && parts.length) sim.warnOnce('mpu-addr' + addr, `MPU6050: begin() looked at 0x${addr.toString(16)}, but the sensor answers at 0x${sim.pinLevel(parts[0], 'AD0') === 1 ? '69' : '68'} (set by its AD0 pin).`);
    return c && sim.powered(c) ? c : null;
  };
  /** Acceleration (g) and rotation (°/s) of the part, from its roll / pitch / spin sliders. */
  const motion = (c) => {
    const r = (+c.props.roll * Math.PI) / 180, p = (+c.props.pitch * Math.PI) / 180;
    return { ax: -Math.sin(p), ay: Math.sin(r) * Math.cos(p), az: Math.cos(r) * Math.cos(p), gx: 0, gy: 0, gz: +c.props.spin || 0, t: +c.props.temp };
  };
  const ARANGE = [2, 4, 8, 16], GRANGE = [250, 500, 1000, 2000];
  class Adafruit_MPU6050 {
    constructor() { this.c = null; this.ar = 0; this.gr = 0; }
    begin(addr = 0x68) { this.c = imu(+addr); return !!this.c; }
    setAccelerometerRange(r) { this.ar = +r & 3; } getAccelerometerRange() { return this.ar; }
    setGyroRange(r) { this.gr = +r & 3; } getGyroRange() { return this.gr; }
    setFilterBandwidth() {} getFilterBandwidth() { return 0; } setSampleRateDivisor() {} enableSleep() {} reset() {}
    getEvent(a, g, t) {
      const m = this.c ? motion(this.c) : { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0, t: 0 };
      const cl = (v, lim) => Math.max(-lim, Math.min(lim, v));
      const lim = ARANGE[this.ar];
      if (a) a.acceleration = { x: cl(m.ax, lim) * G, y: cl(m.ay, lim) * G, z: cl(m.az, lim) * G };
      if (g) g.gyro = { x: (m.gx * Math.PI) / 180, y: (m.gy * Math.PI) / 180, z: (cl(m.gz, GRANGE[this.gr]) * Math.PI) / 180 };
      if (t) t.temperature = m.t;
      return true;
    }
  }
  class sensors_event_t { constructor() { this.acceleration = { x: 0, y: 0, z: 0 }; this.gyro = { x: 0, y: 0, z: 0 }; this.temperature = 0; } }
  /** i2cdevlib / Electronic Cats MPU6050: raw 16-bit readings (±2 g = 16384 LSB/g, ±250 °/s = 131 LSB/(°/s)). */
  class MPU6050 {
    constructor(addr) { this.addr = typeof addr === 'number' ? addr : 0x68; this.c = null; } // MPU6050_light passes Wire
    initialize() { this.c = imu(this.addr); }
    begin() { this.initialize(); return this.c ? 0 : 1; } // MPU6050_light: 0 = OK
    testConnection() { return !!imu(this.addr); }
    _m() { return this.c ? motion(this.c) : { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0, t: 0 }; }
    getMotion6() { const m = this._m(); const i = (v) => Math.max(-32768, Math.min(32767, Math.round(v))); return [i(m.ax * 16384), i(m.ay * 16384), i(m.az * 16384), i(m.gx * 131), i(m.gy * 131), i(m.gz * 131)]; }
    getAcceleration() { return this.getMotion6().slice(0, 3); }
    getRotation() { return this.getMotion6().slice(3); }
    getAccelerationX() { return this.getMotion6()[0]; } getAccelerationY() { return this.getMotion6()[1]; } getAccelerationZ() { return this.getMotion6()[2]; }
    getRotationX() { return this.getMotion6()[3]; } getRotationY() { return this.getMotion6()[4]; } getRotationZ() { return this.getMotion6()[5]; }
    getTemperature() { return Math.round((this._m().t - 36.53) * 340); }
    // MPU6050_light
    calcOffsets() {} update() {}
    getAccX() { return this._m().ax; } getAccY() { return this._m().ay; } getAccZ() { return this._m().az; }
    getGyroX() { return this._m().gx; } getGyroY() { return this._m().gy; } getGyroZ() { return this._m().gz; }
    getTemp() { return this._m().t; }
    getAngleX() { return this.c ? +this.c.props.roll : 0; } getAngleY() { return this.c ? -this.c.props.pitch : 0; } getAngleZ() { return 0; }
    setFullScaleAccelRange() {} setFullScaleGyroRange() {} setXAccelOffset() {} setYAccelOffset() {} setZAccelOffset() {} setXGyroOffset() {} setYGyroOffset() {} setZGyroOffset() {}
  }

  // ---------- LiquidCrystal (parallel, 4- or 8-bit) ----------
  class LiquidCrystal {
    /** (rs, en, d4, d5, d6, d7) · (rs, rw, en, d4…d7) · (rs, en, d0…d7) · (rs, rw, en, d0…d7) */
    constructor(...a) {
      a = a.map(Number);
      if (a.length === 6) [this.rs, this.en, ...this.d] = a;
      else if (a.length === 7) [this.rs, , this.en, ...this.d] = a;
      else if (a.length === 10) { this.rs = a[0]; this.en = a[1]; this.d = a.slice(6); }
      else { this.rs = a[0]; this.en = a[2]; this.d = a.slice(7); }
      for (const p of [this.rs, this.en, ...this.d]) gpioCheck(p, 'LiquidCrystal');
      this.cols = 16; this.rows = 2; this.cx = 0; this.cy = 0; this.on = true;
      this.buf = [0, 1].map(() => Array(16).fill(' '));
    }
    _part() {
      const c = partsOn(sim, this.rs, 'lcd_parallel', 'RS').find((x) => sim.pinGpios(x, 'E').includes(this.en));
      if (!c) { sim.warnOnce('lcdp' + this.rs, `LiquidCrystal: no 16×2 LCD has RS on pin ${this.rs} and E on pin ${this.en}.`); return null; }
      const bad = ['D4', 'D5', 'D6', 'D7'].filter((p, i) => !sim.pinGpios(c, p).includes(this.d[i]));
      if (bad.length) { sim.warnOnce('lcdd' + c.id, `LiquidCrystal: ${c.id}'s ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not wired to the data pins given (${this.d.join(', ')}), so it would show garbage.`); return null; }
      if (!sim.powered(c, 'VDD', 'VSS')) { sim.warnOnce('lcdp' + c.id, `LiquidCrystal: ${c.id} has no power — VDD to 5 V, VSS to GND.`); return null; }
      if ((sim.netOf(c.id + ':V0') || { keys: [] }).keys.length <= 1) sim.warnOnce('lcdv0' + c.id, `${c.id}: V0 (contrast) isn't connected — wire it to a 10 kΩ pot's wiper (or to GND) or the text is invisible.`);
      return c;
    }
    _show() {
      const c = this._part(); if (!c) return;
      const v0 = sim.pinLevel(c, 'V0');
      sim.dev[c.id] = { kind: 'lcd', buf: this.buf.map((r) => r.slice()), on: this.on, contrast: v0 == null ? 0.25 : 1 - v0, backlight: sim.pinLevel(c, 'A') === 1 && sim.pinLevel(c, 'K') === 0 };
    }
    begin(cols = 16, rows = 2) { this.cols = cols; this.rows = rows; this.clear(); }
    clear() { this.buf = [0, 1].map(() => Array(16).fill(' ')); this.cx = 0; this.cy = 0; this._show(); }
    home() { this.cx = 0; this.cy = 0; }
    setCursor(c, r) { this.cx = Math.trunc(c); this.cy = Math.trunc(r); }
    _out(s) {
      for (const ch of s) { if (ch === '\n' || ch === '\r') continue; if (this.cy >= 0 && this.cy < 2 && this.cx >= 0 && this.cx < 16) this.buf[this.cy][this.cx] = ch; this.cx++; }
      this._show();
    }
    display() { this.on = true; this._show(); } noDisplay() { this.on = false; this._show(); }
    cursor() {} noCursor() {} blink() {} noBlink() {} createChar() {} leftToRight() {} rightToLeft() {} autoscroll() {} noAutoscroll() {}
    scrollDisplayLeft() { this.buf.forEach((r) => r.push(r.shift())); this._show(); }
    scrollDisplayRight() { this.buf.forEach((r) => r.unshift(r.pop())); this._show(); }
  }
  printMixin(LiquidCrystal.prototype, fmtValue, sprintf);
  LiquidCrystal.prototype.println = function (v, f) { return this.print(v, f); }; // an LCD has no newline

  return {
    Adafruit_BME280: callable(Adafruit_BME280), Adafruit_BMP280: callable(Adafruit_BMP280),
    Adafruit_MPU6050: callable(Adafruit_MPU6050), sensors_event_t: callable(sensors_event_t), MPU6050: callable(MPU6050),
    MPU6050_RANGE_2_G: 0, MPU6050_RANGE_4_G: 1, MPU6050_RANGE_8_G: 2, MPU6050_RANGE_16_G: 3,
    MPU6050_RANGE_250_DEG: 0, MPU6050_RANGE_500_DEG: 1, MPU6050_RANGE_1000_DEG: 2, MPU6050_RANGE_2000_DEG: 3,
    MPU6050_BAND_260_HZ: 0, MPU6050_BAND_184_HZ: 1, MPU6050_BAND_94_HZ: 2, MPU6050_BAND_44_HZ: 3, MPU6050_BAND_21_HZ: 4, MPU6050_BAND_10_HZ: 5, MPU6050_BAND_5_HZ: 6,
    LiquidCrystal: callable(LiquidCrystal),
  };
}
