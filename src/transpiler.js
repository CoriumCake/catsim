/* CatSim — Arduino/ESP32 C++ subset → async JavaScript.
 * Not a real compiler: it rewrites the common Arduino sketch idioms (typed declarations,
 * functions, arrays, casts, delay()) so the sketch can run cooperatively in the browser.
 * Line numbers are preserved so runtime errors point at the right line. */

const BASE_TYPES = [
  'unsigned long long', 'unsigned long', 'unsigned int', 'unsigned short', 'unsigned char', 'signed char',
  'long long', 'long double', 'long', 'int', 'short', 'float', 'double', 'bool', 'boolean', 'byte', 'char',
  'String', 'word', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t',
  'int64_t', 'unsigned', 'IPAddress', 'auto',
];
const INT_TYPES = [
  'unsigned long long', 'unsigned long', 'unsigned int', 'unsigned short', 'unsigned char', 'long long', 'long',
  'int', 'short', 'byte', 'word', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t', 'int16_t',
  'int32_t', 'int64_t', 'unsigned',
];
import { LIB_CLASSES, LIB_VALUE_TYPES, LIB_NULL_DECL, LIB_BLOCKING } from './libs/names.js';
const LIB_RE = LIB_CLASSES.map((c) => c.replace('.', '\\s*\\.\\s*')).join('|');
const LIB_TYPES = LIB_CLASSES.filter((c) => !c.includes('.'));
// library methods that return float (so print() shows 2 decimals, as on the board)
const FLOAT_METHODS = new Set(['readTemperature', 'readHumidity', 'computeHeatIndex', 'convertCtoF', 'convertFtoC', 'getTempC', 'getTempF', 'getTempCByIndex', 'getTempFByIndex', 'getTemperature', 'toFahrenheit', 'toCelsius', 'readPressure', 'readAltitude', 'getTempC', 'getAccX', 'getAccY', 'getAccZ', 'getGyroX', 'getGyroY', 'getGyroZ', 'getAngleX', 'getAngleY', 'getAngleZ', 'getTemp']);
const typeRe = (list) => list.map((t) => t.replace(/ /g, '\\s+')).join('|');
const QUAL = '(?:(?:static|const|volatile|constexpr|unsigned|signed|inline)\\s+)*';

// C integer type → the runtime helper that wraps a value to that type's width (ESP32: int and long are
// 32 bit; Arduino Uno: int is 16 bit, long is 32 bit).
let int16 = false;
function wrapFor(type) {
  if (/\bsigned\s+char\b/.test(type) && !/\bunsigned\b/.test(type)) return '__i8';
  const t = type.replace(/\b(?:static|const|volatile|constexpr|inline|signed)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:bool|boolean)$/.test(t)) return '__b';
  if (/^(?:unsigned )?long long$|^u?int64_t$/.test(t)) return '__i';
  if (/^(?:unsigned char|byte|uint8_t)$/.test(t)) return '__u8';
  if (t === 'char') return '__ch'; // chars stay 1-letter strings; arithmetic converts them to codes
  if (t === 'int8_t') return '__i8';
  if (/^(?:unsigned short|uint16_t|word)$/.test(t)) return '__u16';
  if (/^(?:short|int16_t)$/.test(t)) return '__i16';
  if (int16 && /^(?:unsigned(?: int)?|size_t)$/.test(t)) return '__u16';
  if (int16 && /^(?:int|short int|)$/.test(t)) return '__i16';
  if (/^(?:unsigned(?: int| long)?|uint32_t|size_t)$/.test(t)) return '__u32';
  return '__i32'; // int, long, int32_t, enums
}

const FLOAT_CAST = '\u0001';
const CHAR_CAST = '\u0003';
// keep a rewrite's line count so runtime errors still point at the right line
const keepNl = (mm, out) => out + '\n'.repeat(Math.max(0, (mm.match(/\n/g) || []).length - (out.match(/\n/g) || []).length));

class TranspileError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

// Replace comments with whitespace (keeping newlines) and string/char literals with placeholders.
function mask(src) {
  const strs = []; let out = ''; let i = 0;
  while (i < src.length) {
    const ch = src[i]; const nx = src[i + 1];
    if (ch === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') {
      const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ''); i = stop; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      if (src[j] !== ch) throw new TranspileError('Unterminated string literal', src.slice(0, i).split('\n').length);
      strs.push(src.slice(i, j + 1)); out += `__STR${strs.length - 1}__`; i = j + 1; continue;
    }
    out += ch; i++;
  }
  return { code: out, strs };
}

function matchClose(code, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function hasTopLevelComma(s) {
  let d = 0;
  for (const ch of s) {
    if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; else if (ch === ',' && d === 0) return true;
  }
  return false;
}

function convParams(p) {
  p = p.trim();
  if (!p || p === 'void') return '';
  return p.split(',').map((s) => {
    const m = s.trim().match(/([A-Za-z_]\w*)\s*(?:\[\s*\w*\s*\])*\s*(=\s*.+)?$/);
    return m ? m[1] + (m[2] ? ' ' + m[2] : '') : s;
  }).join(', ');
}

/** Library syntax that is not plain C: templates, ::, &arg, FastLED's EVERY_N_… blocks, __DATE__/__TIME__. */
function libSyntax(code, strs) {
  const lit = (s) => { strs.push(JSON.stringify(s)); return `__STR${strs.length - 1}__`; };
  const now = new Date(); const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  code = code.replace(/\b__DATE__\b/g, () => lit(`${MON[now.getMonth()]} ${String(now.getDate()).padStart(2, ' ')} ${now.getFullYear()}`));
  code = code.replace(/\b__TIME__\b/g, () => lit(`${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`));
  // OneWire addresses are 8-byte arrays
  code = code.replace(/\bDeviceAddress\s+([A-Za-z_]\w*)\s*(?=[;=])/g, 'uint8_t $1[8]');
  // templates: StaticJsonDocument<200> doc; x.as<int>(); doc.to<JsonObject>(); FastLED.addLeds<WS2812B, 5, GRB>(leds, 8);
  code = code.replace(/\b(StaticJsonDocument|DynamicJsonDocument|JsonDocument)\s*<[^<>;]*>/g, '$1');
  code = code.replace(/((?:[A-Za-z_]\w*)(?:\s*\[[^\[\]]*\]|\s*\.\s*\w+(?:\s*\([^()]*\))?)*?)\s*\.\s*(as|is)\s*<\s*([\w\s*]+?)\s*>\s*\(\s*\)/g,
    (m, recv, fn, t) => `__${fn}(${recv}, ${lit(t.replace(/\s+/g, ' ').trim())})`);
  code = code.replace(/\.\s*(to|add|set)\s*<\s*(\w+)\s*>\s*\(\s*\)/g, (m, fn, t) => `.__t_${fn}(${lit(t)})`);
  code = code.replace(/\baddLeds\s*<([^<>;]*)>\s*\(\s*(\)?)/g, (m, targs, empty) => `addLeds([${targs}]${empty ? ')' : ', '}`);
  let every = 0;
  code = code.replace(/\bEVERY_N_(MILLISECONDS|SECONDS|MILLIS)\s*\(([^()]*)\)/g, (m, unit, n) => `if (__every(${every++}, ${unit === 'SECONDS' ? `(${n}) * 1000` : n}))`);
  code = code.replace(/\bstd\s*::\s*/g, '');
  code = code.replace(/::/g, '.');
  // &obj passed to a library (display(128, 64, &Wire), sensors(&oneWire), decode(&results)): objects are references anyway
  code = code.replace(/([(,=]\s*)&(?=\s*[A-Za-z_])/g, '$1');
  // methods that fill out-parameters (&x): obj.m(in…, &out…); → [out…] = obj.m(in…);
  //   display.getTextBounds(str, x, y, &x1, &y1, &w, &h)   mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz)
  const OUT_PARAMS = { getTextBounds: [3, 7], getMotion6: [0, 6], getAcceleration: [0, 3], getRotation: [0, 3] };
  code = code.replace(/(^|[;{}\n)])(\s*)([A-Za-z_][\w.]*)\s*\.\s*(getTextBounds|getMotion6|getAcceleration|getRotation)\s*\(([^;]*)\)\s*;/g, (m, a, ws, obj, fn, args) => {
    const parts = []; let d = 0, cur = '';
    for (const ch of args) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; }
    parts.push(cur.trim());
    const [nin, n] = OUT_PARAMS[fn];
    return parts.length === n && parts[0] ? `${a}${ws}[${parts.slice(nin).join(', ')}] = ${obj}.${fn}(${parts.slice(0, nin).join(', ')});` : m;
  });
  // values read from a JSON document into a typed variable: bool on = doc["led"]; float t = doc["temp"]; (missing → 0)
  code = code.replace(/(?<=^|[;{}\n(])()(\s*)((?:(?:const|static)\s+)*(?:unsigned\s+)?(?:bool|boolean|int|long|float|double|byte|short|size_t|word|String|u?int\d+_t|char\s*\*))\s*([A-Za-z_]\w*)\s*=\s*((?:[A-Za-z_]\w*)(?:\s*\[[^\[\]]*\])*\s*\[\s*__STR\d+__\s*\])\s*;/g,
    (m, a, ws, type, name, rhs) => `${a}${ws}${type} ${name} = __as(${rhs}, ${lit(type.replace(/\b(?:const|static)\s+/g, '').replace(/\s+/g, ' '))});`);
  // ArduinoJson defaults: doc["name"] | "unknown"  (JS | would turn both sides into numbers)
  code = code.replace(/((?:[A-Za-z_]\w*)(?:\s*\[[^\[\]]*\])*\s*\[\s*__STR\d+__\s*\])\s*\|(?![|=])\s*(__STR\d+__|-?\d+(?:\.\d+)?|true|false)/g, '__or($1, $2)');
  code = code.replace(/(?<![\w.])FastLED\s*\.\s*delay\s*\(/g, 'await FastLED.delay(');
  return code;
}

/** Declarations of library objects. */
function libDecls(code) {
  const re = new RegExp(`(?<=^|[;{}\\n])()([ \\t]*)(?:(?:static|const)\\s+)*(${LIB_RE})\\s*(?:\\*\\s*)?\\s([ \\t]*)([A-Za-z_]\\w*)[ \\t]*`, 'g');
  let out = ''; let last = 0; let m;
  while ((m = re.exec(code))) {
    const [whole, pre, ws, clsRaw, , name] = m; const cls = clsRaw.replace(/\s+/g, '');
    let j = m.index + whole.length; let text = null;
    const ch = code[j];
    if (ch === ';') { text = LIB_NULL_DECL.includes(cls) ? `let ${name} = null;` : `let ${name} = new ${cls}();`; j++; }
    else if (ch === ',') { // Ticker a, b;  OneWire bus1(4), bus2(5);
      let d = 0, k = j;
      for (; k < code.length; k++) { const c = code[k]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ';' && d === 0) break; }
      const names = [name]; const list = code.slice(j + 1, k).split(/,(?![^(]*\))/).map((x) => x.trim());
      if (!list.every((x) => /^[A-Za-z_]\w*\s*(\([^()]*\))?$/.test(x))) continue;
      names.push(...list);
      text = names.map((x) => { const mm = x.match(/^([A-Za-z_]\w*)\s*(?:\(([^()]*)\))?$/); return `let ${mm[1]} = ${LIB_NULL_DECL.includes(cls) ? 'null' : `new ${cls}(${mm[2] || ''})`};`; }).join(' ');
      j = k + 1;
    }
    else if (ch === '(') {
      const e = matchClose(code, j, '(', ')'); if (e < 0) continue;
      const args = code.slice(j + 1, e); let k = e + 1; while (/[ \t]/.test(code[k])) k++;
      if (code[k] !== ';') continue; // a function definition: DateTime getTime() { … }
      // a prototype (DateTime getTime(); DateTime at(int h, int m);) declares nothing
      const proto = !args.trim() || /^\s*(?:const\s+)?(?:unsigned\s+)?(?:int|long|float|double|char|bool|byte|String|uint\d+_t|int\d+_t|void)\b[\s*&]*[A-Za-z_]?/.test(args);
      text = proto ? '' : `let ${name} = new ${cls}(${args});`;
      j = k + 1;
    } else if (ch === '[') {
      const e = code.indexOf(']', j); if (e < 0) continue;
      const n = code.slice(j + 1, e).trim(); let k = e + 1; while (/[ \t]/.test(code[k])) k++;
      if (code[k] === ';') { text = `let ${name} = __objs(${n || 0}, () => new ${cls}()${LIB_VALUE_TYPES.includes(cls) ? `, ${cls}` : ''});`; j = k + 1; }
      else if (code[k] === '=') {
        k++; while (/\s/.test(code[k])) k++;
        if (code[k] !== '{') continue;
        const e2 = matchClose(code, k, '{', '}'); if (e2 < 0) continue;
        const items = code.slice(k + 1, e2);
        text = `let ${name} = __objs(${n || 0}, (i) => [${items}][i], ${cls});`;
        j = e2 + 1; while (/[ \t]/.test(code[j])) j++; if (code[j] === ';') j++;
      } else continue;
    } else if (ch === '=' && code[j + 1] !== '=') {
      let d = 0, k = j + 1;
      for (; k < code.length; k++) { const c = code[k]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ';' && d === 0) break; }
      const expr = code.slice(j + 1, k).trim();
      text = LIB_VALUE_TYPES.includes(cls) ? `let ${name} = __cast(${cls}, ${expr});` : `let ${name} = ${expr};`;
      j = k + 1;
    } else continue;
    out += code.slice(last, m.index) + pre + ws + keepNl(code.slice(m.index + pre.length + ws.length, j), text);
    last = j; re.lastIndex = j;
  }
  return out + code.slice(last);
}

/** `opts.board`: 'uno' gives 16-bit int (AVR); anything else follows the ESP32 (32-bit int). */
function transpile(source, opts = {}) {
  int16 = opts.board === 'uno';
  let { code, strs } = mask(source.replace(/\r\n?/g, '\n'));
  // names that are fine in C++ but reserved in JavaScript: JsonDocument in; int function = 1;
  code = code.replace(/(?<![\w.])(in|function|var|typeof|instanceof|with|arguments|eval|await|export|import|let)(?!\w)/g, '$1_');

  // --- preprocessor ---
  const includes = [...code.matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]?([^>"\n]+?)[>"]?[ \t]*$/gm)].map((mm) => mm[1].trim().replace(/^__STR(\d+)__$/, (x, n) => strs[+n].slice(1, -1)));
  code = code.replace(/^[ \t]*#[ \t]*include[^\n]*/gm, '');
  code = code.replace(/^[ \t]*#[ \t]*define[ \t]+(\w+)\(([^)]*)\)[ \t]+([^\n]+)/gm, 'const $1 = ($2) => ($3);');
  code = code.replace(/^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+([^\n]+)/gm, 'const $1 = $2;');
  code = code.replace(/^[ \t]*#[^\n]*/gm, '');
  code = code.replace(/\b(?:IRAM_ATTR|ICACHE_RAM_ATTR|PROGMEM|DRAM_ATTR)\b/g, '');
  code = libSyntax(code, strs);

  // --- enums: enum State { IDLE, RUN = 5 }; ---
  const enumNames = [];
  code = code.replace(/\benum\s+(?:class\s+)?(\w+)?\s*(?::\s*\w+\s*)?\{([^}]*)\}\s*;/g, (m, name, body) => {
    if (name) enumNames.push(name);
    let n = 0;
    const items = body.split(',').map((s) => s.trim()).filter(Boolean).map((it) => {
      const [k, v] = it.split('=').map((x) => x.trim());
      if (v !== undefined) n = Number(v);
      return `${k} = ${n++}`;
    });
    return items.length ? `const ${items.join(', ')};` + '\n'.repeat((m.match(/\n/g) || []).length) : '';
  });
  // --- plain-data structs: struct Point { int x; int y; }; → a factory that builds { x, y } ---
  // (methods, constructors and inheritance stay unsupported; struct copies alias, unlike C)
  const structNames = [];
  {
    const parsed = []; // [name, fields]
    code = code.replace(/\b(typedef\s+)?struct\s+(\w+)?\s*\{([^{}]*)\}\s*(\w+)?\s*;/g, (m, td, tag, body, alias) => {
      const name = td ? alias : tag;
      if (!name || (!td && alias) || /[()]/.test(body)) return m; // left for the "not supported" error below
      const fields = [];
      for (const decl of body.split(';').map((d) => d.trim()).filter(Boolean)) {
        const parts = []; let d = 0, cur = '';
        for (const ch of decl) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
        parts.push(cur);
        const first = parts[0].trim().match(/^(.*?[\w*&])\s*\b([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)(?:=\s*([\s\S]+))?$/);
        if (!first) return m;
        const type = first[1].replace(/\b(?:const|volatile|static)\b/g, '').trim();
        fields.push({ type, name: first[2], dims: first[3], init: first[4] });
        for (const pt of parts.slice(1)) {
          const fm = pt.trim().match(/^([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)(?:=\s*([\s\S]+))?$/);
          if (!fm) return m;
          fields.push({ type, name: fm[1], dims: fm[2], init: fm[3] });
        }
      }
      structNames.push(name); parsed.push([name, fields]);
      return `\u0004${parsed.length - 1}\u0004` + '\n'.repeat((m.match(/\n/g) || []).length);
    });
    const brace = (s) => s.replace(/\{/g, '[').replace(/\}/g, ']');
    code = code.replace(/\u0004(\d+)\u0004/g, (mm, i) => {
      const [name, fields] = parsed[+i];
      const props = fields.map((f, k) => {
        const sub = structNames.includes(f.type) ? f.type : null;
        const dims = (f.dims.match(/\[([^\]]*)\]/g) || []).map((x) => x.slice(1, -1).trim());
        let def = f.init !== undefined ? brace(f.init.trim())
          : sub ? `__new_${sub}()`
            : dims.length && !/^(?:const\s+)?char$/.test(f.type) ? `__arr(${dims.join(', ')})`
              : /String|char/.test(f.type) ? '""' : '0';
        if (dims.length && sub) def = `Array.from({ length: ${dims[0]} }, () => __new_${sub}())`;
        return `${f.name}: v[${k}] !== undefined ? ${sub && !dims.length ? `__new_${sub}(v[${k}])` : `v[${k}]`} : ${def}`;
      });
      return `function __new_${name}(v) { v = v || []; return { ${props.join(', ')} }; }`;
    });
    if (structNames.length) { // Point a, b;  → Point a; Point b;
      code = code.replace(new RegExp(`(?:\\bstruct\\s+)?\\b(${structNames.join('|')})\\s+([A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)+)\\s*;`, 'g'),
        (mm, t, names) => names.split(',').map((n) => `${t} ${n.trim()};`).join(' '));
    }
    // declarations: Point p;  Point p = {1, 2};  Point q = p;  Point ps[3];  Point ps[2] = {{1, 2}, {3, 4}};
    if (structNames.length) {
      const declRe = new RegExp(`(?:\\bstruct\\s+)?\\b(${structNames.join('|')})(\\s*\\*\\s*|\\s+)([A-Za-z_]\\w*)\\s*((?:\\[[^\\]]*\\]\\s*)*)(=\\s*)?`, 'g');
      let out = ''; let last = 0; let dm;
      while ((dm = declRe.exec(code))) {
        const [whole, sname, sep, vname, dimsRaw, eq] = dm; const ptr = sep.includes('*'); let j = dm.index + whole.length; let init = null;
        if (eq) {
          if (code[j] === '{') { const e = matchClose(code, j, '{', '}'); if (e < 0) continue; init = { lit: brace(code.slice(j, e + 1)) }; j = e + 1; } else {
            const e = code.indexOf(';', j); if (e < 0) continue; init = { expr: code.slice(j, e).trim() }; j = e;
          }
        }
        let k = j; while (/[ \t]/.test(code[k])) k++;
        if (code[k] !== ';') continue; // not a declaration (a parameter, a cast, …)
        const dims = (dimsRaw.match(/\[([^\]]*)\]/g) || []).map((x) => x.slice(1, -1).trim());
        let val;
        if (ptr) val = init && init.expr ? init.expr.replace(/^&\s*/, '') : 'null'; // a pointer shares the struct
        else if (dims.length) val = init && init.lit ? (dims[0] ? `Array.from({ length: ${dims[0]} }, (_, i) => __new_${sname}(${init.lit}[i]))` : `${init.lit}.map((x) => __new_${sname}(x))`) : `Array.from({ length: ${dims[0]} }, () => __new_${sname}())`;
        else val = init ? (init.lit ? `__new_${sname}(${init.lit})` : `structuredClone(${init.expr})`) : `__new_${sname}()`;
        out += code.slice(last, dm.index) + `let ${vname} = ${val}`; last = j; declRe.lastIndex = j;
      }
      code = out + code.slice(last);
    }
  }
  const TYPES = typeRe([...BASE_TYPES, ...enumNames, ...structNames, ...LIB_TYPES]);
  const INTS = typeRe([...INT_TYPES, ...enumNames]);

  if (/\b(class|struct|template|typedef|namespace)\b/.test(code)) {
    const kw = code.match(/\b(class|struct|template|typedef|namespace)\b/)[1];
    const line = code.slice(0, code.search(new RegExp(`\\b${kw}\\b`))).split('\n').length;
    throw new TranspileError(`'${kw}' is not supported by the CatSim sketch runner (use plain functions, arrays and globals)`, line);
  }

  // --- library objects: Servo s; DHT dht(15, DHT22); CRGB leds[8]; DateTime t = rtc.now(); ---
  code = libDecls(code);

  // --- numeric literal suffixes ---
  code = code.replace(/\b(0[xX][0-9a-fA-F]+)[uUlL]+\b/g, '$1');
  code = code.replace(/\b(\d+\.\d*(?:[eE][+-]?\d+)?|\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)(?:[uU][lL]{0,2}|[lL]{1,2}[uU]?|[fF])\b/g, '$1');

  // --- integer-literal division truncates, as in C: 7 / 2 == 3 (not after x* or x/, where it binds left) ---
  {
    const litDiv = /(?<![\w.)\]*\/%]\s*)(?<![\w.)\]*\/%])(\d+)\s*\/\s*(\d+)(?![\w.(\[])/g;
    let prev;
    do { prev = code; code = code.replace(litDiv, (m, a, b) => (+b === 0 ? m : String(Math.trunc(+a / +b)))); } while (code !== prev);
  }

  // millis() / 1000 is integer division too (unsigned long ÷ int)
  code = code.replace(/(?<![\w.)\]*\/%]\s*)(?<![\w.)\]*\/%])((?:millis|micros|analogRead|digitalRead|pulseIn|analogReadMilliVolts)\s*\([^()]*\))\s*\/\s*(\d+)(?![\w.(\[])/g, '__idiv($1, $2)');

  // --- misc C++ syntax ---
  code = code.replace(/->/g, '.');
// C octal literals (010 == 8) are a syntax error in strict-mode JS: use 0o10.
code = code.replace(/(?<![\w.])0([0-7]+)(?![\w.])/g, '0o$1');
// yield is a reserved word in strict mode; map Arduino's yield() to the runtime's cooperative yield.
code = code.replace(/(?<![\w.])yield\s*\(/g, '__y(');
  code = code.replace(/\bsizeof\s*\(\s*(\w+)\s*\)\s*\/\s*sizeof\s*\([^)]*\)/g, '$1.length');
  code = code.replace(/\bsizeof\s*\(/g, '__sizeof(');
  code = code.replace(/\.length\s*\(\s*\)/g, '.length');
  code = code.replace(/\.c_str\s*\(\s*\)/g, '');
  code = code.replace(/\b(?:NULL|nullptr)\b/g, 'null');

  // --- casts ---
  code = code.replace(/\(\s*(?:const\s+)?(?:unsigned\s+)?(?:char|byte|uint8_t|void)\s*\*\s*\)/g, '');
  // (float)/(double) leave a marker so integer division never takes the operand next to them; removed at the end
  code = code.replace(/\(\s*(?:float|double)\s*\)\s*/g, FLOAT_CAST);
  code = code.replace(/\(\s*char\s*\)\s*/g, CHAR_CAST);
  code = code.replace(/\(\s*(?:String|bool|boolean)\s*\)/g, '');
  code = code.replace(/\(\s*(?:int|short|byte|uint8_t|uint16_t|int8_t|int16_t|int32_t|unsigned\s+int|unsigned\s+char|word)\s*\)\s*/g, '~~');
  code = code.replace(/\(\s*(?:long\s+long|unsigned\s+long|long|uint32_t|uint64_t|int64_t|size_t|unsigned)\s*\)\s*/g, '+');

  // --- forward declarations: void blink(int n); ---
  code = code.replace(new RegExp(`(^|[;}\\n])([ \\t]*)${QUAL}(?:void|${TYPES})(?:\\s*[\\*&]\\s*|\\s+)([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*;`, 'g'),
    (m, a, b) => a + b);

  // --- function definitions ---
  const fnNames = []; const fnWrap = new Map(); // int-returning function → wrap helper
  const refParams = new Map(); // function → [index, name] of its non-const reference parameters
  const varWrap = new Map(); // integer variable → wrap helper (null when a name has conflicting types)
  const noteVar = (name, w) => varWrap.set(name, varWrap.has(name) && varWrap.get(name) !== w ? null : w);
  // float/double variables and functions, so print(x) shows 2 decimals even for whole numbers
  const floatVar = new Map(); // name → true (always float) / false (declared with another type somewhere)
  const floatFns = new Set(['sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'log10', 'fabs', 'floor', 'ceil', 'fmod']);
  const isFloatType = (t) => /^\s*(?:(?:static|const|volatile|constexpr)\s+)*(?:float|double|long double)\s*$/.test(t);
  const noteFloat = (name, f) => floatVar.set(name, floatVar.has(name) ? floatVar.get(name) && f : f);
  const intTypeRe = new RegExp(`^\\s*${QUAL}(?:${INTS}|bool|boolean|char)\\s*$`); // types whose values wrap/convert on assignment
  code = code.replace(new RegExp(`(^|[;}\\n])([ \\t]*)(${QUAL}(?:void|${TYPES}))((?:\\s*[\\*&]\\s*|\\s+))([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*\\{`, 'g'),
    (m, a, ws, rtype, sep, name, params) => {
      fnNames.push(name);
      if (intTypeRe.test(rtype) && !/[*&]/.test(sep)) fnWrap.set(name, wrapFor(rtype));
      if (isFloatType(rtype) && !/[*&]/.test(sep)) floatFns.add(name); else floatFns.delete(name);
      params.split(',').forEach((prm, idx) => {
        const rm = prm.match(/^\s*(?!.*\bconst\b)[^&]*\S\s*&\s*([A-Za-z_]\w*)\s*$/); // int &v, Point &p — not const String &s
        if (rm) { if (!refParams.has(name)) refParams.set(name, []); refParams.get(name).push([idx, rm[1]]); }
      });
      for (const prm of params.split(',')) {
        const pm = prm.trim().match(/^(.*?)\s*([*&]?)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=.*)?$/);
        if (pm && pm[1] && !/[\[]/.test(prm)) { noteVar(pm[3], intTypeRe.test(pm[1]) && !pm[2] ? wrapFor(pm[1]) : null); noteFloat(pm[3], isFloatType(pm[1])); }
      }
      const nl = '\n'.repeat((m.slice(a.length).match(/\n/g) || []).length);
      return `${a}${ws}async function ${name}(${convParams(params)}) {${nl}`;
    });

  // --- reference parameters: void inc(int &v) changes the caller's variable ---
  // The caller passes a box whose .v reads and writes its variable; the body uses v.v.
  for (const [fname, refs] of refParams) {
    const fm = new RegExp(`async function ${fname}\\([^)]*\\) \\{`).exec(code); if (!fm) continue;
    const open = fm.index + fm[0].length - 1; const close = matchClose(code, open, '{', '}'); if (close < 0) continue;
    let body = code.slice(open, close + 1);
    for (const [, pn] of refs) body = body.replace(new RegExp(`(?<![\\w.])${pn}\\b`, 'g'), `${pn}.v`);
    code = code.slice(0, open) + body + code.slice(close + 1);
  }
  if (refParams.size) {
    const callRe = new RegExp(`(?<![\\w.])(?<!function\\s+)(${[...refParams.keys()].join('|')})\\s*\\(`, 'g');
    const starts = []; let cm;
    while ((cm = callRe.exec(code))) starts.push([cm.index + cm[0].length - 1, cm[1]]);
    for (const [open, fname] of starts.reverse()) { // innermost/last first, so earlier positions stay valid
      const close = matchClose(code, open, '(', ')'); if (close < 0) continue;
      const args = []; let d = 0, cur = '';
      for (const ch of code.slice(open + 1, close)) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { args.push(cur); cur = ''; } else cur += ch; }
      args.push(cur);
      for (const [idx] of refParams.get(fname)) {
        if (args[idx] === undefined) continue;
        const a = args[idx].trim();
        args[idx] = /^[A-Za-z_][\w.]*(?:\s*\[[^\]]*\])*$/.test(a)
          ? ` { get v() { return ${a}; }, set v(__z) { ${a} = __z; } }` : ` { v: ${a} }`;
      }
      code = code.slice(0, open + 1) + args.join(',').replace(/^ /, '') + code.slice(close);
    }
  }

  // --- `static` locals keep their value between calls: hoist them to module scope ---
  {
    const fnRe = /async function (\w+)\([^)]*\) \{/g; const edits = []; let fm;
    const staticRe = new RegExp(`\\bstatic\\s+((?:(?:const|volatile|unsigned|signed)\\s+)*(?:${TYPES}))(?:\\s*[\\*&]\\s*|\\s+)([A-Za-z_]\\w*)\\s*(?:=\\s*([^;]+))?;`, 'g');
    while ((fm = fnRe.exec(code))) {
      const open = fnRe.lastIndex - 1; const close = matchClose(code, open, '{', '}');
      if (close < 0) continue;
      let body = code.slice(open, close + 1); let hoisted = ''; const renames = [];
      body = body.replace(staticRe, (s, type, name, init) => {
        const g = `__s_${fm[1]}_${name}`; renames.push([name, g]);
        hoisted += `let ${g} = ${init !== undefined ? init : /String/.test(type) ? '""' : '0'}; `;
        return '';
      });
      if (!renames.length) continue;
      for (const [n, g] of renames) body = body.replace(new RegExp(`(?<![\\w.])${n}\\b`, 'g'), g);
      edits.push({ start: fm.index, end: close + 1, text: hoisted + code.slice(fm.index, open) + body });
    }
    for (const e of edits.reverse()) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  }

  // --- arrays ---
  const arrInit = new RegExp(`\\b${QUAL}(?:${TYPES})(?:\\s*\\*\\s*|\\s+)([A-Za-z_]\\w*)\\s*((?:\\[[^\\]]*\\]\\s*)+)=\\s*`, 'g');
  let out = ''; let last = 0; let m;
  while ((m = arrInit.exec(code))) {
    out += code.slice(last, m.index) + `let ${m[1]} = `;
    last = arrInit.lastIndex;
    if (code[last] === '{') {
      const end = matchClose(code, last, '{', '}');
      if (end < 0) throw new TranspileError('Unbalanced { } in array initializer', code.slice(0, m.index).split('\n').length);
      const lit = code.slice(last, end + 1).replace(/\{/g, '[').replace(/\}/g, ']');
      const dims = m[2].match(/\[([^\]]*)\]/g).map((d) => d.slice(1, -1).trim());
      out += dims.every(Boolean) ? `__pad(${lit}, ${dims.join(', ')})` : lit;
      last = end + 1; arrInit.lastIndex = last;
    }
  }
  code = out + code.slice(last);
  code = code.replace(new RegExp(`\\b${QUAL}(?:${TYPES})(?:\\s*\\*\\s*|\\s+)([A-Za-z_]\\w*)\\s*((?:\\[[^\\]]+\\]\\s*)+);`, 'g'),
    (mm, name, dims) => `let ${name} = __arr(${dims.match(/\[([^\]]+)\]/g).map((d) => d.slice(1, -1)).join(', ')});`);

  // --- C integer semantics: values assigned to integer variables wrap to the type's width ---
  // e.g. byte b = 255; b++; → 0. Names declared with different types in different places are left alone.
  {
    // declarations: int a = 7, b; → record each name and wrap its initialiser
    const declRe = new RegExp(`(?<=^|[;{}(\\n])()(\\s*)(${QUAL}(?:${TYPES}))\\s+([A-Za-z_][^;]*);`, 'g');
    code = code.replace(declRe, (mm, pre, ws, type, rest) => {
      const isInt = intTypeRe.test(type); const w = isInt ? wrapFor(type) : null;
      const parts = []; let d = 0, cur = '';
      for (const ch of rest) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
      parts.push(cur);
      const out = parts.map((pt) => {
        const dm = pt.match(/^(\s*)([A-Za-z_]\w*)(\s*)(=\s*)?([\s\S]*)$/);
        if (!dm || (!dm[4] && dm[5].trim())) return null; // not a plain `name` / `name = value`
        if (!dm[4]) { // int count;  → 0, like a C global (locals are garbage in C; 0 is the friendly choice)
          const z = w || isFloatType(type) ? '0' : /^\s*(?:(?:static|const|volatile)\s+)*String\s*$/.test(type) ? '""' : null;
          noteVar(dm[2], w); noteFloat(dm[2], isFloatType(type));
          return z ? `${dm[1]}${dm[2]} = ${z}` : pt;
        }
        noteVar(dm[2], w); noteFloat(dm[2], isFloatType(type));
        const plainInt = /^(?:0[xX][0-9a-fA-F]+|0o[0-7]+|\d+)$/.test(dm[5].trim()) && w !== '__b' && w !== '__ch' && w !== '__u8' && w !== '__i8' && w !== '__u16' && w !== '__i16';
        return dm[4] && w && !plainInt ? `${dm[1]}${dm[2]}${dm[3]}${dm[4]}${w}(${dm[5].trim()})` : pt;
      });
      return out.includes(null) ? mm : keepNl(mm, `${pre}${ws}${type} ${out.join(',').trimStart()};`);
    });
    const ints = [...varWrap].filter(([, w]) => w).map(([n]) => n);
    const W = (n) => varWrap.get(n);
    const V = (n) => (W(n) === '__ch' ? `__ord(${n})` : n); // a char variable's value as a number
    // chars in arithmetic are numbers: 'A' + 1 == 66, c - '0' == digit. Comparisons keep working on the
    // 1-letter strings that Serial.read(), charAt() and char literals give.
    {
      const isCharLit = (t) => { const m = /^__STR(\d+)__$/.exec(t); return m && strs[+m[1]][0] === "'" ? strs[+m[1]] : null; };
      const code1 = (lit) => { const body = lit.slice(1, -1); const esc = { n: 10, r: 13, t: 9, '0': 0, '\\': 92, "'": 39, '"': 34 }; return body[0] === '\\' ? (esc[body[1]] ?? body.charCodeAt(1)) : body.charCodeAt(0); };
      const isNum = (t) => /^(?:0[xX][0-9a-fA-F]+|0o[0-7]+|\d+(?:\.\d*)?)$/.test(t);
      const charish = (t) => isCharLit(t) || W(t) === '__ch';
      const numeric = (t) => isNum(t) || charish(t) || (W(t) && W(t) !== '__ch');
      const isOrd = (t) => /^__ord\(/.test(t); // already converted by an earlier pair
      const conv = (t) => { const lit = isCharLit(t); return lit ? String(code1(lit)) : isNum(t) || isOrd(t) ? t : `__ord(${t})`; };
      const OPND = '(?<![\\w.\\]])(__ord\\([^()]*\\)|[A-Za-z_]\\w*(?:\\s*\\[[^\\]]*\\])*|\\d+(?:\\.\\d*)?)(?![\\w(.\\[])';
      const OP = '(<<|>>|==|!=|<=|>=|(?<![<>])[<>](?![<>=])|(?<![-+&|])[-*/%^](?![-=])|(?<![&])&(?![&=])|(?<![|])\\|(?![|=])|(?<!\\+)\\+(?![+=]))';
      const pair = new RegExp(`${OPND}(\\s*)${OP}(\\s*)${OPND}`, 'g');
      // Scan by hand: when a pair is not about chars, step past its left operand only, so `n + c - '0'`
      // still pairs `c - '0'` (a plain replace would swallow `n + c` and skip it).
      let pm; pair.lastIndex = 0;
      while ((pm = pair.exec(code))) {
        const [mm, l, s1, op, s2, r] = pm;
        const cl = charish(l) || (isOrd(l) && !isNum(r)), cr = charish(r) || (isOrd(r) && !isNum(l));
        let ok = cl || cr;
        if (ok && op === '+') ok = (numeric(l) || isOrd(l)) && (numeric(r) || isOrd(r)); // String + 'c' stays text
        if (ok && /[<>=!]/.test(op) && op.length <= 2 && !/^(<<|>>)$/.test(op)) ok = (cl && isNum(r)) || (cr && isNum(l)); // c == 65, not c == 'a'
        if (ok && isOrd(l) && isOrd(r)) ok = false;
        if (!ok) { pair.lastIndex = pm.index + l.length; continue; }
        const rep2 = `${conv(l)}${s1}${op}${s2}${conv(r)}`;
        code = code.slice(0, pm.index) + rep2 + code.slice(pm.index + mm.length);
        pair.lastIndex = pm.index + rep2.length - conv(r).length; // the right operand can start the next pair
      }
    }
    // c++ / c-- on a char anywhere (for headers too): the next/previous letter
    const chars = [...varWrap].filter(([, w]) => w === '__ch').map(([n]) => n);
    if (chars.length) {
      const C = `(${chars.join('|')})`;
      code = code.replace(new RegExp(`(?<![\\w.])(?:(\\+\\+|--)${C}|${C}(\\+\\+|--))(?![\\w(])(?!\\s*;)`, 'g'),
        (mm, op1, n1, n2, op2) => { const n = n1 || n2; return `(${n} = __ch(__ord(${n}) ${(op1 || op2)[0]} 1))`; });
    }
    if (ints.length) {
      const N = `(${ints.join('|')})`;
      const pre = '(^|[;{}\\n)])(\\s*)';
      // a right-hand side must be one whole expression: `for (…; i += 2) { f(i); }` is not a statement
      const whole = (rhs) => { if (/[{}]/.test(rhs) || hasTopLevelComma(rhs)) return false; let d = 0; for (const ch of rhs) { if ('(['.includes(ch)) d++; else if (')]'.includes(ch) && --d < 0) return false; } return d === 0; };
      // x = v;  (before the compound forms, which produce `x = …` themselves)
      code = code.replace(new RegExp(`${pre}${N}\\s*=(?!=)\\s*([^;]*);`, 'g'),
        (mm, a, ws, n, rhs) => (whole(rhs) ? keepNl(mm, `${a}${ws}${n} = ${W(n)}(${rhs});`) : mm));
      // x += v;  x <<= v;  …
      code = code.replace(new RegExp(`${pre}${N}\\s*(\\+|-|\\*|\\/|%|<<|>>|&|\\||\\^)=\\s*([^;]*);`, 'g'),
        (mm, a, ws, n, op, rhs) => (whole(rhs) ? keepNl(mm, `${a}${ws}${n} = ${W(n)}(${V(n)} ${op} (${rhs}));`) : mm));
      // x++;  --x;
      code = code.replace(new RegExp(`${pre}(?:(\\+\\+|--)${N}|${N}(\\+\\+|--))\\s*;`, 'g'),
        (mm, a, ws, op1, n1, n2, op2) => { const n = n1 || n2; return keepNl(mm, `${a}${ws}${n} = ${W(n)}(${V(n)} ${(op1 || op2)[0]} 1);`); });
      // integer division between integer variables/literals: avg = sum / count
      const opnd = `(${ints.join('|')}|\\d+)`;
      code = code.replace(new RegExp(`(?<![\\w.)\\]*\\/%\\u0001]\\s*)(?<![\\w.)\\]*\\/%\\u0001])\\b${opnd}\\s*\\/\\s*${opnd}\\b(?![\\w.(\\[])`, 'g'),
        (mm, l, r) => keepNl(mm, `__idiv(${l}, ${r})`));
    }
    // print(x) / String(x) of a float shows 2 decimals, even when the value is whole: float f = 3; → 3.00
    {
      const floats = [...floatVar].filter(([, f]) => f).map(([n]) => n);
      const isFloatExpr = (arg) => {
        const a = arg.trim();
        if (!a || /__STR|[<>=!&|?,~]/.test(a)) return false;
        const call = a.match(/^(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
        if (call && (a.includes('.') ? FLOAT_METHODS.has(call[1]) : floatFns.has(call[1])) && matchClose(a, a.indexOf('('), '(', ')') === a.length - 1) return true;
        if (/\d\.\d*|\.\d/.test(a) && !/~~|\+\s*\(|%/.test(a)) return true; // a float literal makes the whole expression float: x * 3.3 / 4095
        if (/[()]/.test(a)) return false; // keep it to plain arithmetic: (int)(t * 10) is not a float
        const ids = a.match(/[A-Za-z_]\w*/g) || [];
        if (ids.some((id) => !floats.includes(id) && !(varWrap.get(id)))) return false; // only known numeric names
        return ids.some((id) => floats.includes(id)) || /\d\.\d*|\.\d/.test(a);
      };
      const callRe = /\.\s*(?:print|println)\s*\(|(?<![\w.])String\s*\(/g; const closes = []; let cm;
      while ((cm = callRe.exec(code))) {
        const open = cm.index + cm[0].length - 1; const close = matchClose(code, open, '(', ')');
        if (close > 0 && isFloatExpr(code.slice(open + 1, close))) closes.push(close);
      }
      for (const c of closes.sort((a, b) => b - a)) code = code.slice(0, c) + ', 2' + code.slice(c);
    }

    // (int)'A' → 65, (int)c → its code
    code = code.replace(/~~\s*__STR(\d+)__/g, (mm, n) => (strs[+n][0] === "'" ? String(strs[+n].length > 3 ? ({ n: 10, r: 13, t: 9, '0': 0 }[strs[+n][2]] ?? strs[+n].charCodeAt(2)) : strs[+n].charCodeAt(1)) : mm));
    code = code.replace(/~~\s*([A-Za-z_]\w*)(?![\w(.\[])/g, (mm, n) => (varWrap.get(n) === '__ch' ? `~~__ord(${n})` : mm));

    // int-returning functions return whole numbers of their type
    for (const [fname, w] of fnWrap) {
      const fm = new RegExp(`async function ${fname}\\([^)]*\\) \\{`).exec(code); if (!fm) continue;
      const open = fm.index + fm[0].length - 1; const close = matchClose(code, open, '{', '}'); if (close < 0) continue;
      const body = code.slice(open, close + 1).replace(/\breturn\s+([^;]+);/g, (mm, v) => keepNl(mm, `return ${w}(${v});`));
      code = code.slice(0, open) + body + code.slice(close + 1);
    }
  }

  // --- typed declarations → let ---
  code = code.replace(new RegExp(`\\b${QUAL}(?:${TYPES})\\b(?:\\s*[\\*&]\\s*|\\s+)(?=[A-Za-z_])`, 'g'), 'let ');
  code = code.replace(/\bfor\s*\(\s*let\s+&?\s*([A-Za-z_]\w*)\s*:\s*/g, 'for (let $1 of ');

  // --- Arduino calls that change their argument in place ---
  code = code.replace(/(^|[;{}\n])(\s*)(bitSet|bitClear|bitWrite)\s*\(\s*([A-Za-z_][\w.]*(?:\[[^\]]*\])*)\s*,/g, '$1$2$4 = $3($4,');
  code = code.replace(/(^|[;{}\n])(\s*)([A-Za-z_][\w.]*(?:\[[^\]]*\])*)\s*\.\s*(toUpperCase|toLowerCase|trim|replace|remove)\s*\(([^;]*)\)\s*;/g,
    (mm, a, ws, v, fn, args) => `${a}${ws}${v} = ${v}.${fn === 'replace' ? 'replaceAll' : fn}(${args});`);

  // --- C string helpers that write into a buffer argument ---
  code = code.replace(/\bsprintf\s*\(\s*([A-Za-z_]\w*)\s*,/g, '$1 = __sprintf(');
  code = code.replace(/\bsnprintf\s*\(\s*([A-Za-z_]\w*)\s*,/g, '$1 = __snprintf(');
  code = code.replace(/\bdtostrf\s*\(([^;]*?),\s*([A-Za-z_]\w*)\s*\)/g, '$2 = __dtostrf($1)');
  // serializeJson(doc, buf) fills buf; EEPROM.get(addr, v) fills v (printing to Serial changes nothing)
  code = code.replace(/(^|[;{}\n)]|\belse)(\s*)(serializeJson|serializeJsonPretty)\s*\(\s*([^,;]+?)\s*,\s*([A-Za-z_]\w*(?:\s*\[[^\]]*\])*)\s*(?:,[^;]*)?\)\s*;/g,
    (mm, a, ws, fn, doc, out) => (/^Serial\d?$/.test(out) ? mm : `${a}${ws}${out} = ${fn}(${doc}, ${out});`));
  code = code.replace(/(^|[;{}\n)]|\belse)(\s*)EEPROM\s*\.\s*get\s*\(\s*([^,;]+?)\s*,\s*([A-Za-z_][\w.]*(?:\s*\[[^\]]*\])*)\s*\)\s*;/g,
    (mm, a, ws, addr, v) => `${a}${ws}${v} = EEPROM.get(${addr}, ${v});`);

  // --- await: delay(), user functions, HTTP requests ---
  code = code.replace(/(?<![\w.])(delay|delayMicroseconds|__y)\s*\(/g, 'await $1(');
  if (fnNames.length) {
    code = code.replace(new RegExp(`(?<![\\w.])(?<!function\\s+)(${fnNames.join('|')})\\s*\\(`, 'g'), 'await $1(');
  }
  code = code.replace(new RegExp(`(?<![\\w.])([A-Za-z_]\\w*(?:\\s*\\[[^\\]]*\\])?)\\s*\\.\\s*(GET|POST|PUT|PATCH|sendRequest|${LIB_BLOCKING.join('|')})\\s*\\(`, 'g'), 'await $1.$2(');

  // --- cooperative yield inside loops so the page never freezes ---
  let res = ''; const loopRe = /\b(while|for)\s*\(|\bdo\s*\{/g; last = 0;
  while ((m = loopRe.exec(code))) {
    if (m[0].startsWith('do')) {
      res += code.slice(last, loopRe.lastIndex) + ' await __y();'; last = loopRe.lastIndex; continue;
    }
    const open = loopRe.lastIndex - 1; const close = matchClose(code, open, '(', ')');
    if (close < 0) continue;
    let k = close + 1; while (/\s/.test(code[k])) k++;
    if (code[k] === '{') { res += code.slice(last, k + 1) + ' await __y();'; last = k + 1; loopRe.lastIndex = k + 1; }
  }
  code = res + code.slice(last);

  // --- restore string literals ---
  code = code.replace(new RegExp(`${CHAR_CAST}\\s*(\\([^()]*\\)|[A-Za-z_][\\w.]*(?:\\([^()]*\\)|\\[[^\\]]*\\])?|\\d+)`, 'g'), '__ch($1)');
  code = code.split(CHAR_CAST).join('');
  code = code.split(FLOAT_CAST).join('');
  code = code.replace(/__STR(\d+)__/g, (mm, n) => strs[+n]);
  return { js: code, functions: fnNames, includes };
}

export { transpile, TranspileError };
