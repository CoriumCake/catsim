// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', 'js', 'transpiler.js'));
require(path.join(__dirname, '..', 'js', 'examples.js'));
const NS = window.CatSim;

// Compile the transpiled sketch the same way the runtime does (syntax check only).
const compile = (js) => new Function('__api', `return (async function(){ with (__api) { ${js}\n;return 1; } })();`);

for (const ex of NS.EXAMPLES) {
  test(`example "${ex.key}" transpiles to valid JavaScript`, () => {
    const { js, functions } = NS.transpile(ex.code);
    assert.ok(functions.includes('setup') && functions.includes('loop'));
    compile(js);
  });
}

test('delay() and user functions are awaited', () => {
  const { js } = NS.transpile('void blink(int n) { delay(n); }\nvoid setup() {}\nvoid loop() { blink(5); }');
  assert.match(js, /async function blink\(n\)/);
  assert.match(js, /await delay\(n\)/);
  assert.match(js, /await blink\(5\)/);
});

test('static locals keep their value between calls', async () => {
  const { js } = NS.transpile('int tick() { static int n = 0; n++; return n; }\nvoid setup() {}\nvoid loop() {}');
  const run = new Function(`return (async () => { ${js}\n; await tick(); await tick(); return await tick(); })();`);
  assert.equal(await run(), 3);
});

test('integer division is truncated for int variables', async () => {
  const { js } = NS.transpile('int half() { int x = 7 / 2; return x; }\nvoid setup() {}\nvoid loop() {}');
  const run = new Function('__i', `return (async () => { ${js}\n; return await half(); })();`);
  assert.equal(await run((v) => Math.trunc(v)), 3);
});

test('arrays, enums and #define are converted', () => {
  const { js } = NS.transpile('#define LED 2\nint pins[] = {1, 2, 3};\nenum Mode { A, B = 5, C };\nvoid setup() {}\nvoid loop() {}');
  assert.match(js, /const LED = 2;/);
  assert.match(js, /let pins = \[1, 2, 3\];/);
  assert.match(js, /const A = 0, B = 5, C = 6;/);
  compile(js);
});

test('unsupported C++ reports a line number', () => {
  assert.throws(() => NS.transpile('void setup() {}\nstruct P { int x; };\nvoid loop() {}'), (e) => e.line === 2);
});
