/* Arduino-compatibility checks: each sketch prints something in setup(), and the expected text is
 * what the same sketch prints on a real ESP32 with the Arduino core (int = 32 bit, Serial line ends \r\n). */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { DEFS } from '../../src/components.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

async function run(body: string, globals = '') {
  const host = {
    project: { name: 't', code: '', components: [{ id: 'esp', type: 'esp32', x: 0, y: 0, props: { ...DEFS.esp32.props } }], wires: [] },
    logs: [] as Array<[string, string]>, errors: [] as unknown[],
    log(msg: string, level = 'info') { host.logs.push([level, msg]); },
    reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim = new Simulator(host) as any; live = sim;
  const ok = await Promise.race([
    sim.start(`${globals}\nvoid setup() {\n${body}\n}\nvoid loop() { delay(1000); }`),
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
];

// Known gaps: the ESP32 runner is a regex transpiler to JavaScript, so types are not tracked. Each of
// these runs with it.fails, so fixing one turns it red: move it to `cases` above when that happens.
const gaps: Array<[string, string, string, string?]> = [
  ['println ends with CRLF', 'Serial.println(1);', '1\r\n'],
  ['char cast to int', "Serial.print((int)'A');", '65'],
  ['char arithmetic', "Serial.print('A' + 1);", '66'],
  ['char increment', "char c = 'A'; c++; Serial.print(c);", 'B'],
  ['int variable division', 'int a = 7, b = 2; Serial.print(a / b);', '3'],
  ['float = int/int', 'float f = 7 / 2; Serial.print(f);', '3.00'],
  ['byte wraps', 'byte b = 255; b++; Serial.print(b);', '0'],
  ['uint8_t wraps', 'uint8_t b = 250; b += 10; Serial.print(b);', '4'],
  ['unsigned long wraps below 0', 'unsigned long u = 0; u--; Serial.print(u);', '4294967295'],
  ['int16_t wraps', 'int16_t s = 32767; s++; Serial.print(s);', '-32768'],
  ['int overflow wraps', 'int x = 2147483647; x++; Serial.print(x);', '-2147483648'],
  ['sqrt prints as float', 'Serial.print(sqrt(16));', '4.00'],
  ['pass by reference', 'int x = 1; inc(x); Serial.print(x);', '2', 'void inc(int &v) { v++; }'],
  ['struct', 'Point p; p.x = 3; p.y = 4; Serial.print(p.x + p.y);', '7', 'struct Point { int x; int y; };'],
  ['int from float truncates', 'int a = 3.9; Serial.print(a);', '3'],
  ['int function return truncates', 'Serial.print(half(5));', '2', 'int half(int v) { return v / 2; }'],
  ['unsigned subtraction wraps', 'unsigned int a = 1, b = 2; Serial.print(a - b);', '4294967295'],
];

describe('Arduino compatibility', () => {
  it.each(cases)('%s', async (_name, body, expected, globals) => {
    expect(await run(body, globals)).toBe(expected);
  });
});

describe('Arduino compatibility: known gaps', () => {
  it.fails.each(gaps)('%s', async (_name, body, expected, globals) => {
    expect(await run(body, globals)).toBe(expected);
  });
});
