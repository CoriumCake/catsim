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

  // --- misc C++ syntax ---
  code = code.replace(/->/g, '.');
  code = code.replace(/\bsizeof\s*\(\s*(\w+)\s*\)\s*\/\s*sizeof\s*\([^)]*\)/g, '$1.length');
  code = code.replace(/\bsizeof\s*\(/g, '__sizeof(');
  code = code.replace(/\.length\s*\(\s*\)/g, '.length');
  code = code.replace(/\.c_str\s*\(\s*\)/g, '');
  code = code.replace(/\b(?:NULL|nullptr)\b/g, 'null');

  // --- casts ---
  code = code.replace(/\(\s*(?:const\s+)?(?:unsigned\s+)?(?:char|byte|uint8_t|void)\s*\*\s*\)/g, '');
  code = code.replace(/\(\s*(?:float|double|String|char|bool|boolean)\s*\)/g, '');
  code = code.replace(/\(\s*(?:int|short|byte|uint8_t|uint16_t|int8_t|int16_t|int32_t|unsigned\s+int|unsigned\s+char|word)\s*\)\s*/g, '~~');
  code = code.replace(/\(\s*(?:long\s+long|unsigned\s+long|long|uint32_t|uint64_t|int64_t|size_t|unsigned)\s*\)\s*/g, '+');

  // --- forward declarations: void blink(int n); ---
  code = code.replace(new RegExp(`(^|[;}\\n])([ \\t]*)${QUAL}(?:void|${TYPES})(?:\\s*[\\*&]\\s*|\\s+)([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*;`, 'g'),
    (m, a, b) => a + b);

  // --- function definitions ---
  const fnNames = [];
  code = code.replace(new RegExp(`(^|[;}\\n])([ \\t]*)${QUAL}(?:void|${TYPES})(?:\\s*[\\*&]\\s*|\\s+)([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*\\{`, 'g'),
    (m, a, ws, name, params) => {
      fnNames.push(name);
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
      out += code.slice(last, end + 1).replace(/\{/g, '[').replace(/\}/g, ']');
      last = end + 1; arrInit.lastIndex = last;
    }
  }
  code = out + code.slice(last);
  code = code.replace(new RegExp(`\\b${QUAL}(?:${TYPES})(?:\\s*\\*\\s*|\\s+)([A-Za-z_]\\w*)\\s*((?:\\[[^\\]]+\\]\\s*)+);`, 'g'),
    (mm, name, dims) => `let ${name} = __arr(${dims.match(/\[([^\]]+)\]/g).map((d) => d.slice(1, -1)).join(', ')});`);

  // --- integer division for int-typed declarations/assignments ---
  const intVars = new Set();
  code.replace(new RegExp(`\\b${QUAL}(?:${INTS})\\s+([A-Za-z_]\\w*)`, 'g'), (mm, n) => intVars.add(n));
  code = code.replace(new RegExp(`\\b(${QUAL}(?:${INTS})\\s+)([A-Za-z_]\\w*)(\\s*=\\s*)([^;]*\\/[^;]*);`, 'g'),
    (mm, t, n, eq, rhs) => (hasTopLevelComma(rhs) ? mm : `${t}${n}${eq}__i(${rhs});`));
  if (intVars.size) {
    const names = [...intVars].join('|');
    code = code.replace(new RegExp(`(^|[;{}\\s])(${names})(\\s*=)(?!=)([^;]*\\/[^;]*);`, 'g'),
      (mm, pre, n, eq, rhs) => (hasTopLevelComma(rhs) || /^\s*__i\(/.test(rhs) ? mm : `${pre}${n}${eq} __i(${rhs});`));
  }

  // --- typed declarations → let ---
  code = code.replace(new RegExp(`\\b${QUAL}(?:${TYPES})\\b(?:\\s*[\\*&]\\s*|\\s+)(?=[A-Za-z_])`, 'g'), 'let ');
  code = code.replace(/\bfor\s*\(\s*let\s+&?\s*([A-Za-z_]\w*)\s*:\s*/g, 'for (let $1 of ');

  // --- C string helpers that write into a buffer argument ---
  code = code.replace(/\bsprintf\s*\(\s*([A-Za-z_]\w*)\s*,/g, '$1 = __sprintf(');
  code = code.replace(/\bsnprintf\s*\(\s*([A-Za-z_]\w*)\s*,/g, '$1 = __snprintf(');
  code = code.replace(/\bdtostrf\s*\(([^;]*?),\s*([A-Za-z_]\w*)\s*\)/g, '$2 = __dtostrf($1)');

  // --- await: delay(), user functions, HTTP requests ---
  code = code.replace(/(?<![\w.])(delay|delayMicroseconds|yield)\s*\(/g, 'await $1(');
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
  code = code.replace(/__STR(\d+)__/g, (mm, n) => strs[+n]);
  return { js: code, functions: fnNames };
}

export { transpile, TranspileError };
