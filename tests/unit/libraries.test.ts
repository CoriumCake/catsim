/* The built-in Arduino libraries, driven by real sketches through the transpiler and runtime. */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulator } from '../../src/runtime.js';
import { AnalogBridge } from '../../src/analog/bridge.ts';
import { DEFS } from '../../src/components.js';
import { oledPath } from '../../src/parts-libs.js';

type Comp = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const comp = (id: string, type: string, props = {}): Comp => ({ id, type, x: 0, y: 0, props: { ...DEFS[type].props, ...props } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esp = comp('esp', 'esp32');
const uno = comp('uno', 'uno');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let live: any = null;
afterEach(() => { live?.stop(true); live = null; });

function run(components: Comp[], wires: Array<[string, string]>, code: string, opts: { board?: string; nv?: object; speed?: number } = {}) {
  const host = {
    project: { name: 't', code, components, wires: wires.map(([from, to], i) => ({ id: 'w' + i, from, to })) },
    logs: [] as string[], errors: [] as unknown[], nv: null as unknown,
    log(m: string) { host.logs.push(m); }, reportError(e: unknown) { host.errors.push(e); },
    iotChanged() {}, onSimState() {}, restartSim() {}, nvChanged(nv: unknown) { host.nv = structuredClone(nv); },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = new Simulator(host);
  if (opts.board) sim.boardType = opts.board;
  if (opts.nv) sim.nv = opts.nv;
  sim.analog = new AnalogBridge(sim);
  if (opts.speed) sim.setSpeed(opts.speed);
  sim.start(code);
  live = sim;
  return { sim, host };
}
const until = async (cond: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); } };
const pixel = (d: { buf: Uint8Array; w: number }, x: number, y: number) => !!(d.buf[x + (y >> 3) * d.w] & (1 << (y & 7)));

describe('Adafruit_SSD1306 + Adafruit_GFX', () => {
  const wires: Array<[string, string]> = [['esp:3V3', 'oled1:VCC'], ['oled1:GND', 'esp:GND.R'], ['esp:D21', 'oled1:SDA'], ['esp:D22', 'oled1:SCL']];
  it('draws text, shapes and pixels into the OLED buffer', async () => {
    const { sim, host } = run([esp, comp('oled1', 'oled')], wires, `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
void setup() {
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { for (;;); }
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE); display.setCursor(0, 0);
  display.println(F("Hi"));
  display.drawRect(100, 40, 20, 10, SSD1306_WHITE);
  display.fillCircle(64, 50, 5, SSD1306_WHITE);
  display.drawPixel(127, 63, SSD1306_WHITE);
  display.display();
}
void loop() { delay(10); }`);
    await until(() => !!sim.dev.oled1);
    expect(host.errors).toEqual([]);
    const d = sim.dev.oled1;
    expect(d).toMatchObject({ kind: 'oled', w: 128, h: 64, on: true });
    // 'H' in the 5×7 font: column 0 is 0x7F (rows 0–6 lit), column 1 is 0x08 (only row 3)
    expect([0, 1, 2, 3, 4, 5, 6].every((y) => pixel(d, 0, y))).toBe(true);
    expect(pixel(d, 1, 3)).toBe(true); expect(pixel(d, 1, 0)).toBe(false);
    expect(pixel(d, 100, 40)).toBe(true); expect(pixel(d, 110, 45)).toBe(false); // rectangle outline, hollow
    expect(pixel(d, 64, 50)).toBe(true); expect(pixel(d, 127, 63)).toBe(true);
    expect(oledPath(d).length).toBeGreaterThan(50);
    expect(DEFS.oled.state!(comp('oled1', 'oled'), sim).d).toBe(d);
  });
  it('warns (instead of failing) when no OLED is on the I2C bus, like the real library', async () => {
    const { sim, host } = run([esp], [], 'Adafruit_SSD1306 display(128, 64, &Wire, -1);\nvoid setup() { Serial.begin(9600); Serial.print(display.begin(SSD1306_SWITCHCAPVCC, 0x3C)); display.display(); }\nvoid loop() { delay(10); }');
    await wait(40);
    expect(sim.serialOut).toBe('1');
    expect(host.logs.some((m) => /no OLED with address 0x3C/.test(m))).toBe(true);
  });
  it('getTextBounds fills its out-parameters', async () => {
    const { sim, host } = run([esp, comp('oled1', 'oled')], wires, `Adafruit_SSD1306 display(128, 64, &Wire, -1);
int16_t x1, y1; uint16_t w, h;
void setup() { Serial.begin(9600); display.begin(SSD1306_SWITCHCAPVCC, 0x3C); display.setTextSize(2);
  display.getTextBounds("Hello", 0, 0, &x1, &y1, &w, &h); Serial.print(w); Serial.print("x"); Serial.print(h); }
void loop() { delay(10); }`);
    await wait(40);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('60x16');
  });
});

describe('NeoPixel and FastLED', () => {
  const wires: Array<[string, string]> = [['esp:VIN', 'strip1:VCC'], ['strip1:GND', 'esp:GND.L'], ['esp:D5', 'strip1:DIN']];
  it('Adafruit_NeoPixel with NEO_GRB shows the colors the sketch asked for', async () => {
    const { sim, host } = run([esp, comp('strip1', 'ws2812_strip')], wires, `#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel strip(8, 5, NEO_GRB + NEO_KHZ800);
void setup() { strip.begin(); strip.setPixelColor(0, strip.Color(255, 0, 0)); strip.setPixelColor(1, 0, 0, 255); strip.fill(strip.Color(0, 255, 0), 6, 2); strip.show(); }
void loop() { delay(10); }`);
    await until(() => !!sim.dev.strip1);
    expect(host.errors).toEqual([]);
    expect(sim.dev.strip1.rgb.slice(0, 3)).toEqual([0xff0000, 0x0000ff, 0]);
    expect(sim.dev.strip1.rgb.slice(6)).toEqual([0x00ff00, 0x00ff00]);
  });
  it('the wrong color order swaps red and green, as on a real WS2812B', async () => {
    const { sim } = run([esp, comp('strip1', 'ws2812_strip')], wires, `Adafruit_NeoPixel strip(8, 5, NEO_RGB + NEO_KHZ800);
void setup() { strip.begin(); strip.setPixelColor(0, 255, 0, 0); strip.show(); }
void loop() { delay(10); }`);
    await until(() => !!sim.dev.strip1);
    expect(sim.dev.strip1.rgb[0]).toBe(0x00ff00);
  });
  it('FastLED: CRGB array, named colors, CHSV, fill_solid, brightness', async () => {
    const { sim, host } = run([esp, comp('strip1', 'ws2812_strip')], wires, `#include <FastLED.h>
#define NUM_LEDS 8
#define DATA_PIN 5
CRGB leds[NUM_LEDS];
void setup() {
  FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS);
  fill_solid(leds, NUM_LEDS, CRGB::Black);
  leds[0] = CRGB::Red; leds[1] = CRGB(0, 0, 255); leds[2] = CHSV(0, 255, 255); leds[3].setRGB(1, 2, 3);
  leds[4] = 0x00FF00; leds[4].g = 128;
  FastLED.show();
}
void loop() { delay(10); }`);
    await until(() => !!sim.dev.strip1);
    expect(host.errors).toEqual([]);
    const [a, b, c, d, e] = sim.dev.strip1.rgb;
    expect([a, b, c, d, e]).toEqual([0xff0000, 0x0000ff, 0xff0000, 0x010203, 0x008000]);
    expect(sim.dev.strip1.rgb[7]).toBe(0);
  });
  it('FastLED.setBrightness scales the output and EVERY_N_MILLISECONDS runs a block periodically', async () => {
    const { sim, host } = run([esp, comp('strip1', 'ws2812_strip')], wires, `CRGB leds[8];
int n = 0;
void setup() { Serial.begin(9600); FastLED.addLeds<NEOPIXEL, 5>(leds, 8); FastLED.setBrightness(127); leds[0] = CRGB::White; FastLED.show(); }
void loop() { EVERY_N_MILLISECONDS(20) { n++; } if (n == 3) { Serial.print("three"); n++; } delay(1); }`);
    await until(() => sim.serialOut === 'three');
    expect(host.errors).toEqual([]);
    expect(sim.dev.strip1.rgb[0]).toBe(0x7f7f7f);
  });
});

describe('TM1637Display', () => {
  const wires: Array<[string, string]> = [['esp:3V3', 'disp1:VCC'], ['disp1:GND', 'esp:GND.R'], ['esp:D18', 'disp1:CLK'], ['esp:D19', 'disp1:DIO']];
  const S = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
  it('shows numbers, the colon and raw segments', async () => {
    const { sim, host } = run([esp, comp('disp1', 'tm1637')], wires, `#include <TM1637Display.h>
TM1637Display display(18, 19);
const uint8_t DONE[] = { SEG_B | SEG_C | SEG_D | SEG_E | SEG_G, SEG_A | SEG_B | SEG_C | SEG_D | SEG_E | SEG_F, SEG_C | SEG_E | SEG_G, SEG_A | SEG_D | SEG_E | SEG_F | SEG_G };
int step = 0;
void setup() { Serial.begin(9600); display.setBrightness(5); }
void loop() {
  if (step == 0) display.showNumberDec(42);
  if (step == 1) display.showNumberDecEx(1234, 0b01000000, true);
  if (step == 2) display.showNumberDec(-7);
  if (step == 3) display.setSegments(DONE);
  Serial.print(step); step++; delay(30);
}`);
    await until(() => sim.serialOut.includes('0'));
    expect(sim.dev.disp1.segs).toEqual([0, 0, S[4], S[2]]);
    await until(() => sim.serialOut.includes('1'));
    expect(sim.dev.disp1.segs).toEqual([S[1], S[2] | 0x80, S[3], S[4]]);
    await until(() => sim.serialOut.includes('2'));
    expect(sim.dev.disp1.segs).toEqual([0, 0, 0x40, S[7]]);
    await until(() => sim.serialOut.includes('3'));
    expect(sim.dev.disp1.segs).toEqual([0x5e, 0x3f, 0x54, 0x79]); // d O n E
    expect(sim.dev.disp1.bright).toBe(5);
    expect(host.errors).toEqual([]);
  });
});

describe('OneWire + DallasTemperature', () => {
  const wires: Array<[string, string]> = [['esp:3V3', 't1:VDD'], ['t1:GND', 'esp:GND.R'], ['esp:D4', 't1:DQ'], ['esp:D4', 'r1:1'], ['r1:2', 'esp:3V3']];
  it('reads the DS18B20 on the bus (with 12-bit rounding and the 750 ms conversion)', async () => {
    const { sim, host } = run([esp, comp('t1', 'ds18b20', { temp: 21.3 }), comp('r1', 'resistor', { ohms: 4700 })], wires, `#include <OneWire.h>
#include <DallasTemperature.h>
OneWire oneWire(4);
DallasTemperature sensors(&oneWire);
DeviceAddress addr;
void setup() { Serial.begin(9600); sensors.begin(); Serial.print(sensors.getDeviceCount()); Serial.print(" ");
  Serial.print(sensors.getAddress(addr, 0)); Serial.print(" "); Serial.print(addr[0], HEX); Serial.print(" ");
  unsigned long t0 = millis(); sensors.requestTemperatures(); Serial.print(millis() - t0 >= 750); Serial.print(" ");
  Serial.print(sensors.getTempCByIndex(0)); Serial.print(" "); Serial.print(sensors.getTempC(addr)); Serial.print(" "); Serial.print(sensors.getTempCByIndex(1)); }
void loop() { delay(10); }`, { speed: 20 });
    await until(() => sim.serialOut.split(' ').length >= 7);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('1 1 28 1 21.31 21.31 -127.00'); // DEVICE_DISCONNECTED_C for a sensor that isn't there
    expect(host.logs.some((m) => /pull-up/.test(m))).toBe(false);
  });
  it('warns when the bus has no pull-up resistor', async () => {
    const { host } = run([esp, comp('t1', 'ds18b20')], [['esp:3V3', 't1:VDD'], ['t1:GND', 'esp:GND.R'], ['esp:D4', 't1:DQ']],
      'OneWire ow(4);\nDallasTemperature s(&ow);\nvoid setup() { s.begin(); s.getDeviceCount(); }\nvoid loop() { delay(10); }');
    await wait(40);
    expect(host.logs.some((m) => /no pull-up resistor/.test(m))).toBe(true);
  });
});

describe('HC-SR04', () => {
  const wires: Array<[string, string]> = [['esp:VIN', 's1:VCC'], ['s1:GND', 'esp:GND.R'], ['esp:D5', 's1:TRIG'], ['esp:D18', 's1:ECHO']];
  it('NewPing reports the distance', async () => {
    const { sim, host } = run([esp, comp('s1', 'hcsr04', { distance: 120 })], wires, `#include <NewPing.h>
NewPing sonar(5, 18, 200);
void setup() { Serial.begin(9600); Serial.print(sonar.ping_cm()); Serial.print(" "); Serial.print(sonar.ping()); }
void loop() { delay(10); }`);
    await wait(40);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe(`${Math.round(Math.round(120 * 58.3) / 57)} ${Math.round(120 * 58.3)}`);
  });
  it('pulseIn measures the echo after a trigger pulse (the classic sketch)', async () => {
    const { sim, host } = run([esp, comp('s1', 'hcsr04', { distance: 50 })], wires, `const int trigPin = 5, echoPin = 18;
void setup() { Serial.begin(9600); pinMode(trigPin, OUTPUT); pinMode(echoPin, INPUT); }
void loop() {
  digitalWrite(trigPin, LOW); delayMicroseconds(2); digitalWrite(trigPin, HIGH); delayMicroseconds(10); digitalWrite(trigPin, LOW);
  long duration = pulseIn(echoPin, HIGH);
  float distance = duration * 0.034 / 2;
  Serial.println(distance); delay(100);
}`);
    await until(() => sim.serialOut.includes('\n'));
    expect(host.errors).toEqual([]);
    expect(parseFloat(sim.serialOut)).toBeCloseTo(50, 0);
  });
});

describe('RTClib', () => {
  const wires: Array<[string, string]> = [['esp:3V3', 'rtc1:VCC'], ['rtc1:GND', 'esp:GND.R'], ['esp:D21', 'rtc1:SDA'], ['esp:D22', 'rtc1:SCL']];
  it('reads the time, adjusts it, and keeps the setting across restarts', async () => {
    const code = `#include <RTClib.h>
RTC_DS3231 rtc;
void setup() { Serial.begin(9600); if (!rtc.begin()) { Serial.print("no rtc"); return; }
  if (rtc.now().year() != 2030) rtc.adjust(DateTime(2030, 1, 2, 3, 4, 5));
  DateTime now = rtc.now();
  DateTime later = now + TimeSpan(1, 2, 0, 0);
  Serial.print(now.timestamp()); Serial.print(" "); Serial.print(later.day()); Serial.print(" "); Serial.print(later.hour()); Serial.print(" "); Serial.print(now.dayOfTheWeek());
  char buf[] = "DD/MM/YYYY"; Serial.print(" "); Serial.print(now.toString(buf)); }
void loop() { delay(10); }`;
    const first = run([esp, comp('rtc1', 'ds3231')], wires, code);
    await until(() => first.sim.serialOut.length > 20);
    expect(first.host.errors).toEqual([]);
    expect(first.sim.serialOut).toBe('2030-01-02T03:04:05 3 5 3 02/01/2030');
    const nv = first.host.nv as { rtc: number };
    first.sim.stop(true);
    const second = run([esp, comp('rtc1', 'ds3231')], wires, 'RTC_DS3231 rtc;\nvoid setup() { Serial.begin(9600); rtc.begin(); Serial.print(rtc.now().year()); }\nvoid loop() { delay(10); }', { nv });
    await until(() => second.sim.serialOut.length >= 4);
    expect(second.sim.serialOut).toBe('2030');
  });
  it('starts at the computer time and parses __DATE__ / __TIME__', async () => {
    const { sim, host } = run([esp, comp('rtc1', 'ds3231')], wires, `RTC_DS3231 rtc;
void setup() { Serial.begin(9600); rtc.begin(); Serial.print(rtc.now().year()); Serial.print(" "); DateTime b = DateTime(F(__DATE__), F(__TIME__)); Serial.print(b.year()); }
void loop() { delay(10); }`);
    await until(() => sim.serialOut.length >= 9);
    expect(host.errors).toEqual([]);
    const y = new Date().getFullYear();
    expect(sim.serialOut).toBe(`${y} ${y}`);
  });
});

describe('Keypad', () => {
  const pins = ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'];
  const gp = [13, 12, 14, 27, 26, 25, 33, 32];
  const wires = pins.map((p, i) => [`kp1:${p}`, `esp:D${gp[i]}`] as [string, string]);
  it('getKey() returns each click once, following the wiring', async () => {
    const { sim, host } = run([esp, comp('kp1', 'keypad')], wires, `#include <Keypad.h>
const byte ROWS = 4; const byte COLS = 4;
char keys[ROWS][COLS] = { {'1','2','3','A'}, {'4','5','6','B'}, {'7','8','9','C'}, {'*','0','#','D'} };
byte rowPins[ROWS] = {13, 12, 14, 27};
byte colPins[COLS] = {26, 25, 33, 32};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
void setup() { Serial.begin(9600); }
void loop() { char key = keypad.getKey(); if (key) Serial.print(key); if (key == '#') Serial.print("!"); delay(5); }`);
    await wait(30);
    for (const k of ['0,1', '2,2', '3,2']) { sim.setPressed('kp1', true, k); sim.setPressed('kp1', false, k); } // quick clicks between polls
    await until(() => sim.serialOut.length >= 4);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('29#!');
  });
  it('a pressed key joins its row and column electrically (for sketches that scan by hand)', async () => {
    const { sim } = run([esp, comp('kp1', 'keypad')], wires, 'void setup() { pinMode(13, OUTPUT); digitalWrite(13, LOW); pinMode(26, INPUT_PULLUP); }\nvoid loop() { delay(5); }');
    await wait(30);
    expect(sim.readPin(26)).toBe(1);
    sim.setPressed('kp1', true, '0,0');
    expect(sim.readPin(26)).toBe(0);
  });
});

describe('Bounce2', () => {
  it('debounces a button and reports presses once', async () => {
    const { sim, host } = run([esp, comp('b1', 'button')], [['esp:D4', 'b1:1'], ['b1:2', 'esp:GND.R']], `#include <Bounce2.h>
Bounce2::Button button = Bounce2::Button();
int count = 0;
void setup() { Serial.begin(9600); button.attach(4, INPUT_PULLUP); button.interval(5); button.setPressedState(LOW); }
void loop() { button.update(); if (button.pressed()) { count++; Serial.print(count); } delay(1); }`);
    await wait(30);
    sim.setPressed('b1', true); await wait(40); sim.setPressed('b1', false); await wait(40);
    sim.setPressed('b1', true); await wait(40); sim.setPressed('b1', false); await wait(20);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('12');
  });
});

describe('IRremote', () => {
  const wires: Array<[string, string]> = [['esp:3V3', 'ir1:VCC'], ['ir1:GND', 'esp:GND.R'], ['esp:D15', 'ir1:OUT']];
  it('IrReceiver (v3/v4 API) decodes NEC codes from the remote', async () => {
    const { sim, host } = run([esp, comp('ir1', 'ir_receiver'), comp('remote1', 'ir_remote')], wires, `#include <IRremote.hpp>
void setup() { Serial.begin(9600); IrReceiver.begin(15, ENABLE_LED_FEEDBACK); }
void loop() { if (IrReceiver.decode()) { Serial.print(IrReceiver.decodedIRData.command, HEX); Serial.print(" "); Serial.println(IrReceiver.decodedIRData.decodedRawData, HEX); IrReceiver.resume(); } delay(5); }`);
    await wait(30);
    sim.setPressed('remote1', true, 'ch-'); sim.setPressed('remote1', false, 'ch-');
    await until(() => sim.serialOut.includes('\n'));
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('45 BA45FF00\r\n');
  });
  it('IRrecv + decode_results (v2 API) gives the classic 0xFFxxxx value', async () => {
    const { sim, host } = run([esp, comp('ir1', 'ir_receiver'), comp('remote1', 'ir_remote')], wires, `IRrecv irrecv(15);
decode_results results;
void setup() { Serial.begin(9600); irrecv.enableIRIn(); }
void loop() { if (irrecv.decode(&results)) { Serial.println(results.value, HEX); irrecv.resume(); } delay(5); }`);
    await wait(30);
    sim.setPressed('remote1', true, '1'); sim.setPressed('remote1', false, '1');
    await until(() => sim.serialOut.includes('\n'));
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('FF30CF\r\n');
  });
});

describe('ArduinoJson', () => {
  it('builds, serializes and parses documents', async () => {
    const { sim, host } = run([esp], [], `#include <ArduinoJson.h>
void setup() {
  Serial.begin(9600);
  StaticJsonDocument<200> doc;
  doc["sensor"] = "dht22";
  doc["temp"] = 23.5;
  doc["data"][0] = 1;
  doc["data"][1] = 2;
  JsonObject loc = doc.createNestedObject("loc");
  loc["room"] = "lab";
  char buffer[200];
  serializeJson(doc, buffer);
  Serial.println(buffer);
  JsonDocument in;
  DeserializationError error = deserializeJson(in, "{\\"led\\":true,\\"level\\":42,\\"name\\":\\"cat\\",\\"list\\":[5,6,7]}");
  if (error) { Serial.print("fail"); return; }
  bool led = in["led"];
  int level = in["level"];
  const char* name = in["name"];
  Serial.print(led); Serial.print(level); Serial.print(name); Serial.print(in["list"].size()); Serial.print(in["list"][2].as<int>());
  String missing = in["nope"] | "def";
  Serial.print(missing); Serial.print(in["level"] | 7);
  for (JsonVariant v : in["list"].as<JsonArray>()) Serial.print(v.as<int>());
  DeserializationError bad = deserializeJson(in, "{oops");
  Serial.print(" "); Serial.print(bad.c_str());
}
void loop() { delay(10); }`);
    await until(() => sim.serialOut.includes('Input'));
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('{"sensor":"dht22","temp":23.5,"data":[1,2],"loc":{"room":"lab"}}\r\n142cat37def42567 InvalidInput');
  });
});

describe('ArduinoJson: missing keys', () => {
  it('read as 0 / false / empty, like the real library', async () => {
    const { sim, host } = run([esp], [], `void setup() { Serial.begin(9600); JsonDocument d; deserializeJson(d, "{}");
  bool on = d["led"]; int n = d["level"]; float t = d["temp"]; String s = d["name"].as<String>();
  Serial.print(on); Serial.print(n); Serial.print(t); Serial.print("[" + s + "]");
  n = d["other"]; Serial.print(n); Serial.print(d["x"].isNull()); }
void loop() { delay(10); }`);
    await until(() => sim.serialOut.length >= 9);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('000.00[]01');
  });
});

describe('unsupported libraries', () => {
  it('names the missing library instead of failing with a bare syntax error', async () => {
    const { host } = run([esp], [], '#include <Wire.h>\n#include <Adafruit_TCS34725.h>\nAdafruit_TCS34725 tcs;\nvoid setup() { tcs.begin(); }\nvoid loop() { delay(10); }');
    await wait(30);
    expect(host.logs.some((m) => /#include <Adafruit_TCS34725\.h>: this library isn't available/.test(m))).toBe(true);
    expect(host.logs.some((m) => /Compile error.*unsupported library <Adafruit_TCS34725\.h>/.test(m))).toBe(true);
    expect(host.logs.some((m) => /Wire\.h/.test(m))).toBe(false);
  });
});

describe('libraries on the Arduino Uno', () => {
  it('OLED on the SDA/SCL header, DS3231 on A4/A5 and a NeoPixel strip on D6 at 5 V', async () => {
    const { sim, host } = run([uno, comp('oled1', 'oled'), comp('rtc1', 'ds3231'), comp('strip1', 'ws2812_strip')], [
      ['uno:5V', 'oled1:VCC'], ['oled1:GND', 'uno:GND1'], ['uno:SDA', 'oled1:SDA'], ['uno:SCL', 'oled1:SCL'],
      ['uno:5V', 'rtc1:VCC'], ['rtc1:GND', 'uno:GND2'], ['uno:A4', 'rtc1:SDA'], ['uno:A5', 'rtc1:SCL'],
      ['uno:5V', 'strip1:VCC'], ['strip1:GND', 'uno:GND1'], ['uno:D6', 'strip1:DIN'],
    ], `#include <Adafruit_SSD1306.h>
#include <RTClib.h>
#include <Adafruit_NeoPixel.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
RTC_DS3231 rtc;
Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);
void setup() { Serial.begin(9600); display.begin(SSD1306_SWITCHCAPVCC, 0x3C); display.fillRect(0, 0, 8, 8, SSD1306_WHITE); display.display();
  Serial.print(rtc.begin()); strip.begin(); strip.setPixelColor(2, 0, 0, 200); strip.show(); }
void loop() { delay(10); }`, { board: 'uno' });
    await until(() => !!sim.dev.strip1);
    expect(host.errors).toEqual([]);
    expect(host.logs.filter((m) => /no OLED|no DS3231|nothing is wired/.test(m))).toEqual([]);
    expect(sim.serialOut).toBe('1');
    expect(sim.dev.oled1.buf[0]).toBe(0xff);
    expect(sim.dev.strip1.rgb[2]).toBe(200);
  });
});

describe('BME280, MPU6050, parallel LCD', () => {
  it('Adafruit_BME280 reads the sensor at 0x76; begin() at the default 0x77 fails with a hint', async () => {
    const { sim, host } = run([esp, comp('b1', 'bme280', { temp: 21.5, hum: 40, pressure: 1000 })], [['esp:3V3', 'b1:VIN'], ['b1:GND', 'esp:GND.R'], ['esp:D21', 'b1:SDA'], ['esp:D22', 'b1:SCL']],
      `#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup() { Serial.begin(9600); Serial.print(bme.begin()); Serial.print(bme.begin(0x76)); Serial.print(" "); Serial.print(bme.readTemperature()); Serial.print(" ");
  Serial.print(bme.readHumidity()); Serial.print(" "); Serial.print(bme.readPressure() / 100.0F); Serial.print(" "); Serial.print(bme.readAltitude(1013.25)); }
void loop() { delay(10); }`);
    await until(() => sim.serialOut.split(' ').length >= 5);
    expect(host.errors).toEqual([]);
    const [ok, t, h, p, alt] = sim.serialOut.split(' ');
    expect(ok).toBe('01'); expect(t).toBe('21.50'); expect(h).toBe('40.00'); expect(p).toBe('1000.00');
    expect(+alt).toBeCloseTo(110.9, 0);
    expect(host.logs.some((m) => /begin\(\) looked at 0x77\. Use begin\(0x76\)/.test(m))).toBe(true);
  });
  it('Adafruit_MPU6050 getEvent and the raw MPU6050 getMotion6 follow the tilt sliders', async () => {
    const { sim, host } = run([esp, comp('m1', 'mpu6050', { roll: 0, pitch: 30, spin: 90 })], [['esp:3V3', 'm1:VCC'], ['m1:GND', 'esp:GND.R'], ['esp:D21', 'm1:SDA'], ['esp:D22', 'm1:SCL']],
      `#include <Adafruit_MPU6050.h>
#include <MPU6050.h>
Adafruit_MPU6050 mpu;
MPU6050 raw;
void setup() { Serial.begin(9600); if (!mpu.begin()) { Serial.print("no mpu"); return; }
  sensors_event_t a, g, temp; mpu.getEvent(&a, &g, &temp);
  Serial.print(a.acceleration.x); Serial.print(" "); Serial.print(a.acceleration.z); Serial.print(" "); Serial.print(g.gyro.z); Serial.print(" ");
  raw.initialize(); int16_t ax, ay, az, gx, gy, gz; raw.getMotion6(&ax, &ay, &az, &gx, &gy, &gz); Serial.print(ax); Serial.print(" "); Serial.print(gz); }
void loop() { delay(10); }`);
    await until(() => sim.serialOut.split(' ').length >= 5);
    expect(host.errors).toEqual([]);
    const [ax, az, gz, rax, rgz] = sim.serialOut.split(' ').map(Number);
    expect(ax).toBeCloseTo(-4.9, 1); expect(az).toBeCloseTo(8.49, 1); expect(gz).toBeCloseTo(1.57, 2);
    expect(rax).toBe(-8192); expect(rgz).toBe(11790);
  });
  it('LiquidCrystal (4-bit parallel) on an Uno shows text when wired like the starter-kit diagram', async () => {
    const pins: Array<[string, string]> = [['uno:GND1', 'lcd1:VSS'], ['uno:5V', 'lcd1:VDD'], ['uno:GND2', 'lcd1:V0'], ['uno:D12', 'lcd1:RS'], ['uno:GND3', 'lcd1:RW'], ['uno:D11', 'lcd1:E'],
      ['uno:D5', 'lcd1:D4'], ['uno:D4', 'lcd1:D5'], ['uno:D3', 'lcd1:D6'], ['uno:D2', 'lcd1:D7'], ['uno:5V', 'lcd1:A'], ['lcd1:K', 'uno:GND1']];
    const { sim, host } = run([uno, comp('lcd1', 'lcd_parallel')], pins,
      '#include <LiquidCrystal.h>\nLiquidCrystal lcd(12, 11, 5, 4, 3, 2);\nvoid setup() { lcd.begin(16, 2); lcd.print("hello, world!"); lcd.setCursor(0, 1); lcd.print(42); }\nvoid loop() { delay(10); }', { board: 'uno' });
    await until(() => !!sim.dev.lcd1);
    await wait(30);
    expect(host.errors).toEqual([]);
    expect(sim.dev.lcd1.buf[0].join('')).toBe('hello, world!   ');
    expect(sim.dev.lcd1.buf[1].join('').trim()).toBe('42');
    expect(sim.dev.lcd1).toMatchObject({ backlight: true, contrast: 1 });
  });
});

describe('EEPROM and Preferences', () => {
  it('ESP32 EEPROM keeps committed data across restarts', async () => {
    const code = `#include <EEPROM.h>
void setup() { Serial.begin(9600); EEPROM.begin(64); int boots = EEPROM.read(0); if (boots == 255) boots = 0; boots++;
  EEPROM.write(0, boots); float f = 0; if (boots > 1) EEPROM.get(4, f); Serial.print(boots); Serial.print(" "); Serial.print(f); EEPROM.put(4, 3.5); EEPROM.commit(); }
void loop() { delay(10); }`;
    const a = run([esp], [], code);
    await until(() => a.sim.serialOut.length >= 3);
    expect(a.host.errors).toEqual([]);
    expect(a.sim.serialOut).toBe('1 0.00'); // float f prints with 2 decimals
    const nv = a.host.nv as object; a.sim.stop(true);
    const b = run([esp], [], code, { nv });
    await until(() => b.sim.serialOut.length >= 3);
    expect(b.sim.serialOut).toBe('2 3.50');
  });
  it('Uno EEPROM needs no begin() and writes immediately', async () => {
    const { sim, host } = run([uno], [], 'void setup() { Serial.begin(9600); EEPROM.update(10, 7); EEPROM[11] = 9; Serial.print(EEPROM.read(10)); Serial.print(EEPROM[11]); Serial.print(EEPROM.length()); }\nvoid loop() { delay(10); }', { board: 'uno' });
    await until(() => sim.serialOut.length >= 6);
    expect(host.errors).toEqual([]);
    expect(sim.serialOut).toBe('791024');
    expect((host.nv as { eeprom: Uint8Array }).eeprom[10]).toBe(7);
  });
  it('Preferences stores typed values per namespace', async () => {
    const code = `#include <Preferences.h>
Preferences prefs;
void setup() { Serial.begin(9600); prefs.begin("app", false); unsigned int n = prefs.getUInt("count", 0); n++; prefs.putUInt("count", n);
  prefs.putString("name", "cat"); Serial.print(n); Serial.print(prefs.getString("name", "")); Serial.print(prefs.isKey("zzz")); prefs.end(); }
void loop() { delay(10); }`;
    const a = run([esp], [], code);
    await until(() => a.sim.serialOut.length >= 5);
    expect(a.sim.serialOut).toBe('1cat0');
    const nv = a.host.nv as object; a.sim.stop(true);
    const b = run([esp], [], code, { nv });
    await until(() => b.sim.serialOut.length >= 5);
    expect(b.sim.serialOut).toBe('2cat0');
    expect(b.host.errors).toEqual([]);
  });
  it('Preferences and Ticker are ESP32-only', async () => {
    const { host } = run([uno], [], 'Preferences p;\nvoid setup() { p.begin("x"); }\nvoid loop() { delay(10); }', { board: 'uno' });
    await wait(30);
    expect(String(host.errors[0])).toMatch(/Preferences is ESP32-only/);
  });
});

describe('Ticker', () => {
  it('calls a function periodically and once', async () => {
    const { sim, host } = run([esp], [], `#include <Ticker.h>
Ticker tick, one;
volatile int n = 0;
void count() { n++; }
void hello() { Serial.print("once "); }
void setup() { Serial.begin(9600); tick.attach_ms(10, count); one.once(0.02, hello); }
void loop() { if (n >= 5) { tick.detach(); Serial.print(n); n = -100; } delay(1); }`);
    await until(() => /once 5/.test(sim.serialOut));
    expect(host.errors).toEqual([]);
  });
});

describe('Stepper and AccelStepper on a 28BYJ-48', () => {
  const ins = ['IN1', 'IN2', 'IN3', 'IN4'];
  const gp = [19, 18, 5, 17];
  const wires: Array<[string, string]> = [...ins.map((p, i) => [`m1:${p}`, `esp:D${gp[i]}`] as [string, string]), ['esp:VIN', 'm1:VCC'], ['m1:GND', 'esp:GND.R']];
  wires[3] = ['m1:IN4', 'esp:TX2'];
  it('Stepper(2048, IN1, IN3, IN2, IN4) turns the shaft a quarter turn for 512 steps', async () => {
    const { sim, host } = run([esp, comp('m1', 'stepper')], wires, `#include <Stepper.h>
Stepper motor(2048, 19, 5, 18, 17);
void setup() { Serial.begin(9600); motor.setSpeed(15); motor.step(512); Serial.print("done"); }
void loop() { delay(10); }`, { speed: 20 });
    await until(() => sim.serialOut === 'done', 8000);
    expect(host.errors).toEqual([]);
    expect(sim.dev.m1.angle).toBeCloseTo(90, 0);
  });
  it('the wrong pin order (IN1, IN2, IN3, IN4) only makes the motor jitter', async () => {
    const { sim } = run([esp, comp('m1', 'stepper')], wires, `Stepper motor(2048, 19, 18, 5, 17);
void setup() { Serial.begin(9600); motor.setSpeed(15); motor.step(400); Serial.print("done"); }
void loop() { delay(10); }`, { speed: 20 });
    await until(() => sim.serialOut === 'done', 8000);
    expect(Math.abs(sim.dev.m1.angle)).toBeLessThan(2);
  });
  it('AccelStepper moves to a target with acceleration (and back)', async () => {
    const { sim, host } = run([esp, comp('m1', 'stepper')], wires, `#include <AccelStepper.h>
AccelStepper stepper(AccelStepper::FULL4WIRE, 19, 5, 18, 17);
void setup() { Serial.begin(9600); stepper.setMaxSpeed(800); stepper.setAcceleration(400); stepper.moveTo(-1024); }
void loop() { stepper.run(); if (stepper.distanceToGo() == 0 && stepper.currentPosition() == -1024) { Serial.print("there"); stepper.moveTo(-1025); } }`, { speed: 20 });
    await until(() => sim.serialOut.startsWith('there'), 8000);
    expect(host.errors).toEqual([]);
    expect(Math.abs(sim.dev.m1.angle)).toBeCloseTo(180, 0);
  });
});
