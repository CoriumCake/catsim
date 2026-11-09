/* CatSim — examples for the built-in Arduino libraries. ESP32 at (300, 80): left pins x=300, right pins x=450. */
const esp = { id: 'esp', type: 'esp32', x: 300, y: 80, props: {} };
const W = (from, to, color) => ({ from, to, ...(color ? { color } : {}) });
const led = (id, x, y, color) => ({ id, type: 'led', x, y, props: { color } });
const res = (id, x, y, ohms = 220) => ({ id, type: 'resistor', x, y, props: { ohms } });
/** GPIO → resistor → LED → GND */
const ledWires = (pin, r, l, gnd = 'esp:GND.R') => [W(pin, `${r}:1`), W(`${r}:2`, `${l}:A`), W(`${l}:C`, gnd)];

export const LIB_EXAMPLES = [
  {
    key: 'glove', name: 'Pressure glove: ESP32-C3 + 3 FSRs + RGB LED + vibration (battery powered)',
    components: [
      { id: 'c3', type: 'esp32c3', x: 400, y: 60, props: { power: 'pins' } },
      { id: 'bat1', type: 'battery', x: -80, y: 360, props: { type: '18650 Li-ion (3.7 V)', charge: 80 } },
      { id: 'chg1', type: 'tp4056', x: -90, y: 230, props: { usb: false } },
      { id: 'sw1', type: 'slide_switch', x: 110, y: 40, props: { on: true } },
      { id: 'reg1', type: 'buckboost', x: 220, y: 150, props: {} },
      { id: 'f1', type: 'fsr', x: 170, y: 330, props: { force: 0 } }, { id: 'rf1', type: 'resistor', x: 150, y: 460, props: { ohms: 10000 } },
      { id: 'f2', type: 'fsr', x: 240, y: 330, props: { force: 0 } }, { id: 'rf2', type: 'resistor', x: 230, y: 490, props: { ohms: 10000 } },
      { id: 'f3', type: 'fsr', x: 310, y: 330, props: { force: 0 } }, { id: 'rf3', type: 'resistor', x: 310, y: 520, props: { ohms: 10000 } },
      { id: 'rgb1', type: 'rgb_led', x: 640, y: -40, props: { common: 'anode' } },
      { id: 'r1', type: 'resistor', x: 530, y: 60, props: { ohms: 220 } },
      { id: 'r2', type: 'resistor', x: 530, y: 90, props: { ohms: 220 } },
      { id: 'r3', type: 'resistor', x: 530, y: 120, props: { ohms: 220 } },
      { id: 'btn1', type: 'button', x: 560, y: 220, props: { color: 'blue' } },
      { id: 'm1', type: 'vibmotor', x: 700, y: 330, props: {} },
      { id: 'q1', type: 'nmos', x: 600, y: 410, props: { model: 'AO3400', spice: '' } },
      { id: 'rg', type: 'resistor', x: 470, y: 330, props: { ohms: 100 } },
      { id: 'rpd', type: 'resistor', x: 500, y: 480, props: { ohms: 100000 } },
      { id: 'd1', type: 'diode', x: 760, y: 440, props: { model: '1N5819', spice: '' } },
    ],
    wires: [
      W('bat1:+', 'chg1:B+', 'red'), W('bat1:-', 'chg1:B-', 'black'),
      W('chg1:OUT+', 'sw1:COM', 'red'), W('sw1:B', 'reg1:VIN', 'red'), W('chg1:OUT-', 'reg1:GND', 'black'),
      W('reg1:VOUT', 'c3:3V3', 'orange'), W('reg1:GND2', 'c3:GND', 'black'),
      W('f1:1', 'c3:3V3', 'orange'), W('f1:2', 'c3:IO0'), W('rf1:1', 'c3:IO0'), W('rf1:2', 'c3:GND', 'black'),
      W('f2:1', 'c3:3V3', 'orange'), W('f2:2', 'c3:IO1'), W('rf2:1', 'c3:IO1'), W('rf2:2', 'c3:GND', 'black'),
      W('f3:1', 'c3:3V3', 'orange'), W('f3:2', 'c3:IO3'), W('rf3:1', 'c3:IO3'), W('rf3:2', 'c3:GND', 'black'),
      W('rgb1:COM', 'c3:3V3', 'orange'), W('rgb1:R', 'r1:2', 'red'), W('r1:1', 'c3:IO5', 'red'), W('rgb1:G', 'r2:2', 'green'), W('r2:1', 'c3:IO6', 'green'),
      W('rgb1:B', 'r3:2', 'blue'), W('r3:1', 'c3:IO7', 'blue'),
      W('btn1:1', 'c3:IO10'), W('btn1:2', 'c3:GND', 'black'),
      W('m1:+', 'c3:3V3', 'orange'), W('m1:-', 'q1:D'), W('q1:S', 'c3:GND', 'black'),
      W('c3:IO4', 'rg:1', 'purple'), W('rg:2', 'q1:G', 'purple'), W('q1:G', 'rpd:1'), W('rpd:2', 'c3:GND', 'black'),
      W('d1:K', 'm1:+'), W('d1:A', 'm1:-'),
    ],
    code: `// Pressure glove: three FSR fingertips on an ESP32-C3 Super Mini, powered by an 18650 cell
// (TP4056 charger -> ON/OFF switch -> 3.3 V buck-boost -> the board's 3V3 pin).
// Green = light touch, yellow = firm, red = too hard (and the motor buzzes).
// Drag the FSR force sliders (or press an FSR with the mouse). The button re-calibrates with no touch.
// Open the Plotter tab to see the three fingers.
const int FSR_PINS[3] = {0, 1, 3};   // ADC1 pins
const int LED_R = 5, LED_G = 6, LED_B = 7;   // common-anode RGB LED: LOW = on
const int MOTOR = 4;                 // AO3400 gate (100 ohm in series, 100k pull-down)
const int BUTTON = 10;               // to GND, internal pull-up
int baseline[3] = {0, 0, 0};

void setColor(bool r, bool g, bool b) {
  digitalWrite(LED_R, r ? LOW : HIGH);
  digitalWrite(LED_G, g ? LOW : HIGH);
  digitalWrite(LED_B, b ? LOW : HIGH);
}

void calibrate() {
  for (int i = 0; i < 3; i++) baseline[i] = analogRead(FSR_PINS[i]);
  Serial.println("calibrated");
  setColor(false, false, true);  // blue blink
  delay(300);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_R, OUTPUT); pinMode(LED_G, OUTPUT); pinMode(LED_B, OUTPUT);
  pinMode(MOTOR, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  calibrate();
}

void loop() {
  if (digitalRead(BUTTON) == LOW) calibrate();
  int peak = 0;
  for (int i = 0; i < 3; i++) {
    int v = analogRead(FSR_PINS[i]) - baseline[i];
    if (v < 0) v = 0;
    if (v > peak) peak = v;
    Serial.print("f"); Serial.print(i + 1); Serial.print(":"); Serial.print(v); Serial.print(" ");
  }
  Serial.println();
  if (peak > 3000) { setColor(true, false, false); digitalWrite(MOTOR, HIGH); }
  else if (peak > 1500) { setColor(true, true, false); digitalWrite(MOTOR, LOW); }
  else if (peak > 200) { setColor(false, true, false); digitalWrite(MOTOR, LOW); }
  else { setColor(false, false, false); digitalWrite(MOTOR, LOW); }
  delay(50);
}
`,
  },
  {
    key: 'oled', name: 'OLED display (Adafruit SSD1306 + GFX)',
    components: [esp, { id: 'oled1', type: 'oled', x: 540, y: 10, props: { addr: '0x3C', color: 'yellow + blue' } }],
    wires: [W('esp:3V3', 'oled1:VCC', 'red'), W('oled1:GND', 'esp:GND.R', 'black'), W('esp:D22', 'oled1:SCL', 'yellow'), W('esp:D21', 'oled1:SDA', 'blue')],
    code: `// SSD1306 OLED on I2C (SDA GPIO21, SCL GPIO22): text, shapes and a bouncing ball.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

int x = 20, y = 30, dx = 2, dy = 1;

void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 allocation failed"));
    for (;;);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(10, 0);
  display.println(F("CatSim"));
  display.display();
  delay(1000);
}

void loop() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("Uptime: "));
  display.print(millis() / 1000);
  display.println(F(" s"));
  display.drawRect(0, 16, 128, 48, SSD1306_WHITE);
  display.fillCircle(x, y, 4, SSD1306_WHITE);
  x += dx; y += dy;
  if (x < 5 || x > 122) dx = -dx;
  if (y < 21 || y > 58) dy = -dy;
  display.display();
  delay(30);
}
`,
  },
  {
    key: 'neopixel', name: 'NeoPixel ring rainbow (Adafruit NeoPixel)',
    components: [esp, { id: 'ring1', type: 'ws2812_ring', x: 540, y: 120, props: {} }],
    wires: [W('esp:VIN', 'ring1:VCC', 'red'), W('esp:D5', 'ring1:DIN', 'green'), W('ring1:GND', 'esp:GND.R', 'black')],
    code: `// 16 WS2812B LEDs on GPIO5: a rotating rainbow.
#include <Adafruit_NeoPixel.h>

#define PIN 5
#define NUMPIXELS 16
Adafruit_NeoPixel ring(NUMPIXELS, PIN, NEO_GRB + NEO_KHZ800);

long firstHue = 0;

void setup() {
  ring.begin();
  ring.setBrightness(80);
}

void loop() {
  for (int i = 0; i < ring.numPixels(); i++) {
    int hue = firstHue + (i * 65536L / ring.numPixels());
    ring.setPixelColor(i, ring.gamma32(ring.ColorHSV(hue)));
  }
  ring.show();
  firstHue += 1024;
  delay(20);
}
`,
  },
  {
    key: 'fastled', name: 'LED strip effects (FastLED)',
    components: [esp, { id: 'strip1', type: 'ws2812_strip', x: 530, y: 160, props: {} },
      { id: 'pot1', type: 'pot', x: 170, y: 340, props: { value: 0.6 } }],
    wires: [W('esp:VIN', 'strip1:VCC', 'red'), W('esp:D18', 'strip1:DIN', 'green'), W('strip1:GND', 'esp:GND.R', 'black'),
      W('pot1:SIG', 'esp:D34'), W('pot1:VCC', 'esp:3V3'), W('pot1:GND', 'esp:GND.L')],
    code: `// FastLED on GPIO18: a moving dot with a fading trail over a rainbow. The knob sets the brightness.
#include <FastLED.h>

#define NUM_LEDS 8
#define DATA_PIN 18
CRGB leds[NUM_LEDS];
uint8_t hue = 0;
int pos = 0;

void setup() {
  FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS);
}

void loop() {
  FastLED.setBrightness(map(analogRead(34), 0, 4095, 10, 255));
  fadeToBlackBy(leds, NUM_LEDS, 60);
  leds[pos] = CHSV(hue, 255, 255);
  EVERY_N_MILLISECONDS(120) { pos = (pos + 1) % NUM_LEDS; }
  EVERY_N_MILLISECONDS(20) { hue++; }
  FastLED.show();
  delay(10);
}
`,
  },
  {
    key: 'clock', name: 'Clock: DS3231 RTC + TM1637 display',
    components: [esp, { id: 'rtc1', type: 'ds3231', x: 560, y: 20, props: { temp: 24 } },
      { id: 'disp1', type: 'tm1637', x: 110, y: 330, props: {} }],
    wires: [W('esp:3V3', 'rtc1:VCC', 'red'), W('rtc1:GND', 'esp:GND.R', 'black'), W('esp:D21', 'rtc1:SDA', 'blue'), W('esp:D22', 'rtc1:SCL', 'yellow'),
      W('disp1:CLK', 'esp:D26', 'green'), W('disp1:DIO', 'esp:D27', 'orange'), W('disp1:VCC', 'esp:VIN', 'red'), W('disp1:GND', 'esp:GND.L', 'black')],
    code: `// The DS3231 keeps the time (it starts at your computer's clock); the TM1637 shows HH:MM with a blinking colon.
#include <RTClib.h>
#include <TM1637Display.h>

RTC_DS3231 rtc;
TM1637Display display(26, 27); // CLK, DIO

void setup() {
  Serial.begin(115200);
  if (!rtc.begin()) {
    Serial.println("Couldn't find the RTC");
    while (true) delay(10);
  }
  if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  display.setBrightness(5);
}

void loop() {
  DateTime now = rtc.now();
  bool colon = now.second() % 2 == 0;
  display.showNumberDecEx(now.hour() * 100 + now.minute(), colon ? 0b01000000 : 0, true);
  if (now.second() == 0 || millis() < 1500) {
    Serial.print(now.timestamp());
    Serial.print("  ");
    Serial.print(rtc.getTemperature());
    Serial.println(" C");
  }
  delay(500);
}
`,
  },
  {
    key: 'ds18b20', name: 'Two DS18B20 sensors on one 1-Wire bus',
    components: [esp, { id: 'temp1', type: 'ds18b20', x: 560, y: 190, props: { temp: 21.5 } },
      { id: 'temp2', type: 'ds18b20', x: 620, y: 190, props: { temp: 36.6 } },
      res('r1', 520, 120, 4700)],
    wires: [W('esp:D4', 'temp1:DQ', 'yellow'), W('temp1:DQ', 'temp2:DQ', 'yellow'), W('esp:3V3', 'temp1:VDD', 'red'), W('temp1:VDD', 'temp2:VDD', 'red'),
      W('temp1:GND', 'esp:GND.R', 'black'), W('temp2:GND', 'temp1:GND', 'black'), W('r1:1', 'esp:D4'), W('r1:2', 'esp:3V3')],
    code: `// DS18B20 temperature sensors share GPIO4 (with a 4.7 kΩ pull-up). Drag their temperature sliders.
#include <OneWire.h>
#include <DallasTemperature.h>

OneWire oneWire(4);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  sensors.begin();
  Serial.print("Found ");
  Serial.print(sensors.getDeviceCount());
  Serial.println(" sensors");
}

void loop() {
  sensors.requestTemperatures(); // takes 750 ms at 12-bit resolution
  for (int i = 0; i < sensors.getDeviceCount(); i++) {
    float t = sensors.getTempCByIndex(i);
    Serial.print("Sensor ");
    Serial.print(i);
    Serial.print(": ");
    Serial.print(t);
    Serial.println(" C");
  }
  delay(1000);
}
`,
  },
  {
    key: 'sonar', name: 'Parking sensor (HC-SR04 + NewPing)',
    components: [esp, { id: 'sonar1', type: 'hcsr04', x: 540, y: 300, props: { distance: 60 } },
      res('r1', 500, 100), led('led1', 600, 40, 'green'), res('r2', 500, 140), led('led2', 640, 40, 'red'),
      { id: 'bz1', type: 'buzzer', x: 200, y: 330, props: { muted: true } }],
    wires: [W('esp:VIN', 'sonar1:VCC', 'red'), W('sonar1:GND', 'esp:GND.R', 'black'), W('esp:D5', 'sonar1:TRIG', 'green'), W('esp:D18', 'sonar1:ECHO', 'yellow'),
      ...ledWires('esp:D23', 'r1', 'led1'), ...ledWires('esp:D22', 'r2', 'led2'), W('bz1:+', 'esp:D25'), W('bz1:-', 'esp:GND.L')],
    code: `// HC-SR04: green when far, red and beeping faster as the object gets closer. Drag the distance slider.
#include <NewPing.h>

#define TRIG 5
#define ECHO 18
NewPing sonar(TRIG, ECHO, 300);

void setup() {
  Serial.begin(115200);
  pinMode(23, OUTPUT);
  pinMode(22, OUTPUT);
}

void loop() {
  int cm = sonar.ping_cm(); // 0 = nothing in range
  Serial.print("Distance: ");
  Serial.print(cm);
  Serial.println(" cm");
  bool close = cm > 0 && cm < 30;
  digitalWrite(23, close ? LOW : HIGH);
  digitalWrite(22, close ? HIGH : LOW);
  if (close) {
    tone(25, 2000, 50);
    delay(cm * 10);
  } else {
    delay(200);
  }
}
`,
  },
  {
    key: 'keypad', name: 'Keypad door lock (Keypad + servo)',
    components: [esp, { id: 'keypad1', type: 'keypad', x: 70, y: 120, props: {} },
      { id: 'servo1', type: 'servo', x: 560, y: 220, props: {} },
      res('r1', 500, 70), led('led1', 600, 0, 'green'), res('r2', 500, 110), led('led2', 640, 0, 'red')],
    wires: [W('keypad1:R1', 'esp:D13'), W('keypad1:R2', 'esp:D12'), W('keypad1:R3', 'esp:D14'), W('keypad1:R4', 'esp:D27'),
      W('keypad1:C1', 'esp:D26'), W('keypad1:C2', 'esp:D25'), W('keypad1:C3', 'esp:D33'), W('keypad1:C4', 'esp:D32'),
      W('servo1:SIG', 'esp:D18', 'orange'), W('servo1:V+', 'esp:VIN', 'red'), W('servo1:GND', 'esp:GND.R', 'black'),
      ...ledWires('esp:D23', 'r1', 'led1'), ...ledWires('esp:D22', 'r2', 'led2')],
    code: `// Type 1234 then # to unlock (the servo turns), * to clear. Click the keypad keys while it runs.
#include <Keypad.h>
#include <ESP32Servo.h>

const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};
byte rowPins[ROWS] = {13, 12, 14, 27};
byte colPins[COLS] = {26, 25, 33, 32};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
Servo lock;
String code = "";

void setup() {
  Serial.begin(115200);
  pinMode(23, OUTPUT);
  pinMode(22, OUTPUT);
  lock.attach(18);
  lock.write(0);
  digitalWrite(22, HIGH);
  Serial.println("Enter the code and press #");
}

void loop() {
  char key = keypad.getKey();
  if (!key) { delay(5); return; }
  Serial.print(key);
  if (key == '*') { code = ""; Serial.println(" cleared"); }
  else if (key == '#') {
    if (code == "1234") {
      Serial.println(" unlocked");
      digitalWrite(22, LOW); digitalWrite(23, HIGH); lock.write(90);
      delay(3000);
      lock.write(0); digitalWrite(23, LOW); digitalWrite(22, HIGH);
    } else {
      Serial.println(" wrong code");
    }
    code = "";
  } else {
    code += key;
  }
}
`,
  },
  {
    key: 'irremote', name: 'IR remote control (IRremote)',
    components: [esp, { id: 'ir1', type: 'ir_receiver', x: 560, y: 260, props: {} },
      { id: 'remote1', type: 'ir_remote', x: 680, y: 60, props: {} },
      res('r1', 500, 70), led('led1', 600, 0, 'red'), res('r2', 500, 110), led('led2', 640, 0, 'green'), res('r3', 500, 150), led('led3', 680, -60, 'blue')],
    wires: [W('esp:3V3', 'ir1:VCC', 'red'), W('ir1:GND', 'esp:GND.R', 'black'), W('esp:D15', 'ir1:OUT', 'yellow'),
      ...ledWires('esp:D23', 'r1', 'led1'), ...ledWires('esp:D22', 'r2', 'led2'), ...ledWires('esp:D21', 'r3', 'led3')],
    code: `// Keys 1, 2, 3 on the remote toggle the LEDs; every code is printed. Click the remote's keys.
#include <IRremote.hpp>

#define IR_PIN 15
const int ledPins[] = {23, 22, 21};

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) pinMode(ledPins[i], OUTPUT);
  IrReceiver.begin(IR_PIN, ENABLE_LED_FEEDBACK);
  Serial.println("Ready for IR codes");
}

void loop() {
  if (IrReceiver.decode()) {
    IrReceiver.printIRResultShort(&Serial);
    if (!(IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT)) {
      switch (IrReceiver.decodedIRData.command) {
        case 0x0C: digitalWrite(23, !digitalRead(23)); break; // key 1
        case 0x18: digitalWrite(22, !digitalRead(22)); break; // key 2
        case 0x5E: digitalWrite(21, !digitalRead(21)); break; // key 3
      }
    }
    IrReceiver.resume();
  }
  delay(10);
}
`,
  },
  {
    key: 'json', name: 'IoT: JSON over MQTT (ArduinoJson + DHT22)',
    components: [esp, { id: 'dht1', type: 'dht22', x: 560, y: 210, props: { temp: 23.4, hum: 51 } },
      res('r1', 500, 70), led('led1', 600, 0, 'yellow')],
    wires: [W('dht1:VCC', 'esp:3V3', 'red'), W('dht1:GND', 'esp:GND.R', 'black'), W('dht1:DATA', 'esp:D4', 'green'), ...ledWires('esp:D23', 'r1', 'led1')],
    code: `// Publishes readings as JSON on catsim/room and obeys JSON commands on catsim/cmd,
// e.g. {"led": true} — send one from the IoT tab.
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

WiFiClient net;
PubSubClient mqtt(net);
DHT dht(4, DHT22);

void onMessage(char* topic, byte* payload, unsigned int length) {
  String text = "";
  for (int i = 0; i < length; i++) text += (char)payload[i];
  JsonDocument cmd;
  DeserializationError err = deserializeJson(cmd, text);
  if (err) { Serial.print("Bad JSON: "); Serial.println(err.c_str()); return; }
  if (cmd["led"].is<bool>()) {
    bool on = cmd["led"];
    digitalWrite(23, on ? HIGH : LOW);
    Serial.println(on ? "LED on" : "LED off");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(23, OUTPUT);
  dht.begin();
  WiFi.begin("CatSim-Guest", "");
  while (WiFi.status() != WL_CONNECTED) delay(200);
  mqtt.setServer("broker.catsim.local", 1883);
  mqtt.setCallback(onMessage);
  mqtt.connect("room-sensor");
  mqtt.subscribe("catsim/cmd");
}

void loop() {
  mqtt.loop();
  static unsigned long last = 0;
  if (millis() - last > 2000) {
    last = millis();
    JsonDocument doc;
    doc["temperature"] = dht.readTemperature();
    doc["humidity"] = dht.readHumidity();
    doc["uptime"] = millis() / 1000;
    char out[128];
    serializeJson(doc, out);
    mqtt.publish("catsim/room", out);
    Serial.println(out);
  }
  delay(10);
}
`,
  },
  {
    key: 'prefs', name: 'Saved counter (Preferences + Ticker)',
    components: [esp, { id: 'btn1', type: 'button', x: 540, y: 250, props: { color: 'blue' } }],
    wires: [W('btn1:1', 'esp:D4'), W('btn1:2', 'esp:GND.R', 'black')],
    code: `// Each button press is counted and saved in flash: press Restart (or Stop and Start) and it is still there.
// A Ticker blinks the on-board LED in the background.
#include <Preferences.h>
#include <Ticker.h>

Preferences prefs;
Ticker blinker;
unsigned int presses;
bool lastBtn = HIGH;

void blink() { digitalWrite(2, !digitalRead(2)); }

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  pinMode(4, INPUT_PULLUP);
  prefs.begin("counter", false);
  presses = prefs.getUInt("presses", 0);
  unsigned int boots = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", boots);
  Serial.printf("Boot #%u, %u presses saved so far\\n", boots, presses);
  blinker.attach(0.5, blink);
}

void loop() {
  bool b = digitalRead(4);
  if (b == LOW && lastBtn == HIGH) {
    presses++;
    prefs.putUInt("presses", presses);
    Serial.printf("Pressed %u times\\n", presses);
  }
  lastBtn = b;
  delay(20);
}
`,
  },
  {
    key: 'stepper', name: 'Stepper motor (28BYJ-48 + Stepper library)',
    components: [esp, { id: 'step1', type: 'stepper', x: 540, y: 150, props: {} }],
    wires: [W('step1:IN1', 'esp:D19', 'blue'), W('step1:IN2', 'esp:D18', 'purple'), W('step1:IN3', 'esp:D5', 'yellow'), W('step1:IN4', 'esp:TX2', 'orange'),
      W('step1:VCC', 'esp:VIN', 'red'), W('step1:GND', 'esp:GND.R', 'black')],
    code: `// Half a turn one way, half a turn back. The 28BYJ-48 needs the pins in the order IN1, IN3, IN2, IN4.
#include <Stepper.h>

const int stepsPerRevolution = 2048;
Stepper motor(stepsPerRevolution, 19, 5, 18, 17); // IN1, IN3, IN2, IN4

void setup() {
  Serial.begin(115200);
  motor.setSpeed(12); // rpm
}

void loop() {
  Serial.println("clockwise");
  motor.step(stepsPerRevolution / 2);
  delay(500);
  Serial.println("counterclockwise");
  motor.step(-stepsPerRevolution / 2);
  delay(500);
}
`,
  },
  {
    key: 'accelstepper', name: 'Knob-positioned stepper (AccelStepper)',
    components: [esp, { id: 'step1', type: 'stepper', x: 540, y: 150, props: {} },
      { id: 'pot1', type: 'pot', x: 170, y: 340, props: { value: 0.25 } }],
    wires: [W('step1:IN1', 'esp:D19', 'blue'), W('step1:IN2', 'esp:D18', 'purple'), W('step1:IN3', 'esp:D5', 'yellow'), W('step1:IN4', 'esp:TX2', 'orange'),
      W('step1:VCC', 'esp:VIN', 'red'), W('step1:GND', 'esp:GND.R', 'black'),
      W('pot1:SIG', 'esp:D34'), W('pot1:VCC', 'esp:3V3'), W('pot1:GND', 'esp:GND.L')],
    code: `// The motor follows the knob (one turn of the knob range = one turn of the shaft), with smooth acceleration.
#include <AccelStepper.h>

AccelStepper stepper(AccelStepper::FULL4WIRE, 19, 5, 18, 17); // IN1, IN3, IN2, IN4

void setup() {
  stepper.setMaxSpeed(500);
  stepper.setAcceleration(300);
}

void loop() {
  long target = map(analogRead(34), 0, 4095, 0, 2048);
  if (abs(target - stepper.targetPosition()) > 8) stepper.moveTo(target);
  stepper.run();
}
`,
  },
  {
    key: 'uno-bounce', name: 'Arduino Uno: debounced toggle saved in EEPROM (Bounce2)',
    components: [{ id: 'uno', type: 'uno', x: 300, y: 80, props: {} },
      { id: 'btn1', type: 'button', x: 640, y: 300, props: { color: 'green' } },
      res('r1', 430, -60), led('led1', 520, -130, 'yellow')],
    wires: [W('uno:D9', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'uno:GND1'), W('btn1:1', 'uno:D2'), W('btn1:2', 'uno:GND2', 'black')],
    code: `// The button toggles the LED; the state is saved in EEPROM, so it survives Stop/Start.
#include <Bounce2.h>
#include <EEPROM.h>

Bounce2::Button button = Bounce2::Button();
bool on;

void setup() {
  Serial.begin(9600);
  pinMode(9, OUTPUT);
  button.attach(2, INPUT_PULLUP);
  button.interval(10);
  button.setPressedState(LOW);
  on = EEPROM.read(0) == 1;
  digitalWrite(9, on);
  Serial.println(on ? "Restored: ON" : "Restored: OFF");
}

void loop() {
  button.update();
  if (button.pressed()) {
    on = !on;
    digitalWrite(9, on);
    EEPROM.update(0, on ? 1 : 0);
    Serial.println(on ? "ON" : "OFF");
  }
}
`,
  },
  {
    key: 'breadboard', name: 'Breadboard: resistor and LED plugged in',
    components: [esp, { id: 'bb1', type: 'breadboard', x: 500, y: 260, props: {} },
      { id: 'r1', type: 'resistor', x: 556, y: 312, props: { ohms: 220 } }, { id: 'led1', type: 'led', x: 616, y: 284, props: { color: 'green' } }],
    wires: [W('esp:D23', 'bb1:5a', 'yellow'), W('bb1:13a', 'esp:GND.R', 'black')],
    code: `// The resistor and the LED are plugged into the breadboard: no wires to their legs.
// Column 5 (a-e) joins GPIO23 to the resistor, column 12 joins the resistor to the LED,
// column 13 takes the LED back to GND. Drag a part off the board and the circuit breaks.
void setup() { pinMode(23, OUTPUT); }

void loop() {
  digitalWrite(23, HIGH); delay(500);
  digitalWrite(23, LOW); delay(500);
}
`,
  },
  {
    key: 'joystick-rgb', name: 'Joystick mixes an RGB LED',
    components: [esp, { id: 'joy1', type: 'joystick', x: 140, y: 330, props: { x: 0.8, y: 0.3 } },
      { id: 'rgb1', type: 'rgb_led', x: 640, y: 40, props: { common: 'cathode' } },
      res('r1', 500, 100), res('r2', 500, 140), res('r3', 500, 180)],
    wires: [W('joy1:VCC', 'esp:3V3', 'red'), W('joy1:GND', 'esp:GND.L', 'black'), W('joy1:VRx', 'esp:D34'), W('joy1:VRy', 'esp:D35'), W('joy1:SW', 'esp:D27'),
      W('esp:D23', 'r1:1'), W('r1:2', 'rgb1:R', 'red'), W('esp:D22', 'r2:1'), W('r2:2', 'rgb1:G', 'green'), W('esp:D21', 'r3:1'), W('r3:2', 'rgb1:B', 'blue'), W('rgb1:COM', 'esp:GND.R', 'black')],
    code: `// Joystick X sets red, Y sets green, pressing it turns blue on. Drag the X / Y sliders or press the stick.
const int R = 23, G = 22, B = 21;

void setup() {
  Serial.begin(115200);
  pinMode(27, INPUT_PULLUP);
}

void loop() {
  int x = analogRead(34), y = analogRead(35);
  analogWrite(R, map(x, 0, 4095, 0, 255));
  analogWrite(G, map(y, 0, 4095, 0, 255));
  analogWrite(B, digitalRead(27) == LOW ? 255 : 0);
  Serial.print("x:"); Serial.print(x); Serial.print(" y:"); Serial.println(y);
  delay(50);
}
`,
  },
  {
    key: 'l298n', name: 'Motor speed and direction (L298N, 9 V battery)',
    components: [esp, { id: 'drv1', type: 'l298n', x: 560, y: 230, props: {} },
      { id: 'mot1', type: 'motor', x: 470, y: 170, props: {} },
      { id: 'bat1', type: 'battery', x: 760, y: 380, props: { type: '9 V block', charge: 90, capacity: 500 } },
      { id: 'pot1', type: 'pot', x: 170, y: 340, props: { value: 0.7 } },
      { id: 'btn1', type: 'button', x: 160, y: 250, props: { color: 'blue' } }],
    wires: [W('drv1:OUT1', 'mot1:+'), W('drv1:OUT2', 'mot1:-'), W('bat1:+', 'drv1:12V', 'red'), W('bat1:-', 'drv1:GND', 'black'), W('drv1:GND', 'esp:GND.R', 'black'),
      W('esp:D25', 'drv1:ENA', 'purple'), W('esp:D26', 'drv1:IN1', 'yellow'), W('esp:D27', 'drv1:IN2', 'orange'),
      W('pot1:SIG', 'esp:D34'), W('pot1:VCC', 'esp:3V3'), W('pot1:GND', 'esp:GND.L'), W('btn1:1', 'esp:D14'), W('btn1:2', 'esp:GND.L', 'black')],
    code: `// The knob sets the speed (PWM on ENA), the button reverses the direction.
// The L298N's 5 V regulator and its ~2 V loss are simulated; the battery drains while the motor runs.
const int ENA = 25, IN1 = 26, IN2 = 27;
bool forward = true, lastBtn = HIGH;

void setup() {
  Serial.begin(115200);
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(14, INPUT_PULLUP);
}

void loop() {
  bool b = digitalRead(14);
  if (b == LOW && lastBtn == HIGH) { forward = !forward; Serial.println(forward ? "forward" : "reverse"); }
  lastBtn = b;
  digitalWrite(IN1, forward ? HIGH : LOW);
  digitalWrite(IN2, forward ? LOW : HIGH);
  analogWrite(ENA, map(analogRead(34), 0, 4095, 0, 255));
  delay(20);
}
`,
  },
  {
    key: 'bme280', name: 'Weather station: BME280 + OLED',
    components: [esp, { id: 'bme1', type: 'bme280', x: 600, y: 230, props: { model: 'BME280', addr: '0x76', temp: 23.4, hum: 48, pressure: 1009 } },
      { id: 'oled1', type: 'oled', x: 560, y: 10, props: { addr: '0x3C', color: 'white' } }],
    wires: [W('esp:3V3', 'bme1:VIN', 'red'), W('bme1:GND', 'esp:GND.R', 'black'), W('esp:D21', 'bme1:SDA', 'blue'), W('esp:D22', 'bme1:SCL', 'yellow'),
      W('esp:3V3', 'oled1:VCC', 'red'), W('oled1:GND', 'esp:GND.R', 'black'), W('esp:D21', 'oled1:SDA', 'blue'), W('esp:D22', 'oled1:SCL', 'yellow')],
    code: `// Two I2C devices on the same bus: a BME280 at 0x76 and an SSD1306 OLED at 0x3C.
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <Adafruit_SSD1306.h>

Adafruit_BME280 bme;
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  if (!bme.begin(0x76)) { Serial.println("BME280 not found"); while (true) delay(10); }
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  float t = bme.readTemperature(), h = bme.readHumidity(), p = bme.readPressure() / 100.0;
  display.clearDisplay();
  display.setTextSize(2); display.setCursor(0, 0);
  display.print(t, 1); display.println(" C");
  display.setTextSize(1); display.setCursor(0, 24);
  display.print("Humidity: "); display.print(h, 0); display.println(" %");
  display.print("Pressure: "); display.print(p, 0); display.println(" hPa");
  display.display();
  Serial.print("temp:"); Serial.print(t); Serial.print(" hum:"); Serial.println(h);
  delay(1000);
}
`,
  },
  {
    key: 'mpu6050', name: 'Tilt sensor (MPU6050) on the Serial Plotter',
    components: [esp, { id: 'imu1', type: 'mpu6050', x: 560, y: 230, props: { roll: 20, pitch: -10, spin: 0, temp: 26 } }],
    wires: [W('esp:3V3', 'imu1:VCC', 'red'), W('imu1:GND', 'esp:GND.R', 'black'), W('esp:D21', 'imu1:SDA', 'blue'), W('esp:D22', 'imu1:SCL', 'yellow')],
    code: `// Drag the tilt sliders and watch the Plotter tab.
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  if (!mpu.begin()) { Serial.println("MPU6050 not found"); while (true) delay(10); }
  mpu.setAccelerometerRange(MPU6050_RANGE_2_G);
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  Serial.print("ax:"); Serial.print(a.acceleration.x);
  Serial.print(" ay:"); Serial.print(a.acceleration.y);
  Serial.print(" az:"); Serial.println(a.acceleration.z);
  delay(50);
}
`,
  },
  {
    key: 'uno-lcd', name: 'Arduino Uno: 16×2 LCD (LiquidCrystal, parallel)',
    components: [{ id: 'uno', type: 'uno', x: 300, y: 80, props: {} },
      { id: 'lcd1', type: 'lcd_parallel', x: 330, y: -150, props: {} },
      { id: 'pot1', type: 'pot', x: 640, y: -120, props: { value: 0.1 } }, res('r1', 620, -20)],
    wires: [W('lcd1:VSS', 'uno:GND1', 'black'), W('lcd1:VDD', 'uno:5V', 'red'), W('lcd1:V0', 'pot1:SIG'), W('pot1:VCC', 'uno:5V', 'red'), W('pot1:GND', 'uno:GND2', 'black'),
      W('lcd1:RS', 'uno:D12'), W('lcd1:RW', 'uno:GND1', 'black'), W('lcd1:E', 'uno:D11'),
      W('lcd1:D4', 'uno:D5'), W('lcd1:D5', 'uno:D4'), W('lcd1:D6', 'uno:D3'), W('lcd1:D7', 'uno:D2'),
      W('lcd1:A', 'r1:1', 'red'), W('r1:2', 'uno:5V', 'red'), W('lcd1:K', 'uno:GND3', 'black')],
    code: `// The classic LiquidCrystal "Hello World". The pot on V0 sets the contrast: turn it up and the text fades.
#include <LiquidCrystal.h>

LiquidCrystal lcd(12, 11, 5, 4, 3, 2);

void setup() {
  lcd.begin(16, 2);
  lcd.print("hello, world!");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print(millis() / 1000);
  delay(200);
}
`,
  },
  {
    key: 'encoder-7seg', name: 'Rotary encoder counts on a 7-segment digit',
    components: [esp, { id: 'enc1', type: 'encoder', x: 140, y: 330, props: {} },
      { id: 'seg1', type: 'seg7', x: 660, y: 120, props: { common: 'cathode' } },
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s, i) => res(`r${s}`, 500, 40 + i * 30, 330))],
    wires: [W('enc1:VCC', 'esp:3V3', 'red'), W('enc1:GND', 'esp:GND.L', 'black'), W('enc1:CLK', 'esp:D32'), W('enc1:DT', 'esp:D33'), W('enc1:SW', 'esp:D25'),
      W('seg1:COM', 'esp:GND.R', 'black'),
      ...[['a', 'D23'], ['b', 'D22'], ['c', 'D21'], ['d', 'D19'], ['e', 'D18'], ['f', 'D5'], ['g', 'D4']].flatMap(([s, p]) => [W(`esp:${p}`, `r${s}:1`), W(`r${s}:2`, `seg1:${s}`)])],
    code: `// Turn the encoder (click the right / left half of the knob) to count 0-9, push it to reset.
// The count is updated in an interrupt on CLK, like most encoder tutorials.
const int SEG[7] = {23, 22, 21, 19, 18, 5, 4};           // a b c d e f g
const byte DIGITS[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
volatile int count = 0;

void IRAM_ATTR onClk() {
  if (digitalRead(33) == HIGH) count++; else count--;
}

void show(int n) {
  for (int i = 0; i < 7; i++) digitalWrite(SEG[i], (DIGITS[n] >> i) & 1);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 7; i++) pinMode(SEG[i], OUTPUT);
  pinMode(32, INPUT); pinMode(33, INPUT); pinMode(25, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(32), onClk, FALLING);
}

void loop() {
  if (digitalRead(25) == LOW) count = 0;
  int n = ((count % 10) + 10) % 10;
  show(n);
  delay(20);
}
`,
  },
  {
    key: 'env-modules', name: 'Sound, soil moisture and gas sensor modules',
    components: [esp, { id: 'mic1', type: 'sound', x: 560, y: 220, props: { level: 0.2, threshold: 0.6 } },
      { id: 'soil1', type: 'soil', x: 660, y: 220, props: { moisture: 0.4, threshold: 0.5 } },
      { id: 'gas1', type: 'mq2', x: 160, y: 330, props: { gas: 0.1, threshold: 0.5 } }],
    wires: [W('mic1:VCC', 'esp:3V3', 'red'), W('mic1:GND', 'esp:GND.R', 'black'), W('mic1:AO', 'esp:D34'), W('mic1:DO', 'esp:D23'),
      W('soil1:VCC', 'esp:3V3', 'red'), W('soil1:GND', 'esp:GND.R', 'black'), W('soil1:AO', 'esp:D35'), W('soil1:DO', 'esp:D22'),
      W('gas1:VCC', 'esp:3V3', 'red'), W('gas1:GND', 'esp:GND.L', 'black'), W('gas1:AO', 'esp:D32'), W('gas1:DO', 'esp:D33')],
    code: `// Three LM393 sensor modules: AO is analog, DO goes LOW past each module's trimmer threshold.
// Drag their sliders and watch the Plotter tab.
void setup() {
  Serial.begin(115200);
  pinMode(23, INPUT); pinMode(22, INPUT); pinMode(33, INPUT);
}

void loop() {
  Serial.print("sound:"); Serial.print(analogRead(34));
  Serial.print(" soil:"); Serial.print(analogRead(35));
  Serial.print(" gas:"); Serial.println(analogRead(32));
  if (digitalRead(23) == LOW) Serial.println("LOUD!");
  if (digitalRead(22) == LOW) Serial.println("soil is wet");
  if (digitalRead(33) == LOW) Serial.println("GAS ALARM");
  delay(200);
}
`,
  },
  {
    key: 'pnp', name: 'PNP transistor as a high-side switch',
    components: [esp, { id: 'q1', type: 'pnp', x: 560, y: 160, props: { spice: '' } }, res('rb', 470, 260, 1000), res('r1', 600, 280),
      led('led1', 690, 260, 'yellow')],
    wires: [W('q1:E', 'esp:3V3', 'red'), W('esp:D23', 'rb:1'), W('rb:2', 'q1:B'), W('q1:C', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.R', 'black')],
    code: `// A PNP switches the supply side of the load: base LOW = on, base HIGH (= emitter voltage) = off.
void setup() { pinMode(23, OUTPUT); }

void loop() {
  digitalWrite(23, LOW);  delay(700);   // LED on
  digitalWrite(23, HIGH); delay(700);   // LED off
}
`,
  },
];
