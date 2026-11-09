/* The Arduino libraries CatSim knows, merged into the sketch API.
 * Each library is a JS reimplementation of the real one's public API, wired to the simulated parts. */
import { displayLibs } from './display.js';
import { pixelLibs } from './pixels.js';
import { sensorLibs } from './sensors.js';
import { inputLibs } from './input.js';
import { jsonLibs } from './json.js';
import { storageLibs } from './storage.js';
import { motionLibs } from './motion.js';
import { moreLibs } from './more.js';
import { callable } from './util.js';

/** Headers a sketch may include: CatSim's libraries plus core headers that need nothing. */
export const KNOWN_HEADERS = new Set([
  'Arduino.h', 'Wire.h', 'SPI.h', 'WiFi.h', 'WiFiClient.h', 'WiFiClientSecure.h', 'HTTPClient.h', 'PubSubClient.h', 'DHT.h', 'DHT_U.h',
  'Adafruit_Sensor.h', 'ESP32Servo.h', 'Servo.h', 'LiquidCrystal_I2C.h', 'Adafruit_GFX.h', 'Adafruit_SSD1306.h', 'Adafruit_NeoPixel.h',
  'FastLED.h', 'TM1637Display.h', 'OneWire.h', 'DallasTemperature.h', 'NewPing.h', 'RTClib.h', 'Keypad.h', 'Bounce2.h', 'IRremote.h',
  'IRremote.hpp', 'Encoder.h', 'ESP32Encoder.h', 'ArduinoJson.h', 'Adafruit_BME280.h', 'Adafruit_BMP280.h', 'Adafruit_MPU6050.h', 'MPU6050.h', 'MPU6050_light.h', 'I2Cdev.h', 'LiquidCrystal.h', 'EEPROM.h', 'Preferences.h', 'Ticker.h', 'Stepper.h', 'AccelStepper.h',
  'math.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdint.h', 'stdbool.h', 'pgmspace.h', 'avr/pgmspace.h', 'Esp.h', 'esp_system.h', 'Print.h', 'Stream.h',
]);
export const LIBRARY_LIST = 'Adafruit SSD1306 + GFX, Adafruit NeoPixel, FastLED, TM1637Display, OneWire, DallasTemperature, NewPing, RTClib, Keypad, Bounce2, IRremote, Encoder, ESP32Encoder, Adafruit BME280/BMP280, Adafruit MPU6050, MPU6050, MPU6050_light, LiquidCrystal, ArduinoJson, EEPROM, Preferences, Ticker, Stepper, AccelStepper, DHT, ESP32Servo/Servo, LiquidCrystal_I2C, WiFi, PubSubClient, HTTPClient';

/** Libraries that need the ESP32 (they stop an Uno sketch with an explanation). */
export const ESP_ONLY_LIBS = ['Preferences', 'Ticker'];

export function createLibs(ctx) {
  const { sim } = ctx;
  const every = new Map();
  const storage = storageLibs(ctx);
  return {
    ...displayLibs(ctx), ...pixelLibs(ctx), ...sensorLibs(ctx), ...inputLibs(ctx), ...jsonLibs(ctx), ...motionLibs(ctx), ...moreLibs(ctx),
    EEPROM: storage.EEPROM, Preferences: callable(storage.Preferences),
    /** CRGB leds[8];  DateTime log[4] = {…}; */
    __objs(n, make, cls) {
      const a = Array.from({ length: Math.max(0, n | 0) }, (_, i) => { const v = make(i); return cls && v !== undefined && !(v instanceof cls) ? new cls(v) : v ?? (cls ? new cls() : 0); });
      if (!cls) return a;
      // value types copy on assignment, as in C++: leds[i] = 0xFF0000; leds[1] = leds[0];
      return new Proxy(a, { set(t, k, v) { t[k] = typeof k === 'string' && /^\d+$/.test(k) ? new cls(v) : v; return true; } });
    },
    /** DateTime d = now + TimeSpan(…);  CRGB c = 0xFF0000; */
    __cast: (cls, v) => (v instanceof cls ? v : new cls(v)),
    /** FastLED's EVERY_N_MILLISECONDS(ms) { … } */
    __every(id, ms) {
      const now = sim.millis(), last = every.get(id);
      if (last === undefined) { every.set(id, now); return false; }
      if (now - last >= ms) { every.set(id, now); return true; }
      return false;
    },
  };
}
