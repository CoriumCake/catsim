/* Library class names shared by the transpiler (declarations) and the runtime (constructors).
 * A declaration of any of these — `T x;`, `T x(args);`, `T x = expr;`, `T x[N];` — becomes a JS object. */
export const LIB_CLASSES = [
  'Servo', 'DHT', 'PubSubClient', 'WiFiClient', 'WiFiClientSecure', 'HTTPClient', 'LiquidCrystal_I2C',
  // displays & lights
  'Adafruit_SSD1306', 'Adafruit_NeoPixel', 'CRGB', 'CHSV', 'TM1637Display',
  // sensors
  'OneWire', 'DallasTemperature', 'NewPing', 'RTC_DS3231', 'RTC_DS1307', 'DateTime', 'TimeSpan',
  // input
  'Keypad', 'Bounce', 'Bounce2.Button', 'IRrecv', 'decode_results', 'Encoder', 'ESP32Encoder',
  // utilities & motors
  'JsonDocument', 'StaticJsonDocument', 'DynamicJsonDocument', 'JsonObject', 'JsonArray', 'JsonVariant', 'DeserializationError',
  'Preferences', 'Ticker', 'Stepper', 'AccelStepper',
  // more sensors / displays
  'Adafruit_BME280', 'Adafruit_BMP280', 'Adafruit_MPU6050', 'sensors_event_t', 'MPU6050', 'LiquidCrystal',
];
/** `T x = expr;` converts the value to T (DateTime d = now + TimeSpan(…), CRGB c = 0xFF0000) */
export const LIB_VALUE_TYPES = ['DateTime', 'TimeSpan', 'CRGB'];
/** classes whose plain declaration (`T x;`) is an empty value, not a constructor call */
export const LIB_NULL_DECL = ['JsonObject', 'JsonArray', 'JsonVariant', 'DeserializationError'];
/** methods that wait (their calls are awaited) */
export const LIB_BLOCKING = ['step', 'runToPosition', 'runToNewPosition', 'waitForKey', 'requestTemperatures', 'requestTemperaturesByIndex', 'requestTemperaturesByAddress'];
