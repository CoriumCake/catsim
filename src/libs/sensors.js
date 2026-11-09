/* Sensors: OneWire + DallasTemperature (DS18B20), NewPing (HC-SR04) and RTClib (DS3231 / DS1307). */
import { callable, partsOn, i2cParts, i2cCheck, hash32, crc8 } from './util.js';

const DISCONNECTED_C = -127;

export function sensorLibs({ sim, gpioCheck, sleep, check }) {
  // ---------- OneWire / DallasTemperature ----------
  const romOf = (c) => {
    const h = hash32(c.id), h2 = hash32(c.id + '#');
    const rom = [0x28, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff, (h >> 24) & 0xff, h2 & 0xff, (h2 >> 8) & 0xff, 0];
    rom[7] = crc8(rom, 7);
    return rom;
  };
  const busSensors = (pin) => {
    const all = partsOn(sim, pin, 'ds18b20', 'DQ').sort((a, b) => (a.id < b.id ? -1 : 1));
    if (all.length && !sim.warned.has('owpu' + pin)) {
      // the bus is open-drain: it needs a pull-up (typically 4.7 kΩ) from DQ to the supply
      const dq = sim.netOf(all[0].id + ':DQ');
      const pulled = sim.app.project.components.some((r) => r.type === 'resistor' && ['1', '2'].some((p, i) => sim.netOf(r.id + ':' + p) === dq && (sim.netOf(r.id + ':' + ['2', '1'][i]) || {}).vcc));
      if (!pulled) sim.warnOnce('owpu' + pin, `OneWire: the DS18B20 bus on GPIO${pin} has no pull-up resistor (4.7 kΩ from DQ to 3V3/5V). A real sensor would not answer.`);
    }
    return all.filter((c) => sim.powered(c, 'VDD', 'GND') || (sim.powered(c, 'DQ', 'GND') && sim.pinLevel(c, 'VDD') === 0));
  };
  class OneWire {
    constructor(pin) { this.pin = +pin; gpioCheck(this.pin, 'OneWire'); this.next = 0; }
    begin(pin) { if (pin !== undefined) this.pin = +pin; }
    reset() { return busSensors(this.pin).length ? 1 : 0; }
    reset_search() { this.next = 0; }
    search(addr) {
      const s = busSensors(this.pin)[this.next]; if (!s) return false;
      this.next++; romOf(s).forEach((b, i) => { addr[i] = b; }); return true;
    }
    select() {} skip() {} write() {} write_bytes() {} depower() {}
    read() { return 0xff; } read_bytes(buf, n) { for (let i = 0; i < n; i++) buf[i] = 0xff; }
    static crc8(a, len) { return crc8(a, len); }
  }
  OneWire.prototype.crc8 = (a, len) => crc8(a, len);

  class DallasTemperature {
    constructor(wire) { this.wire = wire || null; this.res = 12; this.wait = true; this.latched = new Map(); }
    setOneWire(w) { this.wire = w; }
    _pin() { return this.wire ? this.wire.pin : NaN; }
    _list() { return Number.isFinite(this._pin()) ? busSensors(this._pin()) : []; }
    begin() { if (!this.wire) sim.warnOnce('dt-wire', 'DallasTemperature: pass the OneWire bus, e.g. DallasTemperature sensors(&oneWire);'); }
    getDeviceCount() { return this._list().length; }
    getDS18Count() { return this._list().length; }
    isParasitePowerMode() { return this._list().some((c) => sim.pinLevel(c, 'VDD') === 0); }
    setResolution(a, b) { const bits = b === undefined ? a : b; this.res = Math.max(9, Math.min(12, +bits | 0)); return true; }
    getResolution() { return this.res; }
    setWaitForConversion(w) { this.wait = !!w; } getWaitForConversion() { return this.wait; }
    setCheckForConversion() {} isConversionComplete() { return true; }
    millisToWaitForConversion(bits = this.res) { return [94, 188, 375, 750][Math.max(9, Math.min(12, bits)) - 9]; }
    async requestTemperatures() {
      const step = 0.5 / (1 << (this.res - 9)); // 9 bit: 0.5 °C … 12 bit: 0.0625 °C
      for (const c of this._list()) this.latched.set(c.id, Math.max(-55, Math.min(125, Math.round(+c.props.temp / step) * step)));
      if (this.wait) { check(); await sleep(this.millisToWaitForConversion()); check(); }
      return true;
    }
    async requestTemperaturesByIndex() { return this.requestTemperatures(); }
    async requestTemperaturesByAddress() { return this.requestTemperatures(); }
    _temp(c) { return c ? (this.latched.has(c.id) ? this.latched.get(c.id) : 85) : DISCONNECTED_C; } // 85 °C is the power-on value
    getTempCByIndex(i) { return this._temp(this._list()[Math.trunc(i)]); }
    getTempFByIndex(i) { const t = this.getTempCByIndex(i); return t === DISCONNECTED_C ? -196.6 : t * 1.8 + 32; }
    _byAddr(addr) { return this._list().find((c) => romOf(c).every((b, i) => b === (addr[i] & 0xff))); }
    getTempC(addr) { return this._temp(this._byAddr(addr)); }
    getTempF(addr) { const t = this.getTempC(addr); return t === DISCONNECTED_C ? -196.6 : t * 1.8 + 32; }
    getAddress(addr, i) { const c = this._list()[Math.trunc(i)]; if (!c) return false; romOf(c).forEach((b, k) => { addr[k] = b; }); return true; }
    isConnected(addr) { return !!this._byAddr(addr); }
    validAddress(addr) { return crc8(addr, 7) === (addr[7] & 0xff); }
    validFamily(addr) { return [0x10, 0x22, 0x28, 0x3b, 0x42].includes(addr[0] & 0xff); }
    static toFahrenheit(c) { return c * 1.8 + 32; }
    static toCelsius(f) { return (f - 32) / 1.8; }
  }
  DallasTemperature.prototype.toFahrenheit = DallasTemperature.toFahrenheit;
  DallasTemperature.prototype.toCelsius = DallasTemperature.toCelsius;

  // ---------- HC-SR04: NewPing, and pulseIn() on its ECHO pin ----------
  const US_PER_CM = 58.3; // round trip at 343 m/s
  const sonarOn = (trig, echo) => partsOn(sim, echo, 'hcsr04', 'ECHO').find((c) => sim.pinGpios(c, 'TRIG').includes(trig)) || null;
  const echoUs = (c, maxCm) => {
    if (!c || !sim.powered(c)) return 0;
    const d = +c.props.distance;
    return d < 2 || d > Math.min(400, maxCm) ? 0 : Math.round(d * US_PER_CM);
  };
  class NewPing {
    constructor(trig, echo, max = 500) { this.trig = +trig; this.echo = echo === undefined ? +trig : +echo; this.max = Math.min(500, +max || 500); gpioCheck(this.trig, 'NewPing'); }
    _sensor() {
      const c = sonarOn(this.trig, this.echo);
      if (!c) sim.warnOnce('np' + this.trig, `NewPing: no HC-SR04 has TRIG on pin ${this.trig} and ECHO on pin ${this.echo}.`);
      else if (!sim.powered(c)) sim.warnOnce('npp' + c.id, `NewPing: ${c.id} has no power — the HC-SR04 needs 5 V on VCC and GND.`);
      return c;
    }
    ping(max) { return echoUs(this._sensor(), max === undefined ? this.max : +max); }
    ping_cm(max) { const us = this.ping(max); return us ? Math.max(1, Math.round(us / 57)) : 0; }
    ping_in(max) { const us = this.ping(max); return us ? Math.max(1, Math.round(us / 146)) : 0; }
    ping_median(it = 5, max) { const v = []; for (let i = 0; i < Math.max(1, it); i++) { const p = this.ping(max); if (p) v.push(p); } v.sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; }
    convert_cm(us) { return us ? Math.max(1, Math.round(us / 57)) : 0; }
    convert_in(us) { return us ? Math.max(1, Math.round(us / 146)) : 0; }
    static convert_cm(us) { return us ? Math.max(1, Math.round(us / 57)) : 0; }
    static convert_in(us) { return us ? Math.max(1, Math.round(us / 146)) : 0; }
  }
  /** pulseIn(pin, HIGH): the echo of an HC-SR04 whose TRIG was just pulsed; 0 (timeout) otherwise. */
  function pulseIn(pin, state = 1, timeout = 1000000) {
    pin = +pin; sim.evalWatch(); // the trigger pulse may have ended a moment ago
    const c = partsOn(sim, pin, 'hcsr04', 'ECHO')[0];
    if (c && +state === 1) {
      if (!sim.sonarArmed || !sim.sonarArmed.has(c.id)) { sim.warnOnce('pi' + c.id, `pulseIn: pulse ${c.id}'s TRIG pin HIGH for 10 µs first (digitalWrite HIGH, delayMicroseconds(10), LOW).`); return 0; }
      sim.sonarArmed.delete(c.id);
      if (!sim.powered(c)) { sim.warnOnce('npp' + c.id, `HC-SR04 ${c.id} has no power — it needs 5 V on VCC and GND.`); return 0; }
      const d = +c.props.distance; const us = d >= 2 && d <= 400 ? Math.round(d * US_PER_CM) : 38000; // out of range: ~38 ms pulse
      return us <= timeout ? us : 0;
    }
    return 0;
  }

  // ---------- RTClib ----------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  class TimeSpan {
    constructor(a = 0, h, m, s) { this.t = h === undefined ? (a instanceof TimeSpan ? a.t : Math.trunc(+a || 0)) : Math.trunc(a * 86400 + h * 3600 + m * 60 + s); }
    days() { return Math.trunc(this.t / 86400); } hours() { return Math.trunc(this.t / 3600) % 24; }
    minutes() { return Math.trunc(this.t / 60) % 60; } seconds() { return this.t % 60; } totalseconds() { return this.t; }
    valueOf() { return this.t; }
  }
  class DateTime {
    constructor(a, b, c, h = 0, mi = 0, s = 0) {
      let t;
      if (a instanceof DateTime) t = a.t;
      else if (typeof a === 'string' && typeof b === 'string') { // __DATE__, __TIME__ ("Nov  9 2026", "15:41:42")
        const [mon, d, y] = a.trim().split(/\s+/); const [hh, mm, ss] = b.split(':').map(Number);
        t = Date.UTC(+y, Math.max(0, MONTHS.indexOf(mon)), +d, hh, mm, ss) / 1000;
      } else if (typeof a === 'string') { // ISO 8601 "2020-06-25T15:29:37"
        const m = a.match(/(\d+)-(\d+)-(\d+)[T ](\d+):(\d+):(\d+)/); t = m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : 0;
      } else if (b !== undefined) { let y = +a; if (y < 100) y += 2000; t = Date.UTC(y, b - 1, +c, +h, +mi, +s) / 1000; }
      else t = a === undefined ? 946684800 : Math.trunc(+a || 0);
      this.t = t;
    }
    _d() { return new Date(this.t * 1000); }
    year() { return this._d().getUTCFullYear(); } month() { return this._d().getUTCMonth() + 1; } day() { return this._d().getUTCDate(); }
    hour() { return this._d().getUTCHours(); } minute() { return this._d().getUTCMinutes(); } second() { return this._d().getUTCSeconds(); }
    twelveHour() { const h = this.hour() % 12; return h || 12; } isPM() { return this.hour() >= 12; }
    dayOfTheWeek() { return this._d().getUTCDay(); }
    unixtime() { return this.t; } secondstime() { return this.t - 946684800; }
    isValid() { return this.year() >= 2000 && this.year() <= 2099; }
    timestamp(opt = 0) {
      const d = `${this.year()}-${p2(this.month())}-${p2(this.day())}`, tm = `${p2(this.hour())}:${p2(this.minute())}:${p2(this.second())}`;
      return opt === 1 ? tm : opt === 2 ? d : `${d}T${tm}`;
    }
    toString(fmt) {
      return String(fmt ?? 'YYYY-MM-DD hh:mm:ss').replace(/YYYY|YY|MMM|MM|DDD|DD|hh|mm|ss|AP|ap/g, (k) => ({
        YYYY: this.year(), YY: p2(this.year() % 100), MMM: MONTHS[this.month() - 1], MM: p2(this.month()), DDD: DAYS[this.dayOfTheWeek()], DD: p2(this.day()),
        hh: p2(/AP|ap/.test(fmt) ? this.twelveHour() : this.hour()), mm: p2(this.minute()), ss: p2(this.second()), AP: this.isPM() ? 'PM' : 'AM', ap: this.isPM() ? 'pm' : 'am',
      })[k]);
    }
    valueOf() { return this.t; }
  }
  Object.assign(DateTime, { TIMESTAMP_FULL: 0, TIMESTAMP_TIME: 1, TIMESTAMP_DATE: 2 });
  // the RTC keeps time across resets (it has a battery): the offset from the computer clock is saved with the board's memory
  const computerNow = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) / 1000; };
  const startT = computerNow() - Math.floor(sim.millis() / 1000);
  class RTC_DS3231 {
    begin() {
      const c = i2cCheck(sim, 'ds3231', 'RTC')[0];
      if (!c) { sim.warnOnce('rtc', `RTC: no DS3231 is wired to the I2C pins (SDA GPIO${sim.i2c.sda}, SCL GPIO${sim.i2c.scl}).`); return false; }
      if (!sim.powered(c)) { sim.warnOnce('rtcp' + c.id, `RTC: ${c.id} has no power — wire VCC and GND.`); return false; }
      return true;
    }
    now() { return new DateTime(startT + (sim.nv.rtc || 0) + Math.floor(sim.millis() / 1000)); }
    adjust(dt) { sim.nv.rtc = new DateTime(dt).t - (startT + Math.floor(sim.millis() / 1000)); sim.nvChanged(); }
    lostPower() { return false; } isrunning() { return true; }
    getTemperature() { const c = i2cParts(sim, 'ds3231')[0]; return c ? Math.round(+c.props.temp * 4) / 4 : 0; }
    enable32K() {} disable32K() {} isEnabled32K() { return false; } writeSqwPinMode() {} readSqwPinMode() { return 0; }
    setAlarm1() { return true; } setAlarm2() { return true; } alarmFired() { return false; } clearAlarm() {} disableAlarm() {}
  }

  return {
    OneWire: callable(OneWire), DallasTemperature: callable(DallasTemperature), DEVICE_DISCONNECTED_C: DISCONNECTED_C, DEVICE_DISCONNECTED_F: -196.6,
    NewPing: callable(NewPing), NO_ECHO: 0, MAX_SENSOR_DISTANCE: 500, US_ROUNDTRIP_CM: 57, US_ROUNDTRIP_IN: 146, pulseIn, pulseInLong: pulseIn,
    RTC_DS3231: callable(RTC_DS3231), RTC_DS1307: callable(RTC_DS3231), DateTime: callable(DateTime), TimeSpan: callable(TimeSpan),
    TIMESTAMP_FULL: 0, TIMESTAMP_TIME: 1, TIMESTAMP_DATE: 2,
    DS3231_OFF: 0, DS3231_SquareWave1Hz: 1, DS1307_SquareWave1HZ: 1,
  };
}
