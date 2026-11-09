/* Arduino Uno sketches typed in the editor: they run on the sketch runtime with Uno rules —
 * pins 0–19, 5 V logic, 10-bit ADC, PWM only on 3/5/6/9/10/11, 16-bit int, interrupts on pins 2 and 3. */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';
import { MultiRun } from '../../src/multi.ts';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uno = comp('uno', 'uno');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

function run(components: Comp[], wires: Array<[string, string]>, code: string) {
  const host = {
    project: { name: 't', code, components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[],
    log(m: string) { host.logs.push(m); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  sim.boardType = 'uno';
  sim.analog = new AnalogBridge(sim);
  sim.start(code);
  live = sim;
  return { sim, host };
}

describe('Arduino Uno sketches', () => {
  it('drives an output pin at 5 V and blinks LED_BUILTIN (pin 13)', async () => {
    const { sim, host } = run([uno, comp('r1', 'resistor', { ohms: 220 }), comp('l1', 'led')], [['uno:D9', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'uno:GND1']],
      'void setup() { pinMode(9, OUTPUT); pinMode(LED_BUILTIN, OUTPUT); digitalWrite(9, HIGH); digitalWrite(LED_BUILTIN, HIGH); }\nvoid loop() { delay(5); }');
    await wait(150); sim.touch();
    expect(host.errors).toEqual([]);
    expect(sim.out[13]).toBe(1);
    expect(sim.analog.gpioVoltage(9)).toBeGreaterThan(4.5);
    expect(sim.analog.ledBrightness().l1).toBeGreaterThan(0.6); // (5 V − ~1.9 V) / 220 Ω ≈ 14 mA
  });

  it('reads A0 with the 10-bit ADC against 5 V (analogRead(A0) and analogRead(0))', async () => {
    const { sim, host } = run([uno, comp('p1', 'pot', { value: 0.25 })], [['uno:5V', 'p1:VCC'], ['p1:GND', 'uno:GND2'], ['p1:SIG', 'uno:A0']],
      'void setup() { Serial.begin(9600); }\nvoid loop() { Serial.print(analogRead(A0)); Serial.print(" "); Serial.print(analogRead(0)); Serial.print(" "); delay(50); }');
    await wait(80);
    expect(host.errors).toEqual([]);
    const [a, b] = sim.serialOut.trim().split(' ').map(Number);
    expect(a).toBeGreaterThan(240); expect(a).toBeLessThan(270); // 25 % of 1023
    expect(b).toBe(a);
  });

  it('has 16-bit int and 32-bit long', async () => {
    const { sim, host } = run([uno], [],
      'int i = 32767;\nlong l = 32767;\nunsigned int u = 0;\nvoid setup() { Serial.begin(9600); i++; l++; u--; Serial.print(i); Serial.print(" "); Serial.print(l); Serial.print(" "); Serial.print(u); }\nvoid loop() { delay(10); }');
    await wait(40);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('-32768 32768 65535');
  });

  it('uses PWM only on PWM pins; others are switched HIGH/LOW with a warning', async () => {
    const { sim, host } = run([uno], [], 'void setup() { analogWrite(9, 64); analogWrite(7, 200); }\nvoid loop() { delay(10); }');
    await wait(40);
    expect(host.errors).toEqual([]);
    expect(sim.pwm[9]).toBeCloseTo(64 / 255, 3);
    expect(sim.ledcPin[9].freq).toBe(490);
    expect(sim.pwm[7]).toBeUndefined(); expect(sim.out[7]).toBe(1);
    expect(host.logs.some((m) => /pin 7 has no PWM/.test(m))).toBe(true);
  });

  it('a button on pin 2 fires attachInterrupt(digitalPinToInterrupt(2)) through the internal pull-up', async () => {
    const { sim, host } = run([uno, comp('b1', 'button')], [['uno:D2', 'b1:1'], ['b1:2', 'uno:GND1']],
      'volatile int n = 0;\nvoid hit() { n++; }\nvoid setup() { Serial.begin(9600); pinMode(2, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(2), hit, FALLING); }\nvoid loop() { delay(5); }');
    await wait(40);
    expect(sim.readPin(2)).toBe(1);
    expect(sim.analog.gpioVoltage(2)).toBeCloseTo(5, 1);
    sim.setPressed('b1', true); sim.pollInterrupts();
    expect(sim.readPin(2)).toBe(0);
    expect(host.errors).toEqual([]);
    expect(sim.interrupts[0].pin).toBe(2);
  });

  it('refuses pins and features the Uno does not have', async () => {
    const { host } = run([uno], [], 'void setup() { pinMode(25, OUTPUT); attachInterrupt(digitalPinToInterrupt(7), setup, RISING); }\nvoid loop() { delay(10); }');
    await wait(30);
    expect(host.logs.some((m) => /Pin 25 does not exist on the Arduino Uno/.test(m))).toBe(true);
    expect(host.logs.some((m) => /only on pins 2 and 3/.test(m))).toBe(true);
    const w = run([uno], [], 'void setup() { WiFi.begin("x", "y"); }\nvoid loop() { delay(10); }');
    await wait(30);
    expect(String(w.host.errors[0])).toMatch(/WiFi is ESP32-only/);
  });

  it('drives an I2C LCD wired to the SDA/SCL header (the same pins as A4/A5)', async () => {
    const { sim, host } = run([uno, comp('lcd1', 'lcd')], [['uno:5V', 'lcd1:VCC'], ['lcd1:GND', 'uno:GND1'], ['uno:SDA', 'lcd1:SDA'], ['uno:SCL', 'lcd1:SCL']],
      'LiquidCrystal_I2C lcd(0x27, 16, 2);\nvoid setup() { lcd.init(); lcd.backlight(); lcd.setCursor(0, 0); lcd.print("Hello Uno"); }\nvoid loop() { delay(10); }');
    await wait(60);
    expect(host.errors).toEqual([]);
    expect(sim.i2c).toEqual({ sda: 18, scl: 19 });
    expect(sim.pinGpios(comp('lcd1', 'lcd'), 'SDA')).toContain(18);
    expect(sim.lcd.buf[0].join('')).toMatch(/^Hello Uno/);
    const st = DEFS.lcd.state!(comp('lcd1', 'lcd'), sim);
    expect(st).toMatchObject({ wired: true, powered: true });
  });

  it('runs next to an ESP32 in one circuit: the Uno sketch reads a pin the ESP32 drives', async () => {
    const esp = comp('esp', 'esp32');
    const host = {
      project: { name: 't', code: '', components: [esp, uno], wires: [{ id: 'w0', from: 'esp:D4', to: 'uno:D7' }, { id: 'w1', from: 'esp:GND.L', to: 'uno:GND1' }] },
      logs: [] as string[], errors: [] as unknown[],
      log(m: string) { host.logs.push(m); }, reportError(e: unknown) { host.errors.push(e); },
    };
    const m = new MultiRun(host);
    m.start([
      { id: 'esp', type: 'esp32', code: 'void setup() { pinMode(4, OUTPUT); digitalWrite(4, HIGH); }\nvoid loop() { delay(10); }' },
      { id: 'uno', type: 'uno', code: 'void setup() { Serial.begin(9600); pinMode(7, INPUT); }\nvoid loop() { Serial.print(digitalRead(7)); delay(20); }' },
    ]);
    try {
      await wait(80); m.touch();
      expect(host.errors).toEqual([]);
      const st = m.boardStates();
      expect(st.uno.type).toBe('uno');
      expect(String(st.uno.serial)).toMatch(/^1+$/); // 3.3 V is above the ATmega's 3.0 V threshold
    } finally { m.stop(); }
  });
});
