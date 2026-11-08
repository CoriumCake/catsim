import { describe, expect, it } from 'vitest';
import { transpile } from '../../src/transpiler.js';
import { EXAMPLES } from '../../src/examples.js';

// Compile the transpiled sketch the same way the runtime does (syntax check only).
const compile = (js: string) => new Function('__api', `"use strict"; return (async function(){ { ${js}\n;return 1; } })();`);

describe('transpiler', () => {
  for (const ex of EXAMPLES.filter((e) => !('firmware' in e))) { // Uno examples run compiled firmware instead
    it(`example "${ex.key}" transpiles to valid JavaScript`, () => {
      const { js, functions } = transpile(ex.code);
      for (const pr of Object.values((ex as { programs?: Record<string, { code?: string }> }).programs || {})) if (pr.code) expect(() => compile(transpile(pr.code).js)).not.toThrow();
      expect(functions).toContain('setup');
      expect(functions).toContain('loop');
      expect(() => compile(js)).not.toThrow();
    });
  }

  it('awaits delay() and user functions', () => {
    const { js } = transpile('void blink(int n) { delay(n); }\nvoid setup() {}\nvoid loop() { blink(5); }');
    expect(js).toMatch(/async function blink\(n\)/);
    expect(js).toMatch(/await delay\(n\)/);
    expect(js).toMatch(/await blink\(5\)/);
  });

  it('keeps static locals between calls', async () => {
    const { js } = transpile('int tick() { static int n = 0; n++; return n; }\nvoid setup() {}\nvoid loop() {}');
    const run = new Function('__i32', `return (async () => { ${js}\n; await tick(); await tick(); return await tick(); })();`);
    expect(await run((v: number) => v | 0)).toBe(3);
  });

  it('truncates integer division for int variables', async () => {
    const { js } = transpile('int half() { int x = 7 / 2; return x; }\nvoid setup() {}\nvoid loop() {}');
    const run = new Function('__i32', `return (async () => { ${js}\n; return await half(); })();`);
    expect(await run((v: number) => Math.trunc(v) | 0)).toBe(3);
  });

  it('converts arrays, enums and #define', () => {
    const { js } = transpile('#define LED 2\nint pins[] = {1, 2, 3};\nenum Mode { A, B = 5, C };\nvoid setup() {}\nvoid loop() {}');
    expect(js).toMatch(/const LED = 2;/);
    expect(js).toMatch(/let pins = \[1, 2, 3\];/);
    expect(js).toMatch(/const A = 0, B = 5, C = 6;/);
    expect(() => compile(js)).not.toThrow();
  });

  it('reports unsupported C++ with a line number', () => {
    expect(() => transpile('void setup() {}\nstruct P { int x; };\nvoid loop() {}')).toThrow(expect.objectContaining({ line: 2 }));
  });

  it('keeps line numbers aligned with the source', () => {
    const src = '// a\n// b\nvoid setup() {\n  int x = 1;\n}\nvoid loop() {}';
    expect(transpile(src).js.split('\n').length).toBe(src.split('\n').length);
  });
});

describe('strict-mode compatibility', () => {
  it('turns C octal literals into 0o form without touching decimals or hex', () => {
    const { js } = transpile('int a = 010; float b = 0.5; int c = 0x1F; int d = 0; int e = 100;\nvoid setup() {}\nvoid loop() {}');
    expect(js).toMatch(/let a = 0o10;/);
    expect(js).toMatch(/let b = 0\.5;/);
    expect(js).toMatch(/let c = 0x1F;/);
    expect(js).toMatch(/let d = 0;/);
    expect(js).toMatch(/let e = 100;/);
    expect(() => compile(js)).not.toThrow();
  });
  it('maps yield() to the runtime yield', () => {
    const { js } = transpile('void setup() {}\nvoid loop() { yield(); }');
    expect(js).toMatch(/await __y\(\)/);
    expect(() => compile(js)).not.toThrow();
  });
});
