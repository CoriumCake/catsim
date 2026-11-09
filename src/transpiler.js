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
const CLASSES = ['Servo', 'DHT', 'PubSubClient', 'WiFiClient', 'WiFiClientSecure', 'HTTPClient', 'LiquidCrystal_I2C'];
const typeRe = (list) => list.map((t) => t.replace(/ /g, '\\s+')).join('|');
const QUAL = '(?:(?:static|const|volatile|constexpr|unsigned|signed|inline)\\s+)*';

// C integer type → the runtime helper that wraps a value to that type's width (ESP32: int and long are 32 bit).
function wrapFor(type) {
  const t = type.replace(/\b(?:static|const|volatile|constexpr|inline|signed)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:bool|boolean)$/.test(t)) return '__b';
  if (/^(?:unsigned )?long long$|^u?int64_t$/.test(t)) return '__i';
  if (/^(?:unsigned char|byte|uint8_t)$/.test(t)) return '__u8';
  if (/^(?:char|int8_t)$/.test(t)) return '__i8';
  if (/^(?:unsigned short|uint16_t|word)$/.test(t)) return '__u16';
  if (/^(?:short|int16_t)$/.test(t)) return '__i16';
  if (/^(?:unsigned(?: int| long)?|uint32_t|size_t)$/.test(t)) return '__u32';
  return '__i32'; // int, long, int32_t, enums
}

const FLOAT_CAST = '\u0001';
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

function transpile(source) {
  let { code, strs } = mask(source.replace(/\r\n?/g, '\n'));

  // --- preprocessor ---
  code = code.replace(/^[ \t]*#[ \t]*include[^\n]*/gm, '');
  code = code.replace(/^[ \t]*#[ \t]*define[ \t]+(\w+)\(([^)]*)\)[ \t]+([^\n]+)/gm, 'const $1 = ($2) => ($3);');
  code = code.replace(/^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+([^\n]+)/gm, 'const $1 = $2;');
  code = code.replace(/^[ \t]*#[^\n]*/gm, '');
  code = code.replace(/\b(?:IRAM_ATTR|ICACHE_RAM_ATTR|PROGMEM|DRAM_ATTR)\b/g, '');

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
  const TYPES = typeRe([...BASE_TYPES, ...enumNames]);
  const INTS = typeRe([...INT_TYPES, ...enumNames]);

  if (/\b(class|struct|template|typedef|namespace)\b/.test(code)) {
    const kw = code.match(/\b(class|struct|template|typedef|namespace)\b/)[1];
    const line = code.slice(0, code.search(new RegExp(`\\b${kw}\\b`))).split('\n').length;
    throw new TranspileError(`'${kw}' is not supported by the CatSim sketch runner (use plain functions, arrays and globals)`, line);
  }

  // --- library objects: Servo s; DHT dht(15, DHT22); ---
  code = code.replace(new RegExp(`\\b(${CLASSES.join('|')})\\s+([A-Za-z_]\\w*)\\s*(?:\\(([^;]*)\\))?\\s*;`, 'g'),
    (m, cls, name, args) => `let ${name} = new ${cls}(${args || ''});`);

  // --- numeric literal suffixes ---
  code = code.replace(/\b(0[xX][0-9a-fA-F]+)[uUlL]+\b/g, '$1');
  code = code.replace(/\b(\d+\.\d*(?:[eE][+-]?\d+)?|\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)(?:[uU][lL]{0,2}|[lL]{1,2}[uU]?|[fF])\b/g, '$1');

  // --- integer-literal division truncates, as in C: 7 / 2 == 3 (not after x* or x/, where it binds left) ---
  {
    const litDiv = /(?<![\w.)\]*\/%]\s*)(?<![\w.)\]*\/%])(\d+)\s*\/\s*(\d+)(?![\w.(\[])/g;
    let prev;
    do { prev = code; code = code.replace(litDiv, (m, a, b) => (+b === 0 ? m : String(Math.trunc(+a / +b)))); } while (code !== prev);
  }

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
  code = code.replace(/\(\s*(?:String|char|bool|boolean)\s*\)/g, '');
  code = code.replace(/\(\s*(?:int|short|byte|uint8_t|uint16_t|int8_t|int16_t|int32_t|unsigned\s+int|unsigned\s+char|word)\s*\)\s*/g, '~~');
  code = code.replace(/\(\s*(?:long\s+long|unsigned\s+long|long|uint32_t|uint64_t|int64_t|size_t|unsigned)\s*\)\s*/g, '+');

  // --- forward declarations: void blink(int n); ---
  code = code.replace(new RegExp(`(^|[;}\\n])([ \\t]*)${QUAL}(?:void|${TYPES})(?:\\s*[\\*&]\\s*|\\s+)([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*;`, 'g'),
    (m, a, b) => a + b);

  // --- function definitions ---
  const fnNames = []; const fnWrap = new Map(); // int-returning function → wrap helper
  const varWrap = new Map(); // integer variable → wrap helper (null when a name has conflicting types)
  const noteVar = (name, w) => varWrap.set(name, varWrap.has(name) && varWrap.get(name) !== w ? null : w);
  // float/double variables and functions, so print(x) shows 2 decimals even for whole numbers
  const floatVar = new Map(); // name → true (always float) / false (declared with another type somewhere)
  const floatFns = new Set(['sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'log10', 'fabs', 'floor', 'ceil', 'fmod']);
  const isFloatType = (t) => /^\s*(?:(?:static|const|volatile|constexpr)\s+)*(?:float|double|long double)\s*$/.test(t);
  const noteFloat = (name, f) => floatVar.set(name, floatVar.has(name) ? floatVar.get(name) && f : f);
  const intTypeRe = new RegExp(`^\\s*${QUAL}(?:${INTS}|bool|boolean)\\s*$`); // types whose values wrap/convert on assignment
  code = code.replace(new RegExp(`(^|[;}\\n])([ \\t]*)(${QUAL}(?:void|${TYPES}))((?:\\s*[\\*&]\\s*|\\s+))([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*\\{`, 'g'),
    (m, a, ws, rtype, sep, name, params) => {
      fnNames.push(name);
      if (intTypeRe.test(rtype) && !/[*&]/.test(sep)) fnWrap.set(name, wrapFor(rtype));
      if (isFloatType(rtype) && !/[*&]/.test(sep)) floatFns.add(name); else floatFns.delete(name);
      for (const prm of params.split(',')) {
        const pm = prm.trim().match(/^(.*?)\s*([*&]?)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=.*)?$/);
        if (pm && pm[1] && !/[\[]/.test(prm)) { noteVar(pm[3], intTypeRe.test(pm[1]) && !pm[2] ? wrapFor(pm[1]) : null); noteFloat(pm[3], isFloatType(pm[1])); }
      }
      const nl = '\n'.repeat((m.slice(a.length).match(/\n/g) || []).length);
      return `${a}${ws}async function ${name}(${convParams(params)}) {${nl}`;
    });

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
    const declRe = new RegExp(`(^|[;{}(\\n])(\\s*)(${QUAL}(?:${TYPES}))\\s+([A-Za-z_][^;]*);`, 'g');
    code = code.replace(declRe, (mm, pre, ws, type, rest) => {
      const isInt = intTypeRe.test(type); const w = isInt ? wrapFor(type) : null;
      const parts = []; let d = 0, cur = '';
      for (const ch of rest) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
      parts.push(cur);
      const out = parts.map((pt) => {
        const dm = pt.match(/^(\s*)([A-Za-z_]\w*)(\s*)(=\s*)?([\s\S]*)$/);
        if (!dm || (!dm[4] && dm[5].trim())) return null; // not a plain `name` / `name = value`
        noteVar(dm[2], w); noteFloat(dm[2], isFloatType(type));
        const plainInt = /^(?:0[xX][0-9a-fA-F]+|0o[0-7]+|\d+)$/.test(dm[5].trim()) && w !== '__b' && w !== '__u8' && w !== '__i8' && w !== '__u16' && w !== '__i16';
        return dm[4] && w && !plainInt ? `${dm[1]}${dm[2]}${dm[3]}${dm[4]}${w}(${dm[5].trim()})` : pt;
      });
      return out.includes(null) ? mm : keepNl(mm, `${pre}${ws}${type} ${out.join(',').trimStart()};`);
    });
    const ints = [...varWrap].filter(([, w]) => w).map(([n]) => n);
    if (ints.length) {
      const N = `(${ints.join('|')})`; const W = (n) => varWrap.get(n);
      const pre = '(^|[;{}\\n)])(\\s*)';
      // a right-hand side must be one whole expression: `for (…; i += 2) { f(i); }` is not a statement
      const whole = (rhs) => { if (/[{}]/.test(rhs) || hasTopLevelComma(rhs)) return false; let d = 0; for (const ch of rhs) { if ('(['.includes(ch)) d++; else if (')]'.includes(ch) && --d < 0) return false; } return d === 0; };
      // x = v;  (before the compound forms, which produce `x = …` themselves)
      code = code.replace(new RegExp(`${pre}${N}\\s*=(?!=)\\s*([^;]*);`, 'g'),
        (mm, a, ws, n, rhs) => (whole(rhs) ? keepNl(mm, `${a}${ws}${n} = ${W(n)}(${rhs});`) : mm));
      // x += v;  x <<= v;  …
      code = code.replace(new RegExp(`${pre}${N}\\s*(\\+|-|\\*|\\/|%|<<|>>|&|\\||\\^)=\\s*([^;]*);`, 'g'),
        (mm, a, ws, n, op, rhs) => (whole(rhs) ? keepNl(mm, `${a}${ws}${n} = ${W(n)}(${n} ${op} (${rhs}));`) : mm));
      // x++;  --x;
      code = code.replace(new RegExp(`${pre}(?:(\\+\\+|--)${N}|${N}(\\+\\+|--))\\s*;`, 'g'),
        (mm, a, ws, op1, n1, n2, op2) => { const n = n1 || n2; return keepNl(mm, `${a}${ws}${n} = ${W(n)}(${n} ${(op1 || op2)[0]} 1);`); });
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
        const call = a.match(/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
        if (call && floatFns.has(call[1]) && matchClose(a, a.indexOf('('), '(', ')') === a.length - 1) return true;
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

  // --- await: delay(), user functions, HTTP requests ---
  code = code.replace(/(?<![\w.])(delay|delayMicroseconds|__y)\s*\(/g, 'await $1(');
  if (fnNames.length) {
    code = code.replace(new RegExp(`(?<![\\w.])(?<!function\\s+)(${fnNames.join('|')})\\s*\\(`, 'g'), 'await $1(');
  }
  code = code.replace(/(?<![\w.])([A-Za-z_]\w*)\s*\.\s*(GET|POST|PUT|PATCH|sendRequest)\s*\(/g, 'await $1.$2(');

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
  code = code.split(FLOAT_CAST).join('');
  code = code.replace(/__STR(\d+)__/g, (mm, n) => strs[+n]);
  return { js: code, functions: fnNames };
}

export { transpile, TranspileError };
