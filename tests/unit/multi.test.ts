import { afterEach, describe, expect, it } from 'vitest';
import { MultiRun } from '../../src/multi.ts';
import { DEFS } from '../../src/components.js';
import buttonHex from '../../src/firmware/uno-button.hex?raw';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let live: MultiRun | null = null;
afterEach(() => { live?.stop(); live = null; });

function setup(components: Comp[], wires: Array<[string, string]>) {
  const host = {
    project: { name: 't', code: '', components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[], pubs: [] as unknown[],
    log(m: string, _l?: string, _line?: number, board?: string) { host.logs.push(board ? `[${board}] ${m}` : m); },
    reportError(e: unknown, board: string) { host.errors.push([board, e]); },
    onPublish(m: unknown) { host.pubs.push(m); },
  };
  const multi = new MultiRun(host);
  live = multi;
  return { multi, host };
}
async function until(m: MultiRun, cond: () => boolean, timeout = 4000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > timeout) throw new Error('condition not reached'); await wait(20); m.touch(); }
}

describe('several boards in one circuit', () => {
  it('ESP32 → wire → ESP32: a button on one board lights an LED driven by the other', async () => {
    const { multi, host } = setup([comp('esp', 'esp32'), comp('esp2', 'esp32'), comp('b1', 'button'), comp('r1', 'resistor', { ohms: 220 }), comp('l1', 'led')], [
      ['esp:D15', 'b1:1'], ['b1:2', 'esp:GND.R'],
      ['esp:D23', 'esp2:D34'],                       // board-to-board signal
      ['esp2:D2', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'esp2:GND.R'],
    ]);
    expect(multi.start([
      { id: 'esp', type: 'esp32', code: 'void setup() { pinMode(15, INPUT_PULLUP); pinMode(23, OUTPUT); }\nvoid loop() { digitalWrite(23, digitalRead(15) == LOW ? HIGH : LOW); delay(5); }' },
      { id: 'esp2', type: 'esp32', code: 'void setup() { Serial.begin(9600); pinMode(34, INPUT); pinMode(2, OUTPUT); Serial.println("esp2 ready"); }\nvoid loop() { digitalWrite(2, digitalRead(34)); delay(5); }' },
    ])).toBe(true);
    await until(multi, () => multi.clock.millis() > 60);
    expect(host.errors).toEqual([]);
    expect(multi.bridge.ledBrightness().l1).toBeLessThan(0.05);
    multi.setPressed('b1', true);
    await until(multi, () => multi.bridge.ledBrightness().l1 > 0.5);
    const st = multi.boardStates();
    expect(st.esp2.serial).toContain('esp2 ready'); // each board has its own serial port
    expect(st.esp.serial).toBe('');
    multi.setPressed('b1', false);
    await until(multi, () => multi.bridge.ledBrightness().l1 < 0.05);
  });

  it('ESP32 drives a pin that real Uno firmware reads', async () => {
    const { multi, host } = setup([comp('esp', 'esp32'), comp('uno', 'uno'), comp('r1', 'resistor', { ohms: 220 }), comp('l1', 'led')], [
      ['esp:D23', 'uno:D2'],                         // the Uno's "button" input, driven by the ESP32
      ['uno:D9', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'uno:GND1'],
    ]);
    // uno-button.hex: INPUT_PULLUP on D2, LED on D9 when D2 is LOW
    multi.start([
      { id: 'esp', type: 'esp32', code: 'void setup() { pinMode(23, OUTPUT); }\nvoid loop() { digitalWrite(23, HIGH); delay(150); digitalWrite(23, LOW); delay(150); }' },
      { id: 'uno', type: 'uno', firmware: buttonHex },
    ]);
    await until(multi, () => multi.bridge.ledBrightness().l1 > 0.5, 5000); // ESP pulls D2 low → Uno lights the LED
    await until(multi, () => multi.bridge.ledBrightness().l1 < 0.05, 5000);
    expect(host.errors).toEqual([]);
  });

  it('two ESP32s talk over the built-in MQTT broker', async () => {
    const { multi, host } = setup([comp('esp', 'esp32'), comp('esp2', 'esp32')], []);
    const client = (id: string, body: string) => `#include <WiFi.h>
#include <PubSubClient.h>
WiFiClient net; PubSubClient mqtt(net);
String got = "";
void onMsg(char* topic, byte* payload, unsigned int len) { got = ""; for (int i = 0; i < len; i++) got += (char)payload[i]; Serial.println("got " + got); }
void setup() { Serial.begin(9600); WiFi.begin("lab", ""); while (WiFi.status() != WL_CONNECTED) delay(50);
  mqtt.setServer("broker", 1883); mqtt.setCallback(onMsg); mqtt.connect("${id}"); mqtt.subscribe("lab/#"); }
void loop() { mqtt.loop(); ${body} delay(50); }`;
    multi.start([
      { id: 'esp', type: 'esp32', code: client('sender', 'static int n = 0; if (++n == 5) mqtt.publish("lab/hello", "hi from esp");') },
      { id: 'esp2', type: 'esp32', code: client('receiver', '') },
    ], 4);
    let esp2Serial = ''; // boardStates() hands out new serial output once
    await until(multi, () => { esp2Serial += String(multi.boardStates().esp2?.serial ?? ''); return /got hi from esp/.test(esp2Serial); }, 12_000)
      .catch(() => { throw new Error(`no delivery; logs: ${host.logs.join(' | ')}`); });
    expect(host.pubs.length).toBeGreaterThan(0);
  }, 20_000); // the delivery wait above is 12 s; vitest's 5 s default cut it short under load
});
