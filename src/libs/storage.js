/* Saved settings: EEPROM (Uno and ESP32) and Preferences (ESP32). The data survives Stop/Start and
 * restarts, like the real flash/EEPROM (it is kept by the page for this browser session). */

export function storageLibs({ sim, uno }) {
  const nv = sim.nv;
  const SIZE = uno ? 1024 : 4096;
  if (!nv.eeprom || nv.eeprom.length !== SIZE) nv.eeprom = new Uint8Array(SIZE).fill(0xff);
  nv.eput = nv.eput || {}; nv.prefs = nv.prefs || {};

  // ESP32: EEPROM is emulated in flash — begin(size) loads it, writes change RAM until commit()
  let ram = uno ? nv.eeprom : null, size = uno ? SIZE : 0, puts = uno ? nv.eput : {};
  const need = (what) => {
    if (ram) return true;
    sim.warnOnce('ee-begin', `EEPROM.${what}: call EEPROM.begin(size) first on the ESP32 (e.g. EEPROM.begin(512)).`, 'error');
    return false;
  };
  const inRange = (a) => { a = Math.trunc(a); if (a >= 0 && a < size) return true; sim.warnOnce('ee-r' + a, `EEPROM: address ${a} is outside 0–${size - 1}.`); return false; };
  const saved = () => { if (uno) sim.nvChanged(); };
  const enc = (v) => { // bytes a put() writes: int32 for whole numbers, float32 otherwise, chars for text
    if (typeof v === 'string') return [...v].map((c) => c.charCodeAt(0) & 0xff).concat(0);
    if (typeof v === 'boolean') return [v ? 1 : 0];
    const b = new DataView(new ArrayBuffer(4));
    if (Number.isInteger(+v)) b.setInt32(0, +v, true); else b.setFloat32(0, +v, true);
    return [0, 1, 2, 3].map((i) => b.getUint8(i));
  };
  const base = {
    begin(n) {
      if (uno) return true;
      size = Math.max(1, Math.min(SIZE, Math.trunc(+n) || 0)); ram = nv.eeprom.slice(0, size); puts = structuredClone(nv.eput); return true;
    },
    read(a) { if (!need('read') || !inRange(a)) return 0; return ram[Math.trunc(a)]; },
    write(a, v) { if (!need('write') || !inRange(a)) return; ram[Math.trunc(a)] = v & 0xff; delete puts[Math.trunc(a)]; saved(); },
    update(a, v) { if (!need('update') || !inRange(a)) return; if (ram[Math.trunc(a)] !== (v & 0xff)) base.write(a, v); },
    put(a, v) {
      if (!need('put') || !inRange(a)) return v;
      a = Math.trunc(a); const bytes = enc(v);
      bytes.forEach((b, i) => { if (a + i < size) ram[a + i] = b; });
      puts[a] = typeof v === 'object' && v !== null ? structuredClone(v) : v; saved();
      return v;
    },
    /** EEPROM.get(addr, v): the transpiler assigns the result back to v */
    get(a, v) {
      if (!need('get') || !inRange(a)) return v;
      a = Math.trunc(a);
      if (Object.prototype.hasOwnProperty.call(puts, a) && typeof puts[a] === typeof v) return typeof v === 'object' ? structuredClone(puts[a]) : puts[a];
      if (typeof v === 'string') { let s = ''; for (let i = a; i < size && ram[i]; i++) s += String.fromCharCode(ram[i]); return s; }
      if (typeof v === 'boolean') return !!ram[a];
      const b = new DataView(new ArrayBuffer(4)); for (let i = 0; i < 4; i++) b.setUint8(i, a + i < size ? ram[a + i] : 0xff);
      return Number.isInteger(v) ? (uno ? b.getInt16(0, true) : b.getInt32(0, true)) : b.getFloat32(0, true);
    },
    commit() {
      if (uno) return true;
      if (!need('commit')) return false;
      nv.eeprom.set(ram.subarray(0, size)); nv.eput = structuredClone(puts); sim.nvChanged(); return true;
    },
    end() { if (!uno && ram) base.commit(); },
    length() { return size || SIZE; },
  };
  const EEPROM = new Proxy(base, {
    get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k)) return base.read(+k); if (k === 'length') return base.length(); return t[k]; }, // EEPROM.length() is .length after the transpiler
    set(t, k, v) { if (typeof k === 'string' && /^\d+$/.test(k)) { base.write(+k, v); return true; } t[k] = v; return true; },
  });

  // ---------- Preferences (ESP32 NVS) ----------
  class Preferences {
    constructor() { this.ns = null; this.ro = false; }
    begin(ns, readOnly = false) {
      ns = String(ns ?? ''); if (ns.length > 15) sim.warnOnce('pref-ns', `Preferences: namespace "${ns}" is longer than 15 characters.`, 'error');
      this.ns = ns; this.ro = !!readOnly; if (!this.ro && !nv.prefs[ns]) nv.prefs[ns] = {}; return true;
    }
    end() { this.ns = null; }
    _tab() { if (this.ns == null) { sim.warnOnce('pref-begin', 'Preferences: call begin("namespace") first.', 'error'); return null; } return nv.prefs[this.ns] || {}; }
    _put(key, v, n) {
      key = String(key); if (key.length > 15) sim.warnOnce('pref-k' + key, `Preferences: key "${key}" is longer than 15 characters.`, 'error');
      if (this.ro) { sim.warnOnce('pref-ro', 'Preferences: this namespace was opened read-only.'); return 0; }
      if (!this._tab()) return 0;
      nv.prefs[this.ns][key] = v; sim.nvChanged(); return n;
    }
    _get(key, def) { const t = this._tab(); if (!t) return def; const v = t[String(key)]; return v === undefined ? def : v; }
    clear() { if (this._tab() && !this.ro) { nv.prefs[this.ns] = {}; sim.nvChanged(); return true; } return false; }
    remove(key) { const t = this._tab(); if (!t || this.ro || !(key in t)) return false; delete t[key]; sim.nvChanged(); return true; }
    isKey(key) { const t = this._tab(); return !!t && String(key) in t; }
    freeEntries() { return 500; }
    putString(k, v) { const s = String(v ?? ''); return this._put(k, s, s.length); } getString(k, d = '') { return String(this._get(k, d)); }
    putBool(k, v) { return this._put(k, !!v, 1); } getBool(k, d = false) { return !!this._get(k, d); }
    putFloat(k, v) { return this._put(k, Math.fround(+v), 4); } getFloat(k, d = NaN) { return +this._get(k, d); }
    putDouble(k, v) { return this._put(k, +v, 8); } getDouble(k, d = NaN) { return +this._get(k, d); }
    putBytes(k, buf, n) { return this._put(k, Array.from(buf).slice(0, n), n); }
    getBytes(k, buf, n) { const v = this._get(k, []); for (let i = 0; i < Math.min(n, v.length); i++) buf[i] = v[i]; return Math.min(n, v.length); }
    getBytesLength(k) { return (this._get(k, []) || []).length; }
  }
  const ints = { Char: [1, true], UChar: [1, false], Short: [2, true], UShort: [2, false], Int: [4, true], UInt: [4, false], Long: [4, true], ULong: [4, false], Long64: [8, true], ULong64: [8, false] };
  for (const [name, [n, signed]] of Object.entries(ints)) {
    const bits = n * 8;
    const wrap = (v) => { v = Math.trunc(+v || 0); if (bits >= 53) return v; const m = 2 ** bits; v = ((v % m) + m) % m; return signed && v >= m / 2 ? v - m : v; };
    Preferences.prototype['put' + name] = function (k, v) { return this._put(k, wrap(v), n); };
    Preferences.prototype['get' + name] = function (k, d = 0) { return wrap(this._get(k, d)); };
  }

  return { EEPROM, Preferences };
}
