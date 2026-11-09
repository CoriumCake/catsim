/* ArduinoJson (v6 and v7 style). A document holds plain JS data; reading gives numbers and strings,
 * or a view of a nested object/array. Reading a missing key gives an empty value that still accepts
 * writes, so doc["a"]["b"] = 1 creates the nested object as ArduinoJson 7 does. */
import { callable } from './util.js';

const RAW = Symbol('raw');
/** A JSON value read into a C variable: missing → 0 / false / "", like ArduinoJson. */
export function jsonScalar(v) {
  if (typeof v !== 'function' || !v[RAW]) return v;
  const r = v[RAW]();
  return r == null ? 0 : typeof r === 'object' ? v : r;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plain = (v) => {
  if (v && (typeof v === 'object' || typeof v === 'function') && v[RAW] !== undefined) return structuredClone(v[RAW]());
  if (v && typeof v === 'object' && typeof v.valueOf === 'function' && typeof v.valueOf() !== 'object') return v.valueOf();
  if (Array.isArray(v)) return v.map(plain);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v === undefined ? null : v;
};

/** A slot that holds a value: get() / set(v) on its container. */
function view(get, set) {
  const cur = () => get();
  const ensure = (kind) => { let c = cur(); if (kind === 'array' ? !Array.isArray(c) : !isObj(c)) { c = kind === 'array' ? [] : {}; set(c); } return c; };
  const child = (k) => {
    const c = cur(); const v = c == null ? undefined : Array.isArray(c) ? c[+k] : c[k];
    if (v !== undefined && (v === null || typeof v !== 'object')) return v; // numbers, strings, bools, null
    return view(() => { const cc = cur(); return cc == null ? undefined : Array.isArray(cc) ? cc[+k] : cc[k]; },
      (nv) => { const cc = ensure(/^\d+$/.test(k) ? 'array' : 'object'); if (Array.isArray(cc)) cc[+k] = nv; else cc[k] = nv; });
  };
  const methods = {
    size: () => { const c = cur(); return Array.isArray(c) ? c.length : isObj(c) ? Object.keys(c).length : 0; },
    isNull: () => cur() == null,
    containsKey: (k) => isObj(cur()) && Object.prototype.hasOwnProperty.call(cur(), k),
    add: (v) => { const c = ensure('array'); if (v === undefined) { c.push(null); return child(String(c.length - 1)); } c.push(plain(v)); return true; },
    __t_add: (t) => { const c = ensure('array'); c.push(t === 'JsonArray' ? [] : t === 'JsonObject' ? {} : null); return child(String(c.length - 1)); },
    __t_to: (t) => { set(t === 'JsonArray' ? [] : t === 'JsonObject' ? {} : null); return view(get, set); },
    createNestedObject: (k) => { if (k === undefined) { const c = ensure('array'); c.push({}); return child(String(c.length - 1)); } ensure('object')[k] = {}; return child(String(k)); },
    createNestedArray: (k) => { if (k === undefined) { const c = ensure('array'); c.push([]); return child(String(c.length - 1)); } ensure('object')[k] = []; return child(String(k)); },
    remove: (k) => { const c = cur(); if (Array.isArray(c)) c.splice(+k, 1); else if (isObj(c)) delete c[k]; },
    clear: () => set(null),
    set: (v) => { set(plain(v)); return true; },
    nesting: () => 0, memoryUsage: () => JSON.stringify(cur() ?? null).length, overflowed: () => false, garbageCollect: () => true, shrinkToFit: () => {},
    toString: () => JSON.stringify(cur() ?? null),
  };
  const proxy = new Proxy(function () {}, {
    get(_, k) {
      if (k === RAW) return () => cur() ?? null;
      if (k === Symbol.toPrimitive) return (hint) => { const c = cur(); return c == null ? (hint === 'number' ? 0 : 'null') : JSON.stringify(c); };
      if (k === Symbol.iterator) {
        return function* () {
          const c = cur();
          if (Array.isArray(c)) for (let i = 0; i < c.length; i++) yield child(String(i));
          else if (isObj(c)) for (const key of Object.keys(c)) yield { key: () => key, value: () => child(key) };
        };
      }
      if (typeof k === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(methods, k)) return methods[k];
      return child(k);
    },
    set(_, k, v) { const c = ensure(/^\d+$/.test(k) ? 'array' : 'object'); if (Array.isArray(c)) c[+k] = plain(v); else c[k] = plain(v); return true; },
    has(_, k) { const c = cur(); return c != null && typeof c === 'object' && k in c; },
  });
  return proxy;
}

class JsonDocument {
  constructor() { const box = { v: null }; this.box = box; return view(() => box.v, (v) => { box.v = v; }); }
}

const rawOf = (v) => (v && (typeof v === 'object' || typeof v === 'function') && v[RAW] ? v[RAW]() : v);

/** x.as<T>() */
function asType(v, t) {
  const r = rawOf(v);
  if (/^(?:JsonObject|JsonArray|JsonVariant|JsonDocument)$/.test(t)) return v;
  if (/^(?:String|const char ?\*|char ?\*|const char\*)$/.test(t)) return r == null ? '' : typeof r === 'string' ? r : typeof r === 'object' ? JSON.stringify(r) : String(r);
  if (/^(?:bool|boolean)$/.test(t)) return r === true || (typeof r === 'number' && r !== 0);
  if (/^(?:float|double)$/.test(t)) return typeof r === 'number' ? r : typeof r === 'string' ? parseFloat(r) || 0 : r === true ? 1 : 0;
  // integers
  const n = typeof r === 'number' ? r : typeof r === 'string' ? parseFloat(r) || 0 : r === true ? 1 : 0;
  return Math.trunc(n);
}
function isType(v, t) {
  const r = rawOf(v);
  if (t === 'JsonObject') return isObj(r);
  if (t === 'JsonArray') return Array.isArray(r);
  if (/^(?:String|const char ?\*|char ?\*)$/.test(t)) return typeof r === 'string';
  if (/^(?:bool|boolean)$/.test(t)) return typeof r === 'boolean';
  if (/^(?:float|double)$/.test(t)) return typeof r === 'number';
  if (t === 'JsonVariant') return r != null;
  return typeof r === 'number' && Number.isInteger(r);
}

class DeserializationError {
  constructor(code) { this.code_ = code; }
  c_str() { return this.code_; } f_str() { return this.code_; } code() { return this.code_; }
  toString() { return this.code_; }
}

export function jsonLibs() {
  const serialize = (pretty) => (doc, out) => {
    const s = JSON.stringify(rawOf(doc) ?? null, null, pretty ? 2 : undefined);
    if (out && typeof out.print === 'function') { out.print(s); return out; }
    return s;
  };
  return {
    JsonDocument: callable(JsonDocument), StaticJsonDocument: callable(JsonDocument), DynamicJsonDocument: callable(JsonDocument),
    JsonObject: null, JsonArray: null, JsonVariant: null,
    DeserializationError: Object.assign(callable(DeserializationError), { Ok: null, EmptyInput: 'EmptyInput', IncompleteInput: 'IncompleteInput', InvalidInput: 'InvalidInput', NoMemory: 'NoMemory', TooDeep: 'TooDeep' }),
    serializeJson: serialize(false), serializeJsonPretty: serialize(true),
    measureJson: (doc) => JSON.stringify(rawOf(doc) ?? null).length, measureJsonPretty: (doc) => JSON.stringify(rawOf(doc) ?? null, null, 2).length,
    deserializeJson(doc, input) {
      let text = input;
      if (input && typeof input === 'object' && typeof input.readString === 'function') text = input.readString();
      else if (Array.isArray(input)) text = input.join('');
      text = String(text ?? '');
      if (!text.trim()) return new DeserializationError('EmptyInput');
      let v; try { v = JSON.parse(text); } catch (e) { return new DeserializationError(/end of/i.test(e.message) ? 'IncompleteInput' : 'InvalidInput'); }
      doc.set(v);
      return null; // success: `if (error)` is false
    },
    __as: asType, __is: isType,
    /** doc["key"] | default */
    __or: (v, d) => { const r = rawOf(v); return r == null || (typeof d === 'string' ? typeof r !== 'string' : typeof r !== typeof d) ? d : r; },
  };
}
