/* CatSim — example projects. ESP32 sits at (300, 80): left pins x=300, right pins x=450. */
import unoBlinkHex from './firmware/uno-blink.hex?raw';
import unoBlinkIno from './firmware/uno-blink.ino?raw';
import unoFadeHex from './firmware/uno-fade.hex?raw';
import unoFadeIno from './firmware/uno-fade.ino?raw';
import unoButtonHex from './firmware/uno-button.hex?raw';
import unoButtonIno from './firmware/uno-button.ino?raw';
import unoPotHex from './firmware/uno-pot.hex?raw';
import unoPotIno from './firmware/uno-pot.ino?raw';
  const esp = { id: 'esp', type: 'esp32', x: 300, y: 80, props: {} };
  const W = (from, to, color) => ({ from, to, ...(color ? { color } : {}) });
  const unoBoard = { id: 'uno', type: 'uno', x: 300, y: 80, props: {} };
  const unoLed = [
    { id: 'r1', type: 'resistor', x: 430, y: -60, props: { ohms: 220 } },
    { id: 'led1', type: 'led', x: 520, y: -130, props: { color: 'red' } },
  ];
  const unoLedWires = [W('uno:D9', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'uno:GND1')];

  export const EXAMPLES = [
    {
      key: 'blink', name: 'Blink (on-board + external LED)',
      components: [esp,
        { id: 'r1', type: 'resistor', x: 500, y: 120, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 600, y: 70, props: { color: 'green' } }],
      wires: [W('esp:D23', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.R')],
      code: `// Blink — GPIO2 drives the blue on-board LED, GPIO23 an external LED.
#define LED_ONBOARD 2
#define LED_EXT 23

void setup() {
  Serial.begin(115200);
  pinMode(LED_ONBOARD, OUTPUT);
  pinMode(LED_EXT, OUTPUT);
  Serial.println("ESP32 blink started");
}

void loop() {
  digitalWrite(LED_ONBOARD, HIGH);
  digitalWrite(LED_EXT, LOW);
  Serial.println("tick");
  delay(500);
  digitalWrite(LED_ONBOARD, LOW);
  digitalWrite(LED_EXT, HIGH);
  Serial.println("tock");
  delay(500);
}
`,
    },
    {
      key: 'button', name: 'Button → LED (interrupt)',
      components: [esp,
        { id: 'btn1', type: 'button', x: 520, y: 330, props: { color: 'blue' } },
        { id: 'r1', type: 'resistor', x: 500, y: 236, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 610, y: 180, props: { color: 'yellow' } }],
      wires: [W('esp:D15', 'btn1:1'), W('btn1:2', 'esp:GND.R'), W('esp:D4', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.R')],
      code: `// Press the blue button (click and hold it while the simulation runs).
// The button pulls GPIO15 to GND; INPUT_PULLUP keeps it HIGH otherwise.
const int BUTTON = 15;
const int LED = 4;

volatile int presses = 0;
bool ledOn = false;

void IRAM_ATTR onPress() {
  presses++;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(BUTTON), onPress, FALLING);
  Serial.println("Press the button!");
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, pressed ? HIGH : LOW);
  if (pressed != ledOn) {
    ledOn = pressed;
    Serial.printf("Button %s — total presses: %d\\n", pressed ? "DOWN" : "UP", presses);
  }
  delay(10);
}
`,
    },
    {
      key: 'pot', name: 'Potentiometer → PWM dimmer',
      components: [esp,
        { id: 'pot1', type: 'pot', x: 170, y: 340, props: { value: 0.35 } },
        { id: 'r1', type: 'resistor', x: 170, y: 196, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 110, y: 120, props: { color: 'red' } }],
      wires: [W('pot1:SIG', 'esp:D34'), W('pot1:VCC', 'esp:3V3'), W('pot1:GND', 'esp:GND.L'),
        W('esp:D25', 'r1:2'), W('r1:1', 'led1:A'), W('led1:C', 'esp:GND.L')],
      code: `// Turn the potentiometer (select it and drag the slider) to dim the LED.
// GPIO34 = ADC1 input (12-bit, 0..4095). GPIO25 = LEDC PWM output.
const int POT = 34;
const int LED = 25;

void setup() {
  Serial.begin(115200);
  ledcAttach(LED, 5000, 8);   // pin, frequency, resolution (ESP32 core 3.x)
}

void loop() {
  int raw = analogRead(POT);
  int duty = map(raw, 0, 4095, 0, 255);
  ledcWrite(LED, duty);
  float volts = raw * 3.3 / 4095.0;
  Serial.printf("raw=%4d  duty=%3d  %.2f V\\n", raw, duty, volts);
  delay(200);
}
`,
    },
    {
      key: 'weather', name: 'Weather station (DHT22 + LCD)',
      components: [esp,
        { id: 'dht1', type: 'dht22', x: 540, y: 330, props: { temp: 23.5, hum: 48 } },
        { id: 'lcd1', type: 'lcd', x: 560, y: 90, props: {} }],
      wires: [W('dht1:DATA', 'esp:D15'), W('dht1:VCC', 'esp:3V3'), W('dht1:GND', 'esp:GND.R'),
        W('lcd1:SDA', 'esp:D21'), W('lcd1:SCL', 'esp:D22'), W('lcd1:VCC', 'esp:3V3'), W('lcd1:GND', 'esp:GND.R')],
      code: `// DHT22 on GPIO15, 16x2 I2C LCD on SDA=21 / SCL=22.
// Select the DHT22 to change temperature and humidity.
#include <DHT.h>
#include <LiquidCrystal_I2C.h>

DHT dht(15, DHT22);
LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(115200);
  dht.begin();
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("CatSim Weather");
  delay(1000);
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("Failed to read from DHT sensor!");
    delay(2000);
    return;
  }
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Temp: ");
  lcd.print(t, 1);
  lcd.write(223);  // degree sign
  lcd.print("C");
  lcd.setCursor(0, 1);
  lcd.print("Hum:  ");
  lcd.print(h, 1);
  lcd.print(" %");
  Serial.printf("T=%.1f C  H=%.1f %%\\n", t, h);
  delay(2000);
}
`,
    },
    {
      key: 'servo', name: 'Servo controlled by a knob',
      components: [esp,
        { id: 'servo1', type: 'servo', x: 560, y: 180, props: {} },
        { id: 'pot1', type: 'pot', x: 170, y: 340, props: { value: 0.5 } }],
      wires: [W('servo1:SIG', 'esp:D18'), W('servo1:V+', 'esp:3V3'), W('servo1:GND', 'esp:GND.R'),
        W('pot1:SIG', 'esp:D35'), W('pot1:VCC', 'esp:3V3'), W('pot1:GND', 'esp:GND.L')],
      code: `// Servo on GPIO18 follows the potentiometer on GPIO35.
#include <ESP32Servo.h>

Servo servo;
int lastAngle = -1;

void setup() {
  Serial.begin(115200);
  servo.attach(18);
}

void loop() {
  int angle = map(analogRead(35), 0, 4095, 0, 180);
  if (abs(angle - lastAngle) > 1) {
    servo.write(angle);
    lastAngle = angle;
    Serial.print("Angle: ");
    Serial.println(angle);
  }
  delay(20);
}
`,
    },
    {
      key: 'mqtt', name: 'IoT: WiFi + MQTT telemetry & control',
      components: [esp,
        { id: 'dht1', type: 'dht22', x: 540, y: 330, props: { temp: 21.8, hum: 52 } },
        { id: 'r1', type: 'resistor', x: 500, y: 152, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 610, y: 100, props: { color: 'blue' } }],
      wires: [W('dht1:DATA', 'esp:D15'), W('dht1:VCC', 'esp:3V3'), W('dht1:GND', 'esp:GND.R'),
        W('esp:D19', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.R')],
      code: `// Connects to WiFi, publishes DHT22 readings over MQTT and listens for LED commands.
// Open the "IoT · MQTT" tab, then publish ON / OFF to catsim/esp32/led.
#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>

const char* ssid = "CatSim-Guest";
const char* password = "";
const char* mqttServer = "broker.catsim.local";

#define LED_PIN 19
DHT dht(15, DHT22);
WiFiClient espClient;
PubSubClient client(espClient);
unsigned long lastMsg = 0;

void callback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.print("Message on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(msg);
  if (msg == "ON") digitalWrite(LED_PIN, HIGH);
  if (msg == "OFF") digitalWrite(LED_PIN, LOW);
  client.publish("catsim/esp32/led/state", msg.c_str());
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("Connecting to MQTT...");
    if (client.connect("esp32-catsim")) {
      Serial.println(" connected");
      client.subscribe("catsim/esp32/led");
    } else {
      Serial.print(" failed, rc=");
      Serial.println(client.state());
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  dht.begin();
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  client.setServer(mqttServer, 1883);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();
  if (millis() - lastMsg > 3000) {
    lastMsg = millis();
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    client.publish("catsim/esp32/temperature", String(t, 1).c_str());
    client.publish("catsim/esp32/humidity", String(h, 1).c_str());
    Serial.printf("Published T=%.1f H=%.1f (RSSI %d dBm)\\n", t, h, WiFi.RSSI());
  }
  delay(10);
}
`,
    },
    {
      key: 'transistor', name: 'NPN transistor drives an LED from 5 V',
      components: [esp,
        { id: 'q1', type: 'npn', x: 150, y: 380, props: {} },
        { id: 'rb', type: 'resistor', x: 200, y: 206, props: { ohms: 1000 } },
        { id: 'rl', type: 'resistor', x: 120, y: 330, props: { ohms: 150 } },
        { id: 'led1', type: 'led', x: 40, y: 230, props: { color: 'blue' } }],
      wires: [W('esp:D25', 'rb:2'), W('rb:1', 'q1:B'), W('q1:E', 'esp:GND.L'), W('esp:VIN', 'rl:2', '#ff4d4d'), W('rl:1', 'led1:A'), W('led1:C', 'q1:C')],
      code: `// A 2N2222 NPN transistor switches a blue LED from the 5 V rail (VIN).
// A blue LED needs about 3 V, which a 3.3 V GPIO can barely drive through a resistor.
// The transistor lets a small GPIO current (through the 1 kΩ base resistor) control a
// bigger current from another supply. Try the Scope tab on q1.C and the D25 net.
const int BASE = 25;

void setup() {
  Serial.begin(115200);
  pinMode(BASE, OUTPUT);
}

void loop() {
  digitalWrite(BASE, HIGH);
  Serial.println("transistor on");
  delay(700);
  digitalWrite(BASE, LOW);
  Serial.println("transistor off");
  delay(700);
}
`,
    },
    {
      key: 'nightlight', name: 'Op-amp night light (LM358 comparator)',
      components: [esp,
        { id: 'u1', type: 'opamp', x: 90, y: 120, props: {} },
        { id: 'ldr1', type: 'ldr', x: 30, y: 300, props: { light: 0.6 } },
        { id: 'pot1', type: 'pot', x: 140, y: 300, props: { value: 0.7 } },
        { id: 'r1', type: 'resistor', x: 170, y: 40, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 250, y: -20, props: { color: 'yellow' } },
        { id: 'r2', type: 'resistor', x: 190, y: 130, props: { ohms: 10000 } },
        { id: 'r3', type: 'resistor', x: 200, y: 250, props: { ohms: 10000 } }],
      wires: [W('esp:VIN', 'u1:VCC', '#ff4d4d'), W('u1:GND', 'esp:GND.L'),
        W('esp:3V3', 'ldr1:VCC', '#ff4d4d'), W('ldr1:GND', 'esp:GND.L'), W('ldr1:AO', 'u1:IN-'), W('ldr1:AO', 'esp:D35'),
        W('esp:3V3', 'pot1:VCC', '#ff4d4d'), W('pot1:GND', 'esp:GND.L'), W('pot1:SIG', 'u1:IN+'),
        W('u1:OUT', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.L'),
        W('u1:OUT', 'r2:1'), W('r2:2', 'esp:D34'), W('esp:D34', 'r3:1'), W('r3:2', 'esp:GND.L')],
      code: `// Night light: the LM358 op-amp compares the light sensor (IN−) with the knob (IN+).
// When the light drops below the threshold set by the knob, the op-amp output swings
// high and lights the LED. That part is pure analog: no code involved.
// Select the light sensor and lower its light level, or turn the knob.
// The ESP32 only reports what the circuit is doing.
const int SENSOR = 35;  // light sensor output
const int OPAMP = 34;   // op-amp output through a 10k/10k divider

void setup() {
  Serial.begin(115200);
}

void loop() {
  float sensor = analogRead(SENSOR) * 3.3 / 4095.0;
  float out = analogRead(OPAMP) * 3.3 / 4095.0 * 2;
  Serial.printf("sensor %.2f V -> op-amp output %.2f V (%s)\\n", sensor, out, out > 2 ? "LED on" : "LED off");
  delay(500);
}
`,
    },
    {
      key: 'noresistor', name: 'What happens without a resistor? (LED burnout)',
      components: [esp,
        { id: 'led1', type: 'led', x: 520, y: 210, props: { color: 'red' } },
        { id: 'r1', type: 'resistor', x: 500, y: 330, props: { ohms: 220 } },
        { id: 'led2', type: 'led', x: 600, y: 280, props: { color: 'red' } }],
      wires: [W('esp:D2', 'led1:A'), W('led1:C', 'esp:GND.R'), W('esp:D15', 'r1:1'), W('r1:2', 'led2:A'), W('led2:C', 'esp:GND.R')],
      code: `// led1 is wired straight to GPIO2 with no resistor, so only the pin's own ~30 Ω
// limits the current: around 40 mA, more than an LED (20–30 mA) or a GPIO (40 mA)
// can take. Watch led1 burn out and read the Console. led2 has a 220 Ω resistor and lives.
void setup() {
  pinMode(2, OUTPUT);
  pinMode(15, OUTPUT);
  digitalWrite(2, HIGH);
  digitalWrite(15, HIGH);
}

void loop() {
  delay(100);
}
`,
    },
    {
      key: 'shiftreg', name: '74HC595 shift register: 8 LEDs from 3 pins',
      components: [esp,
        { id: 'u1', type: 'hc595', x: 520, y: 400, props: {} },
        { id: 'r1', type: 'resistor', x: 700, y: 372, props: { ohms: 220 } },
        { id: 'r2', type: 'resistor', x: 700, y: 398, props: { ohms: 220 } },
        { id: 'r3', type: 'resistor', x: 700, y: 424, props: { ohms: 220 } },
        { id: 'r4', type: 'resistor', x: 700, y: 450, props: { ohms: 220 } },
        { id: 'r5', type: 'resistor', x: 700, y: 476, props: { ohms: 220 } },
        { id: 'r6', type: 'resistor', x: 700, y: 502, props: { ohms: 220 } },
        { id: 'r7', type: 'resistor', x: 700, y: 528, props: { ohms: 220 } },
        { id: 'r8', type: 'resistor', x: 700, y: 554, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 820, y: 250, props: { color: 'red' } },
        { id: 'led2', type: 'led', x: 860, y: 250, props: { color: 'red' } },
        { id: 'led3', type: 'led', x: 900, y: 250, props: { color: 'red' } },
        { id: 'led4', type: 'led', x: 940, y: 250, props: { color: 'red' } },
        { id: 'led5', type: 'led', x: 980, y: 250, props: { color: 'red' } },
        { id: 'led6', type: 'led', x: 1020, y: 250, props: { color: 'red' } },
        { id: 'led7', type: 'led', x: 1060, y: 250, props: { color: 'red' } },
        { id: 'led8', type: 'led', x: 1100, y: 250, props: { color: 'red' } },
      ],
      wires: [W('esp:3V3', 'u1:VCC', '#ff4d4d'), W('u1:GND', 'esp:GND.R'), W('u1:OE', 'esp:GND.R'), W('u1:SRCLR', 'esp:3V3', '#ff4d4d'),
        W('esp:D23', 'u1:SER'), W('esp:D18', 'u1:SRCLK'), W('esp:D5', 'u1:RCLK'),
        W('u1:Q0', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.R'), W('u1:Q1', 'r2:1'), W('r2:2', 'led2:A'), W('led2:C', 'esp:GND.R'), W('u1:Q2', 'r3:1'), W('r3:2', 'led3:A'), W('led3:C', 'esp:GND.R'), W('u1:Q3', 'r4:1'), W('r4:2', 'led4:A'), W('led4:C', 'esp:GND.R'), W('u1:Q4', 'r5:1'), W('r5:2', 'led5:A'), W('led5:C', 'esp:GND.R'), W('u1:Q5', 'r6:1'), W('r6:2', 'led6:A'), W('led6:C', 'esp:GND.R'), W('u1:Q6', 'r7:1'), W('r7:2', 'led7:A'), W('led7:C', 'esp:GND.R'), W('u1:Q7', 'r8:1'), W('r8:2', 'led8:A'), W('led8:C', 'esp:GND.R')],
      code: `// 74HC595: three GPIOs drive eight LEDs.
// shiftOut() clocks 8 bits into the chip (SER + SRCLK), then a pulse on RCLK copies them
// to the outputs all at once. The chip runs on 3.3 V so that the ESP32's 3.3 V signals are
// valid logic levels (powered from 5 V, a 74HC would need 3.5 V on its inputs).
const int DATA = 23, CLOCK = 18, LATCH = 5;
int pos = 0, dir = 1;

void setup() {
  pinMode(DATA, OUTPUT);
  pinMode(CLOCK, OUTPUT);
  pinMode(LATCH, OUTPUT);
}

void loop() {
  digitalWrite(LATCH, LOW);
  shiftOut(DATA, CLOCK, MSBFIRST, 1 << pos);
  digitalWrite(LATCH, HIGH);
  pos += dir;
  if (pos == 7 || pos == 0) dir = -dir;
  delay(120);
}
`,
    },
    {
      key: 'timer555', name: '555 timer blinker (no code needed)',
      components: [esp,
        { id: 'u1', type: 'ne555', x: 110, y: 150, props: {} },
        { id: 'r1', type: 'resistor', x: 20, y: 60, props: { ohms: 10000 } },
        { id: 'r2', type: 'resistor', x: 140, y: 80, props: { ohms: 47000 } },
        { id: 'c1', type: 'capacitor', x: 230, y: 120, props: { value: '10µF' } },
        { id: 'r3', type: 'resistor', x: 40, y: 260, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 20, y: 300, props: { color: 'green' } },
        { id: 'r4', type: 'resistor', x: 150, y: 260, props: { ohms: 10000 } },
        { id: 'r5', type: 'resistor', x: 170, y: 330, props: { ohms: 20000 } }],
      wires: [W('esp:VIN', 'u1:VCC', '#ff4d4d'), W('u1:GND', 'esp:GND.L'), W('u1:RESET', 'esp:VIN', '#ff4d4d'),
        W('esp:VIN', 'r1:1', '#ff4d4d'), W('r1:2', 'u1:DISCH'), W('u1:DISCH', 'r2:1'), W('r2:2', 'u1:THRES'), W('u1:THRES', 'u1:TRIG'),
        W('u1:THRES', 'c1:+'), W('c1:-', 'esp:GND.L'),
        W('u1:OUT', 'r3:2'), W('r3:1', 'led1:A'), W('led1:C', 'esp:GND.L'),
        W('u1:OUT', 'r4:1'), W('r4:2', 'esp:D34'), W('esp:D34', 'r5:1'), W('r5:2', 'esp:GND.L')],
      code: `// NE555 astable blinker. The blinking needs no code: R1, R2 and C set the rate,
// f = 1.44 / ((R1 + 2·R2) · C) ≈ 1.4 Hz. Try other values for r2 or c1.
// Scope tip: probe the capacitor (c1.+) to see it swing between 1/3 and 2/3 of VCC.
// The ESP32 only measures the frequency, through a 10k/20k divider (5 V → 3.3 V).
const int IN = 34;
int last = 0;
unsigned long lastRise = 0;

void setup() {
  Serial.begin(115200);
  pinMode(IN, INPUT);
}

void loop() {
  int v = digitalRead(IN);
  if (v && !last) {
    unsigned long now = millis();
    if (lastRise) Serial.printf("period %lu ms (%.2f Hz)\\n", now - lastRise, 1000.0 / (now - lastRise));
    lastRise = now;
  }
  last = v;
  delay(2);
}
`,
    },
    // ---------- Arduino Uno: real compiled firmware (see src/firmware/) ----------
    {
      key: 'uno-blink', name: 'Arduino Uno: Blink (real firmware)',
      components: [unoBoard, ...unoLed],
      wires: [...unoLedWires],
      code: unoBlinkIno, firmware: { name: 'uno-blink.ino.hex', hex: unoBlinkHex },
    },
    {
      key: 'uno-fade', name: 'Arduino Uno: Fade (hardware PWM)',
      components: [unoBoard, ...unoLed],
      wires: [...unoLedWires],
      code: unoFadeIno, firmware: { name: 'uno-fade.ino.hex', hex: unoFadeHex },
    },
    {
      key: 'uno-button', name: 'Arduino Uno: Button + LED',
      components: [unoBoard, ...unoLed, { id: 'btn1', type: 'button', x: 600, y: -60, props: { color: 'blue' } }],
      wires: [...unoLedWires, W('uno:D2', 'btn1:1'), W('btn1:2', 'uno:GND1')],
      code: unoButtonIno, firmware: { name: 'uno-button.ino.hex', hex: unoButtonHex },
    },
    {
      key: 'uno-pot', name: 'Arduino Uno: Pot → ADC → PWM',
      components: [unoBoard, ...unoLed, { id: 'pot1', type: 'pot', x: 440, y: 300, props: { value: 0.4 } }],
      wires: [...unoLedWires, W('uno:5V', 'pot1:VCC', '#ff4d4d'), W('pot1:GND', 'uno:GND3'), W('pot1:SIG', 'uno:A0')],
      code: unoPotIno, firmware: { name: 'uno-pot.ino.hex', hex: unoPotHex },
    },
    {
      key: 'motor', name: 'DC motor speed control (MOSFET + PWM)',
      components: [esp,
        { id: 'mot1', type: 'motor', x: 110, y: 120, props: {} },
        { id: 'q1', type: 'nmos', x: 160, y: 300, props: {} },
        { id: 'd1', type: 'diode', x: 120, y: 240, props: { model: '1N4007' } }],
      wires: [W('esp:D26', 'q1:G'), W('q1:S', 'esp:GND.L'), W('esp:VIN', 'mot1:+', '#ff4d4d'), W('mot1:-', 'q1:D'),
        W('mot1:-', 'd1:A'), W('d1:K', 'esp:VIN', '#ff4d4d')],
      code: `// The 2N7000 MOSFET switches the motor from the 5 V rail; PWM on its gate sets the speed.
// A GPIO can't power a motor directly (it needs far more than 40 mA), and the 1N4007
// flyback diode catches the voltage spike the motor's coil makes each time it switches off.
// Try deleting d1 and watch the Console. Scope tip: probe mot1.- to see the PWM and the clamp.
const int GATE = 26;

void setup() {
  Serial.begin(115200);
  // 200 Hz keeps this simulation real-time; real motor drivers often use 1–20 kHz (quieter),
  // which works here too but runs slower: every edge needs fine steps to follow the coil current.
  ledcAttach(GATE, 200, 8);
}

void loop() {
  for (int duty = 0; duty <= 255; duty += 15) { ledcWrite(GATE, duty); Serial.printf("duty %d%%\\n", duty * 100 / 255); delay(250); }
  for (int duty = 255; duty >= 0; duty -= 15) { ledcWrite(GATE, duty); delay(150); }
}
`,
    },
    {
      key: 'relay', name: 'Relay switches two LEDs (NO / NC)',
      components: [esp,
        { id: 'rb', type: 'resistor', x: 480, y: 192, props: { ohms: 1000 } },
        { id: 'q1', type: 'npn', x: 560, y: 330, props: {} },
        { id: 'k1', type: 'relay', x: 640, y: 330, props: {} },
        { id: 'd1', type: 'diode', x: 650, y: 450, props: { model: '1N4007' } },
        { id: 'r1', type: 'resistor', x: 760, y: 470, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 860, y: 380, props: { color: 'green' } },
        { id: 'r2', type: 'resistor', x: 760, y: 520, props: { ohms: 220 } },
        { id: 'led2', type: 'led', x: 910, y: 380, props: { color: 'red' } }],
      wires: [W('esp:D18', 'rb:1'), W('rb:2', 'q1:B'), W('q1:E', 'esp:GND.R'),
        W('esp:VIN', 'k1:C1', '#ff4d4d'), W('k1:C2', 'q1:C'), W('k1:C2', 'd1:A'), W('d1:K', 'esp:VIN', '#ff4d4d'),
        W('esp:3V3', 'k1:COM', '#ff4d4d'), W('k1:NO', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'esp:GND.R'),
        W('k1:NC', 'r2:1'), W('r2:2', 'led2:A'), W('led2:C', 'esp:GND.R')],
      code: `// A relay is a switch moved by an electromagnet: the 70 Ω coil needs ~70 mA from 5 V,
// so an NPN transistor drives it, and a flyback diode protects the transistor.
// COM connects to NC (red LED) at rest and to NO (green LED) when the coil is energised.
const int COIL = 18;

void setup() {
  Serial.begin(115200);
  pinMode(COIL, OUTPUT);
}

void loop() {
  digitalWrite(COIL, HIGH);
  Serial.println("relay on: COM -> NO (green)");
  delay(1000);
  digitalWrite(COIL, LOW);
  Serial.println("relay off: COM -> NC (red)");
  delay(1000);
}
`,
    },
    {
      key: 'traffic', name: 'Traffic light',
      components: [esp,
        { id: 'r1', type: 'resistor', x: 500, y: 100, props: { ohms: 220 } },
        { id: 'r2', type: 'resistor', x: 500, y: 140, props: { ohms: 220 } },
        { id: 'r3', type: 'resistor', x: 500, y: 180, props: { ohms: 220 } },
        { id: 'red', type: 'led', x: 640, y: 30, props: { color: 'red' } },
        { id: 'yellow', type: 'led', x: 700, y: 30, props: { color: 'yellow' } },
        { id: 'green', type: 'led', x: 760, y: 30, props: { color: 'green' } }],
      wires: [W('esp:D23', 'r1:1'), W('esp:D22', 'r2:1'), W('esp:D21', 'r3:1'),
        W('r1:2', 'red:A'), W('r2:2', 'yellow:A'), W('r3:2', 'green:A'),
        W('red:C', 'esp:GND.R'), W('yellow:C', 'esp:GND.R'), W('green:C', 'esp:GND.R')],
      code: `// Classic traffic light using an array of pins and an enum.
int pins[] = {23, 22, 21};
enum Phase { RED, RED_YELLOW, GREEN, YELLOW };
Phase phase = RED;

void show(bool r, bool y, bool g) {
  digitalWrite(pins[0], r);
  digitalWrite(pins[1], y);
  digitalWrite(pins[2], g);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) pinMode(pins[i], OUTPUT);
}

void loop() {
  switch (phase) {
    case RED:        show(1, 0, 0); Serial.println("RED");    delay(3000); phase = RED_YELLOW; break;
    case RED_YELLOW: show(1, 1, 0); Serial.println("READY");  delay(800);  phase = GREEN;      break;
    case GREEN:      show(0, 0, 1); Serial.println("GO");     delay(3000); phase = YELLOW;     break;
    case YELLOW:     show(0, 1, 0); Serial.println("SLOW");   delay(1000); phase = RED;        break;
  }
}
`,
    },
    {
      key: 'alarm', name: 'PIR motion alarm + buzzer',
      components: [esp,
        { id: 'pir1', type: 'pir', x: 160, y: 330, props: { motion: false } },
        { id: 'bz1', type: 'buzzer', x: 560, y: 220, props: {} }],
      wires: [W('pir1:OUT', 'esp:D27'), W('pir1:VCC', 'esp:VIN'), W('pir1:GND', 'esp:GND.L'),
        W('bz1:+', 'esp:D5'), W('bz1:-', 'esp:GND.R')],
      code: `// Select the PIR sensor and toggle "Motion detected" to trigger the siren.
const int PIR = 27;
const int BUZZER = 5;
int lastState = LOW;

void setup() {
  Serial.begin(115200);
  pinMode(PIR, INPUT);
  Serial.println("Alarm armed");
}

void loop() {
  int motion = digitalRead(PIR);
  if (motion != lastState) {
    Serial.println(motion ? "Motion detected!" : "All clear");
    lastState = motion;
  }
  if (motion == HIGH) {
    for (int f = 600; f < 1400; f += 40) { tone(BUZZER, f); delay(8); }
    for (int f = 1400; f > 600; f -= 40) { tone(BUZZER, f); delay(8); }
  } else {
    noTone(BUZZER);
    delay(50);
  }
}
`,
    },
    {
      key: 'http', name: 'HTTP GET from the internet',
      components: [esp],
      wires: [],
      code: `// Real HTTPS request from the simulator (the server must allow CORS).
#include <WiFi.h>
#include <HTTPClient.h>

void setup() {
  Serial.begin(115200);
  WiFi.begin("CatSim-Guest", "");
  while (WiFi.status() != WL_CONNECTED) { delay(200); Serial.print("."); }
  Serial.println(" WiFi OK");
}

void loop() {
  HTTPClient http;
  http.begin("https://api.github.com/zen");
  int code = http.GET();
  if (code > 0) {
    Serial.printf("HTTP %d: ", code);
    Serial.println(http.getString());
  } else {
    Serial.println("Request failed: " + http.errorToString(code));
  }
  http.end();
  delay(10000);
}
`,
    },
  ];
