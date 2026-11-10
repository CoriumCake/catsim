/* CatSim — the real size of each module, from its datasheet or vendor drawing.
 * 1 diagram unit = 0.254 mm (0.01"); the header pins sit on the 2.54 mm (10 unit) grid.
 * Each entry gives the footprint (w × h) and the pin positions: [x, y, side]. Pin ids and behaviour don't change.
 * The 2D drawing of a part is scaled into its new footprint, so its live displays keep working. */

// pins in a row (or column): ids, the first pin's position, the step between pins
const row = (ids, x0, y0, side, dx = 10, dy = 0) => Object.fromEntries(ids.map((id, i) => [id, [x0 + i * dx, y0 + i * dy, side]]));

export const REAL_SIZES = {
  // HD44780 16×2 character LCD: 80 × 36 mm board, 16-pin header along the top edge
  lcd_parallel: { w: 315, h: 142, pins: row(['VSS', 'VDD', 'V0', 'RS', 'RW', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'A', 'K'], 83, 0, 't') },
  // GY-521 MPU-6050 breakout: 21 × 16 mm, 8-pin header along the bottom edge
  mpu6050: { w: 84, h: 63, pins: row(['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'], 7, 63, 'b') },
  // BME280 breakout: 4-pin header, 16 × 18 mm board
  bme280: { w: 64, h: 70, pins: row(['VIN', 'GND', 'SCL', 'SDA'], 17, 70, 'b') },
  // WS2812B 5050 strip: 8 LEDs on a 53 mm strip, 10 mm wide
  ws2812_strip: { w: 212, h: 40, pins: { VCC: [0, 8, 'l'], DIN: [0, 20, 'l'], GND: [0, 32, 'l'] } },
  // NeoPixel ring: 16 × WS2812B, 44.5 mm outer diameter
  ws2812_ring: { w: 176, h: 176, pins: row(['VCC', 'DIN', 'GND'], 78, 176, 'b') },
  // TM1637 4-digit 0.36" display module: 42 × 24 mm, 4-pin header on one short edge
  tm1637: { w: 165, h: 94, pins: row(['CLK', 'DIO', 'VCC', 'GND'], 165, 30, 'r', 0, 10) },
  // DS3231 RTC (ZS-042 board): 38 × 22 mm, 6-pin header along one long edge
  ds3231: { w: 150, h: 87, pins: row(['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'], 0, 20, 'l', 0, 10) },
  // 4×4 membrane keypad: about 69 × 76 mm, 8-pin ribbon header
  keypad: { w: 272, h: 300, pins: row(['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'], 101, 300, 'b') },
  // 28BYJ-48 motor (Ø28 mm, 19 mm tall) beside a ULN2003 driver board (35 × 25 mm)
  stepper: { w: 270, h: 110, pins: row(['IN1', 'IN2', 'IN3', 'IN4', 'GND', 'VCC'], 124, 110, 'b') },
  // a 0.56" 10-pin seven-segment digit: five pins on each side, 2.54 mm apart
  seg7: { w: 60, h: 96, pins: { ...row(['g', 'f', 'COM', 'a', 'b'], 10, 0, 't'), ...row(['e', 'd', 'COM2', 'c', 'dp'], 10, 96, 'b') } },
  // a 5 mm RGB LED: four legs on 2.54 mm
  rgb_led: { w: 44, h: 70, pins: row(['R', 'COM', 'G', 'B'], 7, 70, 'b') },
  // 1-cell slide switch: three pins on 2.54 mm
  slide_switch: { w: 56, h: 46, pins: row(['A', 'COM', 'B'], 18, 46, 'b') },
  // 9 V battery block: 48.5 × 26.5 mm
  battery: { w: 192, h: 104, pins: { '+': [0, 26, 'l'], '-': [0, 78, 'l'] } },
  // FSR 402: Ø18.5 mm sensing disc with a tail and two pins
  fsr: { w: 74, h: 100, pins: { 1: [32, 100, 'b'], 2: [42, 100, 'b'] } },
  // 10 mm coin vibration motor
  vibmotor: { w: 44, h: 60, pins: { '+': [17, 60, 'b'], '-': [27, 60, 'b'] } },
  // TP4056 charger: 26 × 17 mm
  tp4056: { w: 103, h: 67, pins: { 'IN+': [0, 20, 'l'], 'IN-': [0, 30, 'l'], 'OUT+': [103, 20, 'r'], 'B+': [103, 30, 'r'], 'B-': [103, 40, 'r'], 'OUT-': [103, 50, 'r'] } },
  // a 2-axis thumb joystick module: 26 × 34 mm
  joystick: { w: 102, h: 134, pins: row(['GND', 'VCC', 'VRx', 'VRy', 'SW'], 26, 134, 'b') },
  // KY-040 rotary encoder: 18 × 31 mm
  encoder: { w: 72, h: 122, pins: row(['CLK', 'DT', 'SW', 'VCC', 'GND'], 16, 122, 'b') },
  // L298N motor driver: 43 × 43 mm
  l298n: { w: 169, h: 169, pins: { OUT1: [0, 50, 'l'], OUT2: [0, 65, 'l'], OUT3: [169, 50, 'r'], OUT4: [169, 65, 'r'], ...row(['12V', 'GND', '5V', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'], 45, 169, 'b') } },
  // KY-038 sound sensor: 35 × 15 mm
  sound: { w: 138, h: 59, pins: row(['AO', 'GND', 'VCC', 'DO'], 44, 59, 'b') },
  // soil moisture control board (YL-38): 30 × 15 mm
  soil: { w: 118, h: 59, pins: row(['VCC', 'GND', 'DO', 'AO'], 44, 59, 'b') },
  // MQ-2 gas sensor board: 32 × 22 mm
  mq2: { w: 126, h: 87, pins: row(['VCC', 'GND', 'DO', 'AO'], 44, 87, 'b') },
  // ESP32-C3 Super Mini: 22.5 × 18 mm, 8 pins on each long side
  esp32c3: { w: 71, h: 88, pins: { ...row(['IO5', 'IO6', 'IO7', 'IO8', 'IO9', 'IO10', 'IO20', 'IO21'], 0, 9, 'l', 0, 10), ...row(['5V', 'GND', '3V3', 'IO4', 'IO3', 'IO2', 'IO1', 'IO0'], 71, 9, 'r', 0, 10) } },
};

/** Put every part in REAL_SIZES at its real size, with its pins at their real positions. */
export function applyRealSizes(defs) {
  for (const [type, s] of Object.entries(REAL_SIZES)) {
    const d = defs[type];
    if (!d) throw new Error(`no part ${type}`);
    const ow = d.w, oh = d.h;
    d.pins = d.pins.map((p) => {
      const q = s.pins[p.id];
      if (!q) throw new Error(`${type}: no real position for pin ${p.id}`);
      return { ...p, x: q[0], y: q[1], dir: q[2] };
    });
    d.w = s.w; d.h = s.h;
    const render = d.render;
    if (render && (ow !== s.w || oh !== s.h)) {
      d.render = function (c, st) {
        return `<g transform="scale(${(s.w / ow).toFixed(4)} ${(s.h / oh).toFixed(4)})">${render.call(this, c, st)}</g>`;
      };
    }
  }
}
