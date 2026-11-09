/* Displays: Adafruit_SSD1306 (+ Adafruit_GFX drawing and the classic 5×7 font) and TM1637Display. */
import { FONT5X7 } from './glcdfont.js';
import { callable, i2cParts, i2cCheck, partsOn, printMixin } from './util.js';

const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];

export function displayLibs({ sim, fmtValue, sprintf, gpioCheck }) {
  // ---------- Adafruit_GFX on a 1-bit SSD1306 buffer ----------
  class Adafruit_SSD1306 {
    constructor(w = 128, h = 64) {
      this.WIDTH = +w || 128; this.HEIGHT = +h || 64;
      this.buf = new Uint8Array((this.WIDTH * this.HEIGHT) >> 3);
      this.rot = 0; this.cx = 0; this.cy = 0; this.tsx = 1; this.tsy = 1; this.fg = 1; this.bg = 1; this.wrap = true; this.cp = false;
      this.inv = false; this.dimmed = false; this.on = true; this.addr = 0x3c; this.begun = false;
    }
    begin(vcs, addr = 0x3c) {
      this.addr = +addr || 0x3c; this.begun = true;
      i2cCheck(sim, 'oled', 'OLED');
      if (!this._parts().length) {
        sim.warnOnce('oled' + this.addr, `SSD1306: no OLED with address 0x${this.addr.toString(16).toUpperCase()} is wired to the I2C pins (SDA GPIO${sim.i2c.sda}, SCL GPIO${sim.i2c.scl}) — nothing will show.`);
      }
      return true; // like the real library: begin() only fails when the buffer can't be allocated
    }
    _parts() { return i2cParts(sim, 'oled').filter((c) => (+c.props.addr || 0x3c) === this.addr); }
    width() { return this.rot & 1 ? this.HEIGHT : this.WIDTH; }
    height() { return this.rot & 1 ? this.WIDTH : this.HEIGHT; }
    setRotation(r) { this.rot = (+r) & 3; } getRotation() { return this.rot; }
    drawPixel(x, y, c) {
      x = Math.trunc(x); y = Math.trunc(y);
      if (x < 0 || y < 0 || x >= this.width() || y >= this.height()) return;
      switch (this.rot) {
        case 1: [x, y] = [this.WIDTH - y - 1, x]; break;
        case 2: x = this.WIDTH - x - 1; y = this.HEIGHT - y - 1; break;
        case 3: [x, y] = [y, this.HEIGHT - x - 1]; break;
        default: break;
      }
      const i = x + (y >> 3) * this.WIDTH, m = 1 << (y & 7);
      if (c === 2) this.buf[i] ^= m; else if (c) this.buf[i] |= m; else this.buf[i] &= ~m;
    }
    getPixel(x, y) {
      if (x < 0 || y < 0 || x >= this.WIDTH || y >= this.HEIGHT) return false;
      return !!(this.buf[x + (y >> 3) * this.WIDTH] & (1 << (y & 7)));
    }
    clearDisplay() { this.buf.fill(0); this.cx = 0; this.cy = 0; }
    fillScreen(c) { this.buf.fill(c ? 0xff : 0); }
    display() {
      for (const c of this._parts()) {
        if (!sim.powered(c)) { sim.warnOnce('oledp' + c.id, `SSD1306: ${c.id} has no power — wire VCC and GND.`); continue; }
        sim.dev[c.id] = { kind: 'oled', w: this.WIDTH, h: this.HEIGHT, buf: this.buf.slice(), invert: this.inv, dim: this.dimmed, on: this.on };
      }
    }
    invertDisplay(i) { this.inv = !!i; this.display(); }
    dim(d) { this.dimmed = !!d; this.display(); }
    ssd1306_command(cmd) { if (cmd === 0xae) { this.on = false; this.display(); } else if (cmd === 0xaf) { this.on = true; this.display(); } }
    startscrollright() {} startscrollleft() {} startscrolldiagright() {} startscrolldiagleft() {} stopscroll() {}
    getBuffer() { return this.buf; }

    drawFastHLine(x, y, w, c) { for (let i = 0; i < w; i++) this.drawPixel(x + i, y, c); }
    drawFastVLine(x, y, h, c) { for (let i = 0; i < h; i++) this.drawPixel(x, y + i, c); }
    fillRect(x, y, w, h, c) { for (let i = 0; i < w; i++) this.drawFastVLine(x + i, y, h, c); }
    drawRect(x, y, w, h, c) { this.drawFastHLine(x, y, w, c); this.drawFastHLine(x, y + h - 1, w, c); this.drawFastVLine(x, y, h, c); this.drawFastVLine(x + w - 1, y, h, c); }
    drawLine(x0, y0, x1, y1, c) {
      x0 = Math.trunc(x0); y0 = Math.trunc(y0); x1 = Math.trunc(x1); y1 = Math.trunc(y1);
      const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
      if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
      if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      const dx = x1 - x0, dy = Math.abs(y1 - y0); let err = dx >> 1; const ys = y0 < y1 ? 1 : -1;
      for (; x0 <= x1; x0++) {
        if (steep) this.drawPixel(y0, x0, c); else this.drawPixel(x0, y0, c);
        err -= dy; if (err < 0) { y0 += ys; err += dx; }
      }
    }
    drawCircleHelper(x0, y0, r, corners, c) {
      let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
      while (x < y) {
        if (f >= 0) { y--; ddy += 2; f += ddy; }
        x++; ddx += 2; f += ddx;
        if (corners & 4) { this.drawPixel(x0 + x, y0 + y, c); this.drawPixel(x0 + y, y0 + x, c); }
        if (corners & 2) { this.drawPixel(x0 + x, y0 - y, c); this.drawPixel(x0 + y, y0 - x, c); }
        if (corners & 8) { this.drawPixel(x0 - y, y0 + x, c); this.drawPixel(x0 - x, y0 + y, c); }
        if (corners & 1) { this.drawPixel(x0 - y, y0 - x, c); this.drawPixel(x0 - x, y0 - y, c); }
      }
    }
    drawCircle(x0, y0, r, c) {
      this.drawPixel(x0, y0 + r, c); this.drawPixel(x0, y0 - r, c); this.drawPixel(x0 + r, y0, c); this.drawPixel(x0 - r, y0, c);
      this.drawCircleHelper(x0, y0, r, 15, c);
    }
    fillCircleHelper(x0, y0, r, corners, delta, c) {
      let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r, px = x, py = y;
      delta++;
      while (x < y) {
        if (f >= 0) { y--; ddy += 2; f += ddy; }
        x++; ddx += 2; f += ddx;
        if (x < y + 1) { if (corners & 1) this.drawFastVLine(x0 + x, y0 - y, 2 * y + delta, c); if (corners & 2) this.drawFastVLine(x0 - x, y0 - y, 2 * y + delta, c); }
        if (y !== py) { if (corners & 1) this.drawFastVLine(x0 + py, y0 - px, 2 * px + delta, c); if (corners & 2) this.drawFastVLine(x0 - py, y0 - px, 2 * px + delta, c); py = y; }
        px = x;
      }
    }
    fillCircle(x0, y0, r, c) { this.drawFastVLine(x0, y0 - r, 2 * r + 1, c); this.fillCircleHelper(x0, y0, r, 3, 0, c); }
    drawRoundRect(x, y, w, h, r, c) {
      const m = Math.min(w, h) >> 1; if (r > m) r = m;
      this.drawFastHLine(x + r, y, w - 2 * r, c); this.drawFastHLine(x + r, y + h - 1, w - 2 * r, c);
      this.drawFastVLine(x, y + r, h - 2 * r, c); this.drawFastVLine(x + w - 1, y + r, h - 2 * r, c);
      this.drawCircleHelper(x + r, y + r, r, 1, c); this.drawCircleHelper(x + w - r - 1, y + r, r, 2, c);
      this.drawCircleHelper(x + w - r - 1, y + h - r - 1, r, 4, c); this.drawCircleHelper(x + r, y + h - r - 1, r, 8, c);
    }
    fillRoundRect(x, y, w, h, r, c) {
      const m = Math.min(w, h) >> 1; if (r > m) r = m;
      this.fillRect(x + r, y, w - 2 * r, h, c);
      this.fillCircleHelper(x + w - r - 1, y + r, r, 1, h - 2 * r - 1, c);
      this.fillCircleHelper(x + r, y + r, r, 2, h - 2 * r - 1, c);
    }
    drawTriangle(x0, y0, x1, y1, x2, y2, c) { this.drawLine(x0, y0, x1, y1, c); this.drawLine(x1, y1, x2, y2, c); this.drawLine(x2, y2, x0, y0, c); }
    fillTriangle(x0, y0, x1, y1, x2, y2, c) {
      const pts = [[x0, y0], [x1, y1], [x2, y2]].sort((a, b) => a[1] - b[1]);
      const [[ax, ay], [bx, by], [cx, cy]] = pts;
      const edge = (y, xa, ya, xb, yb) => (yb === ya ? xa : xa + ((xb - xa) * (y - ya)) / (yb - ya));
      for (let y = ay; y <= cy; y++) {
        let xa = edge(y, ax, ay, cx, cy), xb = y < by ? edge(y, ax, ay, bx, by) : edge(y, bx, by, cx, cy);
        if (xa > xb) [xa, xb] = [xb, xa];
        this.drawFastHLine(Math.round(xa), y, Math.round(xb) - Math.round(xa) + 1, c);
      }
    }
    drawBitmap(x, y, bmp, w, h, c, bg) {
      const bw = (w + 7) >> 3;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const on = (bmp[j * bw + (i >> 3)] || 0) & (0x80 >> (i & 7));
        if (on) this.drawPixel(x + i, y + j, c); else if (bg !== undefined) this.drawPixel(x + i, y + j, bg);
      }
    }
    drawXBitmap(x, y, bmp, w, h, c) {
      const bw = (w + 7) >> 3;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((bmp[j * bw + (i >> 3)] || 0) & (1 << (i & 7))) this.drawPixel(x + i, y + j, c);
    }

    // ---------- text (the classic 6×8 cell) ----------
    setCursor(x, y) { this.cx = Math.trunc(x); this.cy = Math.trunc(y); }
    getCursorX() { return this.cx; } getCursorY() { return this.cy; }
    setTextSize(sx, sy) { this.tsx = Math.max(1, Math.trunc(sx) || 1); this.tsy = Math.max(1, Math.trunc(sy ?? sx) || 1); }
    setTextColor(c, bg) { this.fg = c; this.bg = bg === undefined ? c : bg; }
    setTextWrap(w) { this.wrap = !!w; }
    cp437(x = true) { this.cp = !!x; }
    setFont() {}
    drawChar(x, y, ch, c, bg, sx = 1, sy = sx) {
      if (x >= this.width() || y >= this.height() || x + 6 * sx - 1 < 0 || y + 8 * sy - 1 < 0) return;
      if (!this.cp && ch >= 176) ch++; // the classic font skips a glyph, kept for compatibility
      ch &= 0xff;
      for (let i = 0; i < 5; i++) {
        let line = FONT5X7[ch * 5 + i];
        for (let j = 0; j < 8; j++, line >>= 1) {
          if (line & 1) { if (sx === 1 && sy === 1) this.drawPixel(x + i, y + j, c); else this.fillRect(x + i * sx, y + j * sy, sx, sy, c); }
          else if (bg !== c) { if (sx === 1 && sy === 1) this.drawPixel(x + i, y + j, bg); else this.fillRect(x + i * sx, y + j * sy, sx, sy, bg); }
        }
      }
      if (bg !== c) { if (sx === 1 && sy === 1) this.drawFastVLine(x + 5, y, 8, bg); else this.fillRect(x + 5 * sx, y, sx, 8 * sy, bg); }
    }
    _out(s) {
      for (const chr of s) {
        let code = chr.codePointAt(0); if (code > 255) code = 63; // '?'
        if (code === 10) { this.cx = 0; this.cy += this.tsy * 8; continue; }
        if (code === 13) continue;
        if (this.wrap && this.cx + this.tsx * 6 > this.width()) { this.cx = 0; this.cy += this.tsy * 8; }
        this.drawChar(this.cx, this.cy, code, this.fg, this.bg, this.tsx, this.tsy);
        this.cx += this.tsx * 6;
      }
    }
    /** getTextBounds(str, x, y, &x1, &y1, &w, &h): the transpiler turns the out-parameters into [x1, y1, w, h] = … */
    getTextBounds(str, x, y) {
      const s = fmtValue(str); let cx = x, cy = y, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const chr of s) {
        if (chr === '\n') { cx = 0; cy += this.tsy * 8; continue; } if (chr === '\r') continue;
        if (this.wrap && cx + this.tsx * 6 > this.width()) { cx = 0; cy += this.tsy * 8; }
        minx = Math.min(minx, cx); miny = Math.min(miny, cy); maxx = Math.max(maxx, cx + this.tsx * 6 - 1); maxy = Math.max(maxy, cy + this.tsy * 8 - 1);
        cx += this.tsx * 6;
      }
      return maxx < minx ? [x, y, 0, 0] : [minx, miny, maxx - minx + 1, maxy - miny + 1];
    }
  }
  printMixin(Adafruit_SSD1306.prototype, fmtValue, sprintf);

  // ---------- TM1637Display (Avishay Orpaz) ----------
  class TM1637Display {
    constructor(clk, dio) { this.clk = +clk; this.dio = +dio; this.segs = [0, 0, 0, 0]; this.bright = 7; this.on = true; gpioCheck(this.clk, 'TM1637 CLK'); gpioCheck(this.dio, 'TM1637 DIO'); }
    _show() {
      const parts = partsOn(sim, this.clk, 'tm1637', 'CLK').filter((c) => sim.pinGpios(c, 'DIO').includes(this.dio));
      if (!parts.length) sim.warnOnce('tm' + this.clk, `TM1637: no display has CLK on GPIO${this.clk} and DIO on GPIO${this.dio} — check the wiring (CLK and DIO must not be swapped).`);
      for (const c of parts) {
        if (!sim.powered(c)) { sim.warnOnce('tmp' + c.id, `TM1637: ${c.id} has no power — wire VCC and GND.`); continue; }
        sim.dev[c.id] = { kind: 'seg7', segs: this.segs.slice(), bright: this.bright, on: this.on };
      }
    }
    setBrightness(b, on = true) { this.bright = Math.max(0, Math.min(7, (+b) & 7)); this.on = !!on; this._show(); }
    setSegments(segs, length = 4, pos = 0) {
      for (let i = 0; i < length && pos + i < 4; i++) this.segs[pos + i] = (+segs[i] || 0) & 0xff;
      this._show();
    }
    clear() { this.segs = [0, 0, 0, 0]; this._show(); }
    encodeDigit(d) { return SEG[(+d) & 0x0f]; }
    _number(base, num, dots, lead, length, pos) {
      let neg = false; if (base < 0) { base = -base; neg = true; }
      num = Math.trunc(Math.abs(num)); const digits = [];
      if (num === 0 && !lead) { for (let i = 0; i < length - 1; i++) digits[i] = 0; digits[length - 1] = SEG[0]; } else {
        for (let i = length - 1; i >= 0; --i) {
          const d = num % base;
          digits[i] = d === 0 && num === 0 && !lead ? 0 : SEG[d];
          if (d === 0 && num === 0 && neg) { digits[i] = 0x40; neg = false; }
          num = Math.trunc(num / base);
        }
      }
      if (dots) for (let i = 0; i < 4; i++) { if (i < length) digits[i] |= (dots & 0x80); dots <<= 1; }
      this.setSegments(digits, length, pos);
    }
    showNumberDec(num, lead = false, length = 4, pos = 0) { this.showNumberDecEx(num, 0, lead, length, pos); }
    showNumberDecEx(num, dots = 0, lead = false, length = 4, pos = 0) { this._number(num < 0 ? -10 : 10, num, dots, lead, length, pos); }
    showNumberHexEx(num, dots = 0, lead = false, length = 4, pos = 0) { this._number(16, num & 0xffff, dots, lead, length, pos); }
  }

  return {
    Adafruit_SSD1306: callable(Adafruit_SSD1306), TM1637Display: callable(TM1637Display),
    SSD1306_SWITCHCAPVCC: 0x02, SSD1306_EXTERNALVCC: 0x01, SSD1306_WHITE: 1, SSD1306_BLACK: 0, SSD1306_INVERSE: 2,
    WHITE: 1, BLACK: 0, INVERSE: 2, SSD1306_DISPLAYOFF: 0xae, SSD1306_DISPLAYON: 0xaf,
    SEG_A: 0x01, SEG_B: 0x02, SEG_C: 0x04, SEG_D: 0x08, SEG_E: 0x10, SEG_F: 0x20, SEG_G: 0x40, SEG_DP: 0x80,
  };
}
