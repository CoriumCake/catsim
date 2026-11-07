import { afterEach, describe, expect, it } from 'vitest';
import { UnoRunner } from '../../src/avr/uno.ts';
import { parseIntelHex, HexError } from '../../src/avr/hex.ts';
import { DEFS } from '../../src/components.js';
import blinkHex from '../../src/firmware/uno-blink.hex?raw';
import buttonHex from '../../src/firmware/uno-button.hex?raw';
import potHex from '../../src/firmware/uno-pot.hex?raw';
import fadeHex from '../../src/firmware/uno-fade.hex?raw';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Emulation may run below real time on a loaded machine: wait for a condition, not a fixed time. */
async function until(u: UnoRunner, cond: () => boolean, timeout = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > timeout) throw new Error('condition not reached'); await wait(20); u.touch(); }
}
let live: UnoRunner | null = null;
afterEach(() => { live?.stop(true); live = null; });

function run(components: Comp[], wires: Array<[string, string]>, hex: string) {
  const host = {
    project: { name: 't', code: '', components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[],
    log(m: string) { host.logs.push(m); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  const u = new UnoRunner(host);
  expect(u.start(hex)).toBe(true);
  live = u;
  return { u, host };
}
const uno = comp('uno', 'uno');
const ledOn9 = (color = 'red'): [Comp[], Array<[string, string]>] => [
  [comp('r1', 'resistor', { ohms: 220 }), comp('l1', 'led', { color })],
  [['uno:D9', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'uno:GND1']],
];

describe('Intel HEX', () => {
  it('parses real firmware into flash', () => {
    const f = parseIntelHex(blinkHex);
    expect(f.length).toBe(32768);
    expect(f[0]).toBe(0x0c); // jmp to the reset handler (0x940C, little-endian)
    expect(f[1]).toBe(0x94);
  });
  it('rejects corrupted or oversized files', () => {
    const bad = blinkHex.replace(/^(:10.{36})../m, '$1FF');
    expect(() => parseIntelHex(bad)).toThrow(HexError);
    expect(() => parseIntelHex(':02800000AAAA' + 'D4' + '\n:00000001FF')).toThrow(/outside|checksum/);
    expect(() => parseIntelHex('hello')).toThrow(/Intel HEX/);
    expect(() => parseIntelHex(':00000001FF')).toThrow(/no program data/);
    expect(() => parseIntelHex('x'.repeat(300_000))).toThrow(/too large/);
  });
});

describe('Arduino Uno firmware', () => {
  it('runs Blink: serial output, on-board LED and an external LED on pin 9', async () => {
    const [parts, wires] = ledOn9();
    const { u, host } = run([uno, ...parts], wires, blinkHex);
    await until(u, () => u.millis() > 150);
    expect(host.errors).toEqual([]);
    expect(u.serialOut).toContain('Uno blink started');
    expect(u.serialOut).toContain('tick');
    expect(u.out[13]).toBe(1); // first half-second: L on, pin 9 low
    expect(u.analog.ledBrightness().l1).toBeLessThan(0.05);
    await until(u, () => u.millis() > 650);
    expect(u.serialOut).toContain('tock');
    expect(u.analog.ledBrightness().l1).toBeGreaterThan(0.5); // ~11 mA through 220 Ω from 5 V
  });

  it('keeps simulated time in step with the CPU clock (millis() from Timer0)', async () => {
    const { u } = run([uno], [], blinkHex);
    await until(u, () => u.millis() > 1100);
    // two delay(500) per line pair: millis() from Timer0 must agree with the CPU cycle count
    expect((u.serialOut.match(/tick|tock/g) || []).length).toBe(3);
  });

  it('reads a button through INPUT_PULLUP', async () => {
    const [parts, wires] = ledOn9();
    const { u } = run([uno, comp('b1', 'button'), ...parts], [...wires, ['uno:D2', 'b1:1'], ['b1:2', 'uno:GND2']], buttonHex);
    await until(u, () => u.millis() > 80);
    expect(u.analog.ledBrightness().l1).toBeLessThan(0.05);
    u.setPressed('b1', true);
    const t = u.millis(); await until(u, () => u.millis() > t + 120);
    expect(u.serialOut).toContain('pressed');
    expect(u.analog.ledBrightness().l1).toBeGreaterThan(0.5);
  });

  it('reads the pot with the 10-bit ADC and dims pin 9 with hardware PWM', async () => {
    const [parts, wires] = ledOn9();
    const { u } = run([uno, comp('p1', 'pot', { value: 0.25 }), ...parts],
      [...wires, ['uno:5V', 'p1:VCC'], ['p1:GND', 'uno:GND3'], ['p1:SIG', 'uno:A0']], potHex);
    u.analog.setProbes(['uno:D9'], 2e-5);
    await until(u, () => u.millis() > 400);
    const m = /A0 = (\d+)/.exec(u.serialOut);
    expect(m).not.toBeNull();
    expect(+m![1]).toBeGreaterThan(245); expect(+m![1]).toBeLessThan(262); // 25 % of 1023
    // pin 9 is a real ~490 Hz PWM signal from Timer1
    const s = u.analog.takeSamples()!;
    const t = Array.from(s.t), v = Array.from(s.v[0]);
    const rises: number[] = [];
    for (let i = 1; i < t.length; i++) if (v[i - 1] < 2.5 && v[i] >= 2.5) rises.push(t[i]);
    const f = (rises.length - 1) / (rises[rises.length - 1] - rises[0]);
    expect(f).toBeGreaterThan(470); expect(f).toBeLessThan(510);
  });

  it('fades with analogWrite (duty cycle changes over time)', async () => {
    const [parts, wires] = ledOn9();
    const { u } = run([uno, ...parts], wires, fadeHex);
    const seen = new Set<number>();
    for (let i = 1; i <= 6; i++) { await until(u, () => u.millis() > i * 120); seen.add(Math.round(u.analog.ledBrightness().l1 * 10)); }
    expect(seen.size).toBeGreaterThan(2);
  });

  it('refuses invalid firmware with a helpful message', () => {
    const host = { project: { name: '', code: '', components: [uno], wires: [] }, logs: [] as string[], log(m: string) { host.logs.push(m); }, reportError() {}, iotChanged() {}, onSimState() {}, restartSim() {} };
    const u = new UnoRunner(host);
    expect(u.start('not a hex file')).toBe(false);
    expect(host.logs[0]).toMatch(/Firmware error.*Export Compiled Binary/);
  });
});
