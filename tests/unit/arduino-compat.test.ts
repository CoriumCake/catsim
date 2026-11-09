/* Arduino-compatibility checks: each sketch prints something in setup(), and the expected text is
 * what the same sketch prints on a real ESP32 with the Arduino core (int = 32 bit, Serial line ends \r\n). */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { DEFS } from '../../src/components.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

async function run(body: string, globals = '', input = '') {
  const host = {
    project: { name: 't', code: '', components: [{ id: 'esp', type: 'esp32', x: 0, y: 0, props: { ...DEFS.esp32.props } }], wires: [] },
    logs: [] as Array<[string, string]>, errors: [] as unknown[],
    log(msg: string, level = 'info') { host.logs.push([level, msg]); },
    reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim = new Simulator(host) as any; live = sim;
  const started = sim.start(`${globals}\nvoid setup() {\n${body}\n}\nvoid loop() { delay(1000); }`);
  sim.serialIn = input; // start() clears it synchronously; setup() runs after
  const ok = await Promise.race([
    started,
    new Promise((r) => setTimeout(() => r('started'), 60)),
  ]);
  await new Promise((r) => setTimeout(r, 40));
  const errs = host.logs.filter(([l]) => l === 'error').map(([, m]) => m);
  if (ok === false || errs.length || host.errors.length) return `ERROR: ${[...errs, ...host.errors.map(String)].join(' | ')}`;
  return sim.serialOut as string;
}

const cases: Array<[string, string, string, string?]> = [
  // [name, setup body, expected serial output, globals]
  ['print float defaults to 2 decimals', 'Serial.print(3.14159);', '3.14'],
  ['print float with digits', 'Serial.print(2.5, 3);', '2.500'],
  ['print negative float', 'Serial.print(-1.5);', '-1.50'],
  ['print HEX/BIN/OCT', 'Serial.print(255, HEX); Serial.print(" "); Serial.print(5, BIN); Serial.print(" "); Serial.print(8, OCT);', 'FF 101 10'],
  ['println ends with CRLF', 'Serial.println(1);', '1\r\n'],
  ['print bool prints 1/0', 'Serial.print(true); Serial.print(false);', '10'],
  ['print char', "Serial.print('A');", 'A'],
  ['printf', 'Serial.printf("%d %05.2f %s %x\\n", 42, 3.14159, "hi", 255);', '42 03.14 hi ff\n'],
  ['integer literal division', 'Serial.print(7 / 2);', '3'],
  ['negative integer division truncates', 'Serial.print(-7 / 2);', '-3'],
  ['float = int/float', 'float f = 7 / 2.0; Serial.print(f);', '3.50'],
  ['modulo', 'Serial.print(7 % 3); Serial.print(-7 % 3);', '1-1'],
  ['int is 32-bit on ESP32', 'int x = 32767; x++; Serial.print(x);', '32768'],
  ['bit ops', 'Serial.print(1 << 4); Serial.print(" "); Serial.print(0xFF & 0x0F); Serial.print(" "); Serial.print(~0); Serial.print(" "); Serial.print(5 ^ 3);', '16 15 -1 6'],
  ['map', 'Serial.print(map(512, 0, 1023, 0, 255));', '127'],
  ['constrain/abs/min/max/sq', 'Serial.print(constrain(9, 0, 5)); Serial.print(abs(-3)); Serial.print(min(4, 2)); Serial.print(max(4, 2)); Serial.print(sq(3));', '53249'],
  ['bitRead/lowByte/highByte', 'Serial.print(bitRead(5, 0)); Serial.print(" "); Serial.print(lowByte(0x1234)); Serial.print(" "); Serial.print(highByte(0x1234));', '1 52 18'],
  ['bitSet/bitClear', 'int v = 0; bitSet(v, 3); Serial.print(v); bitClear(v, 3); Serial.print(v);', '80'],
  ['String concat number', 'String s = "ab"; s += 5; Serial.print(s);', 'ab5'],
  ['String + chain', 'String s = String("a") + 1 + 2; Serial.print(s);', 'a12'],
  ['String(float, digits)', 'Serial.print(String(3.14159, 3));', '3.142'],
  ['String(int, HEX) is lowercase', 'Serial.print(String(255, HEX));', 'ff'],
  ['String(float) defaults to 2 decimals', 'Serial.print(String(1.5));', '1.50'],
  ['String methods', 'String s = "Hello"; Serial.print(s.length()); Serial.print(s.indexOf("l")); Serial.print(s.substring(1, 3)); s.toUpperCase(); Serial.print(s);', '52elHELLO'],
  ['String toInt/toFloat', 'String s = "42"; Serial.print(s.toInt() + 1); Serial.print(" "); Serial.print(String("2.5").toFloat());', '43 2.50'],
  ['String charAt/equals/trim', 'String s = "  hi "; s.trim(); Serial.print(s); Serial.print(s.charAt(1)); Serial.print(s.equals("hi"));', 'hii1'],
  ['String == compares contents', 'String a = "x"; String b = "x"; Serial.print(a == b);', '1'],
  ['switch with fallthrough', 'int n = 1; switch (n) { case 1: Serial.print("a"); case 2: Serial.print("b"); break; default: Serial.print("c"); }', 'ab'],
  ['do-while', 'int i = 0; do { Serial.print(i); i++; } while (i < 3);', '012'],
  ['for with break/continue', 'for (int i = 0; i < 10; i++) { if (i == 1) continue; if (i == 4) break; Serial.print(i); }', '023'],
  ['array partial init is zero-filled', 'int a[5] = {1, 2, 3}; Serial.print(a[3]); Serial.print(a[4]);', '00'],
  ['sizeof array', 'int a[5]; Serial.print(sizeof(a) / sizeof(a[0]));', '5'],
  ['2D array', 'int g[2][3] = {{1, 2, 3}, {4, 5, 6}}; Serial.print(g[1][2]);', '6'],
  ['#define macro', 'Serial.print(LED_COUNT * 2);', '8', '#define LED_COUNT 4'],
  ['const global', 'Serial.print(K + 1);', '6', 'const int K = 5;'],
  ['static local keeps its value', 'tick(); tick(); Serial.print(tick());', '3', 'int tick() { static int n = 0; return ++n; }'],
  ['enum', 'Serial.print(GREEN);', '1', 'enum Color { RED, GREEN, BLUE };'],
  ['ternary', 'int a = 5; Serial.print(a > 3 ? "big" : "small");', 'big'],
  ['compound assignment on int', 'int a = 10; a /= 4; Serial.print(a);', '2'],
  ['int cast of float', 'Serial.print((int)3.9);', '3'],
  ['float function return', 'Serial.print(half(5));', '2.50', 'float half(int v) { return v / 2.0; }'],
  ['char array string', 'char msg[] = "hey"; Serial.print(msg); Serial.print(strlen(msg));', 'hey3'],
  ['long literal', 'long big = 100000L * 3; Serial.print(big);', '300000'],
  ['millis is unsigned long', 'unsigned long t = millis(); Serial.print(t < 100000UL);', '1'],
  // guards for the literal-division and in-place rewrites
  ['division chain binds left', 'float x = 12; Serial.print(x / 2 / 4);', '1.50'],
  ['literal division after *', 'Serial.print(12 * 7 / 2);', '42'],
  ['float literal division untouched', 'Serial.print(1.5 / 2);', '0.75'],
  ['literal division in an index', 'int a[4] = {5, 6, 7, 8}; Serial.print(a[7 / 2]);', '8'],
  ['bitSet on an array element', 'int f[2] = {0, 0}; bitSet(f[1], 1); Serial.print(f[1]);', '2'],
  ['String.replace replaces every match', 'String s = "a-b-c"; s.replace("-", "+"); Serial.print(s);', 'a+b+c'],
  ['2D partial init', 'int g[2][3] = {{1}}; Serial.print(g[0][2]); Serial.print(g[1][1]);', '00'],
  ['int variable division', 'int a = 7, b = 2; Serial.print(a / b);', '3'],
  ['byte wraps', 'byte b = 255; b++; Serial.print(b);', '0'],
  ['uint8_t wraps', 'uint8_t b = 250; b += 10; Serial.print(b);', '4'],
  ['unsigned long wraps below 0', 'unsigned long u = 0; u--; Serial.print(u);', '4294967295'],
  ['int16_t wraps', 'int16_t s = 32767; s++; Serial.print(s);', '-32768'],
  ['int overflow wraps', 'int x = 2147483647; x++; Serial.print(x);', '-2147483648'],
  ['int from float truncates', 'int a = 3.9; Serial.print(a);', '3'],
  ['int function return truncates', 'Serial.print(half(5));', '2', 'int half(int v) { return v / 2; }'],
  ['float = int/int', 'float f = 7 / 2; Serial.print(f);', '3.00'],
  ['sqrt prints as float', 'Serial.print(sqrt(16));', '4.00'],
  ['char cast to int', "Serial.print((int)'A');", '65'],
  ['char arithmetic', "Serial.print('A' + 1);", '66'],
  ['char increment', "char c = 'A'; c++; Serial.print(c);", 'B'],
  ['struct', 'Point p; p.x = 3; p.y = 4; Serial.print(p.x + p.y);', '7', 'struct Point { int x; int y; };'],
  ['struct with initialiser', 'Point p = {3, 4}; Serial.print(p.x * p.y);', '12', 'struct Point { int x; int y; };'],
  ['struct fields default to zero', 'Point p; Serial.print(p.x); Serial.print(p.y);', '00', 'struct Point { int x; int y; };'],
  ['struct array', 'Point ps[3]; ps[2].y = 9; Serial.print(ps[2].y); Serial.print(ps[0].y);', '90', 'struct Point { int x; int y; };'],
  ['struct array initialiser', 'Point ps[2] = {{1, 2}, {3, 4}}; Serial.print(ps[1].x);', '3', 'struct Point { int x; int y; };'],
  ['typedef struct', 'Pin p = {13, true}; Serial.print(p.num); Serial.print(p.on);', '131', 'typedef struct { int num; bool on; } Pin;'],
  ['struct with String and array fields', 'Song s = {"intro"}; s.notes[1] = 5; Serial.print(s.name); Serial.print(s.notes[1]); Serial.print(s.notes[0]);', 'intro50', 'struct Song { String name; int notes[4]; };'],
  ['const char* field', 'Item it = {"pen", 3}; Serial.print(it.label); Serial.print(it.qty);', 'pen3', 'struct Item { const char* label; int qty; };'],
  ['nested struct', 'Line l = {{1, 2}, {3, 4}}; Serial.print(l.b.x);', '3', 'struct Point { int x; int y; };\nstruct Line { Point a; Point b; };'],
  ['struct passed to and returned from functions', 'Point p = make(2); Serial.print(sum(p));', '6', 'struct Point { int x; int y; };\nPoint make(int v) { Point r = {v, v * 2}; return r; }\nint sum(Point q) { return q.x + q.y; }'],
  ['struct copy on declaration', 'Point a = {1, 2}; Point b = a; b.x = 9; Serial.print(a.x);', '1', 'struct Point { int x; int y; };'],
  ['struct member through a pointer', 'Point p = {5, 6}; Point* q = &p; Serial.print(q->y);', '6', 'struct Point { int x; int y; };'],
  ['two fields on one line', 'RGB c = {1, 2, 3}; Serial.print(c.b);', '3', 'struct RGB { byte r, g, b; };'],
  ['pass by reference', 'int x = 1; inc(x); Serial.print(x);', '2', 'void inc(int &v) { v++; }'],
  ['swap by reference', 'int a = 1, b = 2; swap2(a, b); Serial.print(a); Serial.print(b);', '21', 'void swap2(int &x, int &y) { int t = x; x = y; y = t; }'],
  ['reference to an array element', 'int v[2] = {1, 1}; inc(v[1]); Serial.print(v[1]);', '2', 'void inc(int &n) { n++; }'],
  ['reference to a struct field', 'Point p = {1, 2}; inc(p.y); Serial.print(p.y);', '3', 'struct Point { int x; int y; };\nvoid inc(int &n) { n += 1; }'],
  ['struct by reference', 'Point p = {1, 2}; moveRight(p); Serial.print(p.x);', '6', 'struct Point { int x; int y; };\nvoid moveRight(Point &q) { q.x += 5; }'],
  ['const reference stays plain', 'String s = "hi"; Serial.print(twice(s));', 'hihi', 'String twice(const String &t) { return t + t; }'],
  ['reference out-parameter', 'int q, r; divmod(17, 5, q, r); Serial.print(q); Serial.print(r);', '32', 'void divmod(int a, int b, int &quo, int &rem) { quo = a / b; rem = a % b; }'],
  ['reference call inside an expression', 'int n = 1; Serial.print(bump(n) + bump(n)); Serial.print(n);', '53', 'int bump(int &x) { x++; return x; }'],
  // chars
  ['digit from a char', "char c = '7'; Serial.print(c - '0');", '7'],
  ['digit from an int holding a char', "int c = '5'; Serial.print(c - '0');", '5'],
  ['char offset', "char c = 'c'; Serial.print(c - 'a');", '2'],
  ['char + int', "char c = 'A'; Serial.print(c + 2);", '67'],
  ['char from a number', 'char c = 66; Serial.print(c);', 'B'],
  ['(char) cast', 'Serial.print((char)65); Serial.print((char)(65 + 1));', 'AB'],
  ['char += n', "char c = 'a'; c += 2; Serial.print(c);", 'c'],
  ['String += char', "String s = \"ab\"; s += 'c'; Serial.print(s);", 'abc'],
  ['String + char', "String s = \"x\"; s = s + 'y'; Serial.print(s);", 'xy'],
  ['char comparison', "char c = 'b'; Serial.print(c >= 'a' && c <= 'z');", '1'],
  ['switch on a char', "char c = 'q'; switch (c) { case 'q': Serial.print(\"Q\"); break; default: Serial.print(\"?\"); }", 'Q'],
  ['char loop', "for (char c = 'a'; c <= 'c'; c++) Serial.print(c);", 'abc'],
  ['escaped char literal', "Serial.print((int)'\\n');", '10'],
  ['charAt minus a char', 'String s = "42"; Serial.print(s.charAt(0) - \'0\');', '4'],
  // float printing
  ['whole float prints 2 decimals', 'float t = 21; Serial.println(t);', '21.00\r\n'],
  ['float param prints 2 decimals', 'show(3);', '3.00', 'void show(float v) { Serial.print(v); }'],
  ['float function result', 'Serial.print(half(4));', '2.00', 'float half(int v) { return v / 2.0; }'],
  ['float in String()', 'float t = 20; Serial.print("T=" + String(t));', 'T=20.00'],
  ['float arithmetic', 'float c = 20; Serial.print(c * 9 / 5 + 32);', '68.00'],
  ['explicit digits kept', 'float t = 21.456; Serial.print(t, 1);', '21.5'],
  ['int cast of float prints int', 'float t = 21.7; Serial.print((int)t);', '21'],
  ['comparison prints 0/1', 'float t = 21; Serial.print(t > 20);', '1'],
  ['NaN with digits prints nan', 'Serial.print(sqrt(-1), 2);', 'nan'],
  ['int var prints no decimals', 'int n = 4; Serial.print(n);', '4'],
  ['float var name reused as int elsewhere', 'Serial.print(fa());', '5', 'int fa() { int v = 5; return v; }\nfloat fb() { float v = 1; return v; }'],
  ['lcd.print of a float', 'float t = 3; Serial.print(String(t));', '3.00'],
  // guards for integer type tracking
  ['ADC to volts with a (float) cast', 'int raw = 2048; Serial.print((float)raw / 4095 * 3.3);', '1.65'],
  ['(float) cast on the left operand', 'int a = 1, b = 4; Serial.print((float)a / b);', '0.25'],
  ['(float) cast on the right operand', 'int s = 10, n = 4; Serial.print(s / (float)n);', '2.50'],
  ['(double) cast', 'int s = 10, n = 4; Serial.print((double)s / n);', '2.50'],
  ['float cast then stored in an int', 'int a = 1, b = 4; int pct = (float)a / b * 100; Serial.print(pct);', '25'],
  ['(float) cast on a literal', 'int k = 0; Serial.print((float)7 / 2);', '3.50'],
  ['float() function cast', 'int raw = 2048; Serial.print(float(raw) / 4095 * 3.3);', '1.65'],
  ['wrapping keeps values in range', 'unsigned long last = 0; unsigned long now = 5000; Serial.print(now - last >= 1000);', '1'],
  ['average with int division', 'int sum = 10, count = 4; int avg = sum / count; Serial.print(avg);', '2'],
  ['float var division stays float', 'float total = 10; int n = 4; Serial.print(total / n);', '2.50'],
  ['int param wraps', 'Serial.print(twice(5));', '10', 'int twice(int v) { v *= 2; return v; }'],
  ['same name, different types per function', 'Serial.print(fa()); Serial.print(" "); Serial.print(fb());', '2 2.50', 'int fa() { int x = 5; x = x / 2; return x; }\nfloat fb() { float x = 5; x = x / 2; return x; }'],
  ['long counter keeps counting', 'long c = 0; for (int i = 0; i < 5; i++) c += 100000; Serial.print(c);', '500000'],
  ['uint16_t wraps', 'uint16_t w = 65535; w++; Serial.print(w);', '0'],
  ['int8_t wraps', 'int8_t s = 127; s++; Serial.print(s);', '-128'],
  ['bool stays bool', 'bool on = 5; Serial.print(on);', '1'],
];

// Known gaps: the ESP32 runner is a regex transpiler to JavaScript. It tracks integer variable types, but not
// expression types (chars as numbers, float printing of whole numbers), references or structs. Each of
// these runs with it.fails, so fixing one turns it red: move it to `cases` above when that happens.
const gaps: Array<[string, string, string, string?, string?]> = [
  // JS objects are references: assigning or passing a struct by value shares it instead of copying
  ['struct assignment copies', 'Point a = {1, 2}; Point b; b = a; b.x = 9; Serial.print(a.x);', '1', 'struct Point { int x; int y; };'],
  // read() returns a 1-letter string so that c == 'a' keeps working; real Arduino returns the code (97)
  ['int from Serial.read() prints its code', 'int c = Serial.read(); Serial.print(c);', '97', '', 'a'],
  ['unsigned subtraction wraps', 'unsigned int a = 1, b = 2; Serial.print(a - b);', '4294967295'],
];

describe('Arduino compatibility', () => {
  it.each(cases)('%s', async (_name, body, expected, globals) => {
    expect(await run(body, globals)).toBe(expected);
  });
});

describe('Arduino compatibility: known gaps', () => {
  it.fails.each(gaps)('%s', async (_name, body, expected, globals, input) => {
    expect(await run(body, globals, input)).toBe(expected);
  });
});

describe('serial input in the compat harness', () => {
  it('reaches Serial.read()', async () => {
    expect(await run('char c = Serial.read(); Serial.print(c == \'a\');', '', 'a')).toBe('1');
  });
});
