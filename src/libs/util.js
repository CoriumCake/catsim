/* Shared helpers for the library modules. */

/** A class that also works when called without `new` (CRGB(255, 0, 0), Keypad(…), Bounce()). Statics pass through. */
export function callable(C) {
  return new Proxy(C, { apply: (target, _this, args) => new target(...args) });
}

/** Components of `type` whose pin `pinId` is on the same net as GPIO `g` of this runtime's board. */
export function partsOn(sim, g, type, pinId) {
  if (g == null || !Number.isFinite(+g)) return [];
  return sim.app.project.components.filter((c) => c.type === type && sim.pinGpios(c, pinId).includes(+g));
}

/** Components of `type` wired to this board's I2C bus (SDA and SCL). */
export function i2cParts(sim, type) {
  return sim.app.project.components.filter((c) => c.type === type
    && sim.pinGpios(c, 'SDA').includes(sim.i2c.sda) && sim.pinGpios(c, 'SCL').includes(sim.i2c.scl));
}

/** An I2C part that isn't found on the bus: say why (no power, SDA/SCL swapped, or wired to other pins). */
export function i2cCheck(sim, type, what) {
  const all = sim.app.project.components.filter((c) => c.type === type);
  const ok = i2cParts(sim, type);
  for (const c of all) {
    if (!ok.includes(c)) {
      const sda = sim.pinGpios(c, 'SDA'), scl = sim.pinGpios(c, 'SCL');
      let why;
      if (sda.includes(sim.i2c.scl) && scl.includes(sim.i2c.sda)) why = 'its SDA and SCL wires are swapped';
      else if (!sda.length && !scl.length) why = `SDA and SCL aren't wired to the board (use pins ${sim.i2c.sda} and ${sim.i2c.scl})`;
      else why = `I2C uses SDA = pin ${sim.i2c.sda} and SCL = pin ${sim.i2c.scl}, but it is wired to ${sda.length ? `pin ${sda[0]}` : 'nothing'} / ${scl.length ? `pin ${scl[0]}` : 'nothing'} (or call Wire.begin(sda, scl))`;
      sim.warnOnce(`i2c:${c.id}`, `${what} ${c.id} won't respond: ${why}.`);
    } else if (!sim.powered(c) && !sim.powered(c, 'VIN', 'GND')) sim.warnOnce(`i2cp:${c.id}`, `${what} ${c.id} has no power: wire VCC and GND.`);
  }
  return ok;
}

/** Arduino's Print class on top of a function that writes text: print, println, printf, write. */
export function printMixin(proto, fmtValue, sprintf) {
  Object.assign(proto, {
    print(v, f) { const s = fmtValue(v, f); this._out(s); return s.length; },
    println(v, f) { const s = (v === undefined ? '' : fmtValue(v, f)) + '\n'; this._out(s); return s.length; },
    printf(fmt, ...a) { const s = sprintf(fmt, ...a); this._out(s); return s.length; },
    write(b) { const s = typeof b === 'number' ? String.fromCharCode(b & 0xff) : String(b ?? ''); this._out(s); return s.length; },
  });
  return proto;
}

/** Small stable hash of a string (OneWire serial numbers). */
export function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Dallas/Maxim CRC-8 (OneWire ROM codes). */
export function crc8(bytes, len = bytes.length) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    let b = bytes[i] & 0xff;
    for (let j = 0; j < 8; j++) { const mix = (crc ^ b) & 1; crc >>= 1; if (mix) crc ^= 0x8c; b >>= 1; }
  }
  return crc;
}
