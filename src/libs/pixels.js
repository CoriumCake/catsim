/* Addressable RGB LEDs (WS2812B): Adafruit_NeoPixel and FastLED.
 * The strip parts are GRB on the wire, like real WS2812B: a sketch that sends another color order
 * shows swapped colors, as it would on the bench. */
import { callable, partsOn } from './util.js';

const STRIPS = ['ws2812_strip', 'ws2812_ring'];
const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(+v || 0)));
const GAMMA = Array.from({ length: 256 }, (_, i) => Math.round(Math.pow(i / 255, 2.6) * 255));

/** Send pixel data to every strip whose DIN is on `pin`. `wire(i)` gives the 3 bytes sent for pixel i. */
function pushStrip(sim, pin, n, wire) {
  const parts = STRIPS.flatMap((t) => partsOn(sim, pin, t, 'DIN'));
  if (!parts.length) sim.warnOnce('px' + pin, `LED strip: nothing is wired from GPIO${pin} to a strip's DIN pin.`);
  for (const c of parts) {
    if (!sim.powered(c)) { sim.warnOnce('pxp' + c.id, `LED strip: ${c.id} has no power — wire VCC (5 V) and GND.`); continue; }
    const count = c.type === 'ws2812_ring' ? 16 : 8;
    const rgb = [];
    for (let i = 0; i < count; i++) {
      if (i >= n) { rgb.push(0); continue; }
      const [g, r, b] = wire(i); // the strip reads G, R, B
      rgb.push((clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b));
    }
    sim.dev[c.id] = { kind: 'pixels', rgb };
  }
}

export function pixelLibs({ sim, gpioCheck, sleep, check }) {
  // ---------- Adafruit_NeoPixel ----------
  class Adafruit_NeoPixel {
    constructor(n = 0, pin = 6, type = 0x52) { this.n = Math.max(0, +n | 0); this.pin = +pin; this.type = +type; this.px = new Array(this.n).fill(0); this.bright = 0; }
    begin() { gpioCheck(this.pin, 'Adafruit_NeoPixel'); sim.mode[this.pin] = 1; }
    updateLength(n) { this.n = Math.max(0, +n | 0); this.px = new Array(this.n).fill(0); }
    updateType(t) { this.type = +t; }
    setPin(p) { this.pin = +p; }
    numPixels() { return this.n; }
    setPixelColor(i, r, g, b, w) {
      i = Math.trunc(i); if (i < 0 || i >= this.n) return;
      this.px[i] = g === undefined ? (+r >>> 0) : (((clamp8(w) << 24) | (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)) >>> 0);
    }
    getPixelColor(i) { return this.px[Math.trunc(i)] ?? 0; }
    fill(c = 0, first = 0, count = 0) {
      const end = count ? Math.min(this.n, first + count) : this.n;
      for (let i = Math.max(0, first); i < end; i++) this.px[i] = c >>> 0;
    }
    clear() { this.px.fill(0); }
    setBrightness(b) { this.bright = (clamp8(b) + 1) & 0xff; }
    getBrightness() { return (this.bright - 1) & 0xff; }
    canShow() { return true; }
    show() {
      const t = this.type, ro = (t >> 4) & 3, go = (t >> 2) & 3, bo = t & 3;
      const scale = (v) => (this.bright ? (v * this.bright) >> 8 : v);
      pushStrip(sim, this.pin, this.n, (i) => {
        const c = this.px[i]; const bytes = [0, 0, 0, 0];
        bytes[ro] = scale((c >> 16) & 0xff); bytes[go] = scale((c >> 8) & 0xff); bytes[bo] = scale(c & 0xff);
        return bytes;
      });
    }
    rainbow(first = 0, reps = 1, sat = 255, bright = 255, gammify = true) {
      for (let i = 0; i < this.n; i++) {
        const hue = (first + Math.trunc((i * reps * 65536) / this.n)) & 0xffff;
        const c = Adafruit_NeoPixel.ColorHSV(hue, sat, bright);
        this.px[i] = gammify ? Adafruit_NeoPixel.gamma32(c) : c;
      }
    }
    static Color(r, g, b, w) { return w === undefined ? ((clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)) >>> 0 : ((clamp8(w) << 24) | (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)) >>> 0; }
    static ColorHSV(hue = 0, sat = 255, val = 255) {
      hue = Math.trunc(((hue & 0xffff) * 1530 + 32768) / 65536); let r, g, b;
      if (hue < 510) { b = 0; if (hue < 255) { r = 255; g = hue; } else { r = 510 - hue; g = 255; } }
      else if (hue < 1020) { r = 0; if (hue < 765) { g = 255; b = hue - 510; } else { g = 1020 - hue; b = 255; } }
      else if (hue < 1530) { g = 0; if (hue < 1275) { r = hue - 1020; b = 255; } else { r = 255; b = 1530 - hue; } }
      else { r = 255; g = 0; b = 0; }
      const v1 = 1 + clamp8(val), s1 = 1 + clamp8(sat), s2 = 255 - clamp8(sat);
      return ((((((r * s1) >> 8) + s2) * v1) & 0xff00) << 8 | (((((g * s1) >> 8) + s2) * v1) & 0xff00) | (((((b * s1) >> 8) + s2) * v1) >> 8)) >>> 0;
    }
    static gamma8(x) { return GAMMA[clamp8(x)]; }
    static gamma32(c) { return ((GAMMA[(c >>> 24) & 0xff] << 24) | (GAMMA[(c >> 16) & 0xff] << 16) | (GAMMA[(c >> 8) & 0xff] << 8) | GAMMA[c & 0xff]) >>> 0; }
    static sine8(x) { return Math.min(255, Math.round(128 + 127.5 * Math.sin(((x & 0xff) / 256) * 2 * Math.PI))); }
  }
  for (const k of ['Color', 'ColorHSV', 'gamma8', 'gamma32', 'sine8']) Adafruit_NeoPixel.prototype[k] = Adafruit_NeoPixel[k];

  // ---------- FastLED ----------
  class CHSV {
    constructor(h = 0, s = 0, v = 0) { this.h = clamp8(h); this.s = clamp8(s); this.v = clamp8(v); }
    get hue() { return this.h; } set hue(x) { this.h = clamp8(x); }
    get sat() { return this.s; } set sat(x) { this.s = clamp8(x); }
    get val() { return this.v; } set val(x) { this.v = clamp8(x); }
  }
  /** FastLED's "rainbow" hue wheel is close to a plain HSV wheel; this uses HSV with hue 0–255. */
  const hsv2rgb = (h, s, v) => {
    const hh = ((h & 0xff) / 256) * 6, i = Math.floor(hh), f = hh - i;
    const S = s / 255, V = v, p = V * (1 - S), q = V * (1 - S * f), t = V * (1 - S * (1 - f));
    const [r, g, b] = [[V, t, p], [q, V, p], [p, V, t], [p, q, V], [t, p, V], [V, p, q]][i % 6];
    return [clamp8(r), clamp8(g), clamp8(b)];
  };
  class CRGB {
    constructor(r = 0, g, b) {
      if (r instanceof CRGB) { this.r = r.r; this.g = r.g; this.b = r.b; return; }
      if (r instanceof CHSV) { [this.r, this.g, this.b] = hsv2rgb(r.h, r.s, r.v); return; }
      if (g === undefined) { const c = +r >>> 0; this.r = (c >> 16) & 0xff; this.g = (c >> 8) & 0xff; this.b = c & 0xff; return; }
      this.r = clamp8(r); this.g = clamp8(g); this.b = clamp8(b);
    }
    get red() { return this.r; } set red(v) { this.r = clamp8(v); }
    get green() { return this.g; } set green(v) { this.g = clamp8(v); }
    get blue() { return this.b; } set blue(v) { this.b = clamp8(v); }
    setRGB(r, g, b) { this.r = clamp8(r); this.g = clamp8(g); this.b = clamp8(b); return this; }
    setHSV(h, s, v) { [this.r, this.g, this.b] = hsv2rgb(h, s, v); return this; }
    setHue(h) { return this.setHSV(h, 255, 255); }
    setColorCode(c) { return Object.assign(this, new CRGB(c)); }
    nscale8(s) { const k = (clamp8(s) + 1) / 256; this.r = Math.floor(this.r * k); this.g = Math.floor(this.g * k); this.b = Math.floor(this.b * k); return this; }
    nscale8_video(s) { return this.nscale8(s); }
    fadeToBlackBy(f) { return this.nscale8(255 - clamp8(f)); }
    fadeLightBy(f) { return this.nscale8(255 - clamp8(f)); }
    maximizeBrightness() { const m = Math.max(this.r, this.g, this.b); if (m) { const k = 255 / m; this.r = clamp8(this.r * k); this.g = clamp8(this.g * k); this.b = clamp8(this.b * k); } return this; }
    getLuma() { return Math.round(this.r * 0.21 + this.g * 0.72 + this.b * 0.07); }
    getAverageLight() { return Math.round((this.r + this.g + this.b) / 3); }
    valueOf() { return (this.r << 16) | (this.g << 8) | this.b; }
    toString() { return `CRGB(${this.r}, ${this.g}, ${this.b})`; }
  }
  const NAMED = {
    Black: 0x000000, White: 0xffffff, Red: 0xff0000, Green: 0x008000, Lime: 0x00ff00, Blue: 0x0000ff, Yellow: 0xffff00, Cyan: 0x00ffff, Aqua: 0x00ffff,
    Magenta: 0xff00ff, Fuchsia: 0xff00ff, Purple: 0x800080, Orange: 0xffa500, Pink: 0xffc0cb, Gold: 0xffd700, Gray: 0x808080, Grey: 0x808080,
    Navy: 0x000080, Teal: 0x008080, Violet: 0xee82ee, Brown: 0xa52a2a, Maroon: 0x800000, Olive: 0x808000, Silver: 0xc0c0c0, DarkBlue: 0x00008b,
    DarkGreen: 0x006400, DarkRed: 0x8b0000, DeepPink: 0xff1493, HotPink: 0xff69b4, Indigo: 0x4b0082, LightBlue: 0xadd8e6, SkyBlue: 0x87ceeb,
    Coral: 0xff7f50, Crimson: 0xdc143c, Turquoise: 0x40e0d0, OrangeRed: 0xff4500, Chartreuse: 0x7fff00, Amethyst: 0x9966cc, Salmon: 0xfa8072,
    Tomato: 0xff6347, FairyLight: 0xffe42d, Plaid: 0xcc5533, Seashell: 0xfff5ee, Snow: 0xfffafa, Wheat: 0xf5deb3,
  };
  for (const [k, v] of Object.entries(NAMED)) Object.defineProperty(CRGB, k, { get: () => new CRGB(v), enumerable: true });
  const toRGB = (c) => (c instanceof CRGB ? c : c instanceof CHSV ? new CRGB(c) : typeof c === 'number' ? new CRGB(c) : new CRGB(0));

  const controllers = [];
  let brightness = 255;
  const ORDERS = { RGB: [0, 1, 2], RBG: [0, 2, 1], GRB: [1, 0, 2], GBR: [2, 0, 1], BRG: [1, 2, 0], BGR: [2, 1, 0] };
  const FastLED = {
    addLeds(targs, leds, n = leds ? leds.length : 0, offset = 0) {
      const a = Array.isArray(targs) ? targs : [];
      const pin = typeof a[1] === 'number' ? a[1] : NaN;
      // clockless chips (WS2812B, NEOPIXEL…) default to RGB order unless given; NEOPIXEL means GRB
      const order = typeof a[2] === 'string' ? a[2] : a[0] === 'NEOPIXEL' ? 'GRB' : 'RGB';
      if (Number.isFinite(pin)) gpioCheck(pin, 'FastLED.addLeds');
      else sim.warnOnce('fl-pin', 'FastLED.addLeds: give the data pin as the second template argument, e.g. addLeds<WS2812B, 5, GRB>(leds, NUM_LEDS).');
      const ctl = { pin, order, leds, n: Math.max(0, +n | 0), offset: +offset | 0, setCorrection() { return ctl; }, setTemperature() { return ctl; }, setDither() { return ctl; }, setRgbw() { return ctl; } };
      controllers.push(ctl);
      return ctl;
    },
    show(scale) {
      const b = scale === undefined ? brightness : clamp8(scale);
      for (const ctl of controllers) {
        if (!Number.isFinite(ctl.pin)) continue;
        const ord = ORDERS[ctl.order] || ORDERS.RGB;
        pushStrip(sim, ctl.pin, ctl.n, (i) => {
          const c = toRGB(ctl.leds[ctl.offset + i]); const k = (b + 1) / 256;
          const rgb = [c.r * k, c.g * k, c.b * k].map(Math.floor);
          // the sketch's color order says where each channel goes on the wire
          const out = [0, 0, 0]; out[ord[0]] = rgb[0]; out[ord[1]] = rgb[1]; out[ord[2]] = rgb[2];
          return out;
        });
      }
    },
    clear(write = false) { for (const ctl of controllers) for (let i = 0; i < ctl.n; i++) { const p = ctl.leds[ctl.offset + i]; if (p instanceof CRGB) p.setRGB(0, 0, 0); else ctl.leds[ctl.offset + i] = new CRGB(0); } if (write) FastLED.show(); },
    clearData() { FastLED.clear(false); },
    async delay(ms) { FastLED.show(); check(); await sleep(+ms || 0); check(); },
    showColor(c, scale) { const col = toRGB(c); for (const ctl of controllers) for (let i = 0; i < ctl.n; i++) ctl.leds[ctl.offset + i] = new CRGB(col); FastLED.show(scale); },
    setBrightness(b) { brightness = clamp8(b); }, getBrightness() { return brightness; },
    setMaxPowerInVoltsAndMilliamps() {}, setMaxPowerInMilliWatts() {}, setCorrection() {}, setTemperature() {}, setDither() {}, setMaxRefreshRate() {},
    countFPS() {}, getFPS() { return 60; }, size() { return controllers[0] ? controllers[0].n : 0; }, count() { return controllers.length; },
    leds() { return controllers[0] ? controllers[0].leds : null; },
  };

  const scale8 = (i, s) => (clamp8(i) * (1 + clamp8(s))) >> 8;
  const sin8 = (x) => clamp8(128 + 127.5 * Math.sin(((x & 0xff) / 256) * 2 * Math.PI));
  const sin16 = (x) => Math.round(32767 * Math.sin(((x & 0xffff) / 65536) * 2 * Math.PI));
  const r8 = (a, b) => (a === undefined ? Math.floor(Math.random() * 256) : b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a)));
  const r16 = (a, b) => (a === undefined ? Math.floor(Math.random() * 65536) : b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a)));
  const beat = (bpm, tb = 0) => ((sim.millis() - tb) * bpm * 65536) / 60000; // 16-bit phase
  const fns = {
    fill_solid(leds, n, c) { const col = toRGB(c); for (let i = 0; i < n; i++) leds[i] = new CRGB(col); },
    fill_rainbow(leds, n, hue = 0, delta = 5) { for (let i = 0; i < n; i++) leds[i] = new CRGB(new CHSV((hue + i * delta) & 0xff, 240, 255)); },
    fill_gradient_RGB(leds, a, b, c, d) {
      // (leds, n, c1, c2) or (leds, startpos, startcolor, endpos, endcolor)
      let s = 0, e, c1, c2;
      if (d === undefined) { e = a - 1; c1 = toRGB(b); c2 = toRGB(c); } else { s = a; c1 = toRGB(b); e = c; c2 = toRGB(d); }
      for (let i = s; i <= e; i++) { const t = e === s ? 0 : (i - s) / (e - s); leds[i] = new CRGB(c1.r + (c2.r - c1.r) * t, c1.g + (c2.g - c1.g) * t, c1.b + (c2.b - c1.b) * t); }
    },
    fadeToBlackBy(leds, n, f) { for (let i = 0; i < n; i++) if (leds[i] instanceof CRGB) leds[i].fadeToBlackBy(f); },
    fadeLightBy(leds, n, f) { fns.fadeToBlackBy(leds, n, f); },
    nscale8(leds, n, s) { for (let i = 0; i < n; i++) if (leds[i] instanceof CRGB) leds[i].nscale8(s); },
    blur1d(leds, n, amount) {
      const keep = 255 - amount, seep = amount >> 1; let carry = new CRGB(0);
      for (let i = 0; i < n; i++) {
        const cur = new CRGB(toRGB(leds[i])); const part = new CRGB(cur).nscale8(seep); cur.nscale8(keep);
        cur.r = clamp8(cur.r + carry.r); cur.g = clamp8(cur.g + carry.g); cur.b = clamp8(cur.b + carry.b);
        if (i) { const p = toRGB(leds[i - 1]); leds[i - 1] = new CRGB(p.r + part.r, p.g + part.g, p.b + part.b); }
        leds[i] = cur; carry = part;
      }
    },
    hsv2rgb_rainbow(hsv, rgb) { const c = new CRGB(hsv); if (rgb) rgb.setRGB(c.r, c.g, c.b); return c; },
    hsv2rgb_spectrum(hsv, rgb) { return fns.hsv2rgb_rainbow(hsv, rgb); },
    random8: r8, random16: r16, random16_add_entropy() {}, random16_set_seed() {},
    scale8, scale8_video: scale8, sin8, cos8: (x) => sin8(x + 64), sin16, cos16: (x) => sin16(x + 16384),
    qadd8: (a, b) => Math.min(255, a + b), qsub8: (a, b) => Math.max(0, a - b), qmul8: (a, b) => Math.min(255, a * b),
    lerp8by8: (a, b, f) => clamp8(a + ((b - a) * f) / 256), map8: (x, lo, hi) => lo + scale8(x, hi - lo),
    ease8InOutQuad: (i) => { const j = i & 0x80 ? 255 - i : i; const jj = scale8(j, j) << 1; return i & 0x80 ? 255 - jj : jj; },
    triwave8: (i) => { i &= 0xff; return (i & 0x80 ? 255 - i : i) << 1 & 0xff; },
    beat8: (bpm, tb = 0) => Math.floor(beat(bpm, tb) / 256) & 0xff,
    beat16: (bpm, tb = 0) => Math.floor(beat(bpm, tb)) & 0xffff,
    beatsin8: (bpm, lo = 0, hi = 255, tb = 0, ph = 0) => lo + scale8(sin8((Math.floor(beat(bpm, tb) / 256) + ph) & 0xff), hi - lo),
    beatsin16: (bpm, lo = 0, hi = 65535, tb = 0, ph = 0) => lo + Math.floor(((sin16((Math.floor(beat(bpm, tb)) + ph) & 0xffff) + 32768) * (hi - lo)) / 65536),
    beatsin88: (bpm88, lo = 0, hi = 65535, tb = 0, ph = 0) => fns.beatsin16(bpm88 / 256, lo, hi, tb, ph),
  };

  return {
    Adafruit_NeoPixel: callable(Adafruit_NeoPixel),
    NEO_RGB: 0x06, NEO_RBG: 0x09, NEO_GRB: 0x52, NEO_GBR: 0xa1, NEO_BRG: 0x58, NEO_BGR: 0xa4,
    NEO_RGBW: 0xc6, NEO_GRBW: 0xd2, NEO_KHZ800: 0x0000, NEO_KHZ400: 0x0100,
    CRGB: callable(CRGB), CHSV: callable(CHSV), FastLED, ...fns,
    WS2812B: 'WS2812B', WS2812: 'WS2812', WS2811: 'WS2811', WS2813: 'WS2813', NEOPIXEL: 'NEOPIXEL', SK6812: 'SK6812', TM1809: 'TM1809', APA106: 'APA106',
    RGB: 'RGB', RBG: 'RBG', GRB: 'GRB', GBR: 'GBR', BRG: 'BRG', BGR: 'BGR',
    TypicalLEDStrip: 0xffb0f0, TypicalSMD5050: 0xffb0f0, UncorrectedColor: 0xffffff, Candle: 0xff9329, Tungsten100W: 0xffd6aa,
    HUE_RED: 0, HUE_ORANGE: 32, HUE_YELLOW: 64, HUE_GREEN: 96, HUE_AQUA: 128, HUE_BLUE: 160, HUE_PURPLE: 192, HUE_PINK: 224,
  };
}
