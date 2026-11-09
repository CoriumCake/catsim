/* Logic chips: real DIP pinouts plus their logic.
 *
 * A chip reads its inputs as logic levels (from node voltages, with thresholds relative to its own
 * supply) and returns output levels; the analog bridge turns outputs into driver sources. Chips with
 * analog comparators (the 555) also get the raw input voltages and supply their own thresholds. */

export type Level = 0 | 1;
/** 'z' = high impedance (output disabled / open drain released) */
export type Out = Level | 'z';

export interface ChipCtx {
  /** current logic level of an input pin (after hysteresis) */
  level(pin: string): Level;
  /** voltage of a pin relative to the chip's GND pin */
  v(pin: string): number;
  /** supply voltage (VCC − GND) */
  vcc: number;
}

export interface ChipDef {
  type: string;
  name: string;
  /** pin labels by pin number − 1 (DIP numbering) */
  pins: string[];
  vcc: string;
  gnd: string;
  inputs: string[];
  outputs: string[];
  /** outputs that can only pull low (open drain / open collector) */
  openDrain?: string[];
  /** output resistance in ohms (default 30, 74HC at 3.3–5 V) */
  rout?: number;
  /** override input thresholds [falling, rising] in volts (default 0.3·VCC / 0.7·VCC, 74HC) */
  thresholds?: (pin: string, ctx: ChipCtx) => [number, number] | null;
  /** extra internal elements needed (the 555's internal divider) are added by the analog model */
  init(): Record<string, unknown>;
  evaluate(ctx: ChipCtx, st: Record<string, unknown>): Record<string, Out>;
  hint?: string;
  /** a module with its own drawing (not a DIP chip in the Logic palette) */
  module?: boolean;
}

const gate = (type: string, name: string, op: (a: Level, b: Level) => Level, hint?: string): ChipDef => {
  // 14-pin quad gate, standard 74xx00 pinout (the 74HC02 NOR has outputs first; handled below)
  const pins = ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'];
  return {
    type, name, pins, vcc: 'VCC', gnd: 'GND', hint,
    inputs: ['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'],
    outputs: ['1Y', '2Y', '3Y', '4Y'],
    init: () => ({}),
    evaluate: (c) => Object.fromEntries([1, 2, 3, 4].map((g) => [`${g}Y`, op(c.level(`${g}A`), c.level(`${g}B`))])),
  };
};

const NOR_PINS = ['1Y', '1A', '1B', '2Y', '2A', '2B', 'GND', '3A', '3B', '3Y', '4A', '4B', '4Y', 'VCC'];

const inverter = (type: string, name: string, schmitt: boolean): ChipDef => ({
  type, name, vcc: 'VCC', gnd: 'GND',
  pins: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'],
  inputs: ['1A', '2A', '3A', '4A', '5A', '6A'],
  outputs: ['1Y', '2Y', '3Y', '4Y', '5Y', '6Y'],
  // 74HC14 Schmitt trigger: wide hysteresis (≈ 0.33·VCC … 0.55·VCC)
  thresholds: schmitt ? (_p, c) => [0.33 * c.vcc, 0.55 * c.vcc] : undefined,
  init: () => ({}),
  evaluate: (c) => Object.fromEntries([1, 2, 3, 4, 5, 6].map((g) => [`${g}Y`, (c.level(`${g}A`) ? 0 : 1) as Level])),
  hint: schmitt ? 'Schmitt-trigger inputs: clean edges from slow or noisy signals (RC oscillators, debouncing).' : undefined,
});

export const CHIPS: Record<string, ChipDef> = {
  hc00: gate('hc00', '74HC00 quad NAND', (a, b) => (a && b ? 0 : 1)),
  hc02: { ...gate('hc02', '74HC02 quad NOR', (a, b) => (a || b ? 0 : 1)), pins: NOR_PINS },
  hc08: gate('hc08', '74HC08 quad AND', (a, b) => (a && b ? 1 : 0)),
  hc32: gate('hc32', '74HC32 quad OR', (a, b) => (a || b ? 1 : 0)),
  hc86: gate('hc86', '74HC86 quad XOR', (a, b) => (a !== b ? 1 : 0)),
  hc04: inverter('hc04', '74HC04 hex inverter', false),
  hc14: inverter('hc14', '74HC14 hex Schmitt inverter', true),

  hc74: {
    type: 'hc74', name: '74HC74 dual D flip-flop', vcc: 'VCC', gnd: 'GND',
    pins: ['1CLR', '1D', '1CLK', '1PRE', '1Q', '1Q̅', 'GND', '2Q̅', '2Q', '2PRE', '2CLK', '2D', '2CLR', 'VCC'],
    inputs: ['1CLR', '1D', '1CLK', '1PRE', '2CLR', '2D', '2CLK', '2PRE'],
    outputs: ['1Q', '1Q̅', '2Q', '2Q̅'],
    hint: 'Rising-edge D flip-flops. PRE and CLR are active low: tie them to VCC for normal use.',
    init: () => ({ q1: 0, q2: 0, clk1: 0, clk2: 0 }),
    evaluate(c, st) {
      const out: Record<string, Out> = {};
      for (const n of [1, 2]) {
        const clk = c.level(`${n}CLK`), pre = c.level(`${n}PRE`), clr = c.level(`${n}CLR`);
        let q = st[`q${n}`] as Level;
        if (clk && !st[`clk${n}`]) q = c.level(`${n}D`); // rising edge
        st[`clk${n}`] = clk;
        if (!pre || !clr) {
          // asynchronous: both low gives Q = Q̅ = HIGH on a real 74HC74
          st[`q${n}`] = !pre ? 1 : 0;
          out[`${n}Q`] = !pre ? 1 : 0; out[`${n}Q̅`] = !clr ? 1 : 0;
          continue;
        }
        st[`q${n}`] = q;
        out[`${n}Q`] = q; out[`${n}Q̅`] = q ? 0 : 1;
      }
      return out;
    },
  },

  hc595: {
    type: 'hc595', name: '74HC595 shift register', vcc: 'VCC', gnd: 'GND',
    pins: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND', "Q7'", 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'Q0', 'VCC'],
    inputs: ['SER', 'SRCLK', 'RCLK', 'OE', 'SRCLR'],
    outputs: ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', "Q7'"],
    hint: 'Serial in, 8 parallel outputs: shiftOut() on SER/SRCLK, then pulse RCLK (latch). OE low and SRCLR high to enable.',
    init: () => ({ sr: 0, latch: 0, srclk: 0, rclk: 0 }),
    evaluate(c, st) {
      let sr = st.sr as number, latch = st.latch as number;
      const srclk = c.level('SRCLK'), rclk = c.level('RCLK');
      if (!c.level('SRCLR')) sr = 0;
      else if (srclk && !st.srclk) sr = ((sr << 1) | c.level('SER')) & 0xff;
      if (rclk && !st.rclk) latch = sr;
      Object.assign(st, { sr, latch, srclk, rclk });
      const out: Record<string, Out> = {};
      const oe = c.level('OE') === 0;
      for (let i = 0; i < 8; i++) out[`Q${i}`] = oe ? (((latch >> i) & 1) as Level) : 'z';
      out["Q7'"] = ((sr >> 7) & 1) as Level;
      return out;
    },
  },

  cd4017: {
    type: 'cd4017', name: 'CD4017 decade counter', vcc: 'VCC', gnd: 'GND',
    pins: ['Q5', 'Q1', 'Q0', 'Q2', 'Q6', 'Q7', 'Q3', 'GND', 'Q8', 'Q4', 'Q9', 'CO', 'EN', 'CLK', 'RST', 'VCC'],
    inputs: ['CLK', 'EN', 'RST'],
    outputs: ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'CO'],
    rout: 400, // CMOS 4000 series outputs are weak
    hint: 'One of ten outputs goes high, advancing on each rising CLK edge. EN (clock inhibit) and RST to GND for normal use.',
    init: () => ({ n: 0, clk: 0 }),
    evaluate(c, st) {
      let n = st.n as number;
      const clk = c.level('CLK');
      if (c.level('RST')) n = 0;
      else if (clk && !st.clk && !c.level('EN')) n = (n + 1) % 10;
      st.n = n; st.clk = clk;
      const out: Record<string, Out> = {};
      for (let i = 0; i < 10; i++) out[`Q${i}`] = (i === n ? 1 : 0);
      out.CO = n < 5 ? 1 : 0;
      return out;
    },
  },

  ne555: {
    type: 'ne555', name: 'NE555 timer', vcc: 'VCC', gnd: 'GND',
    pins: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
    inputs: ['TRIG', 'THRES', 'RESET'],
    outputs: ['OUT', 'DISCH'],
    openDrain: ['DISCH'],
    rout: 10,
    hint: 'Comparators at 1/3 and 2/3 of VCC (set by the internal 5k-5k-5k divider at CTRL). Astable: R1 VCC→DISCH, R2 DISCH→THRES/TRIG, C to GND.',
    // the comparators compare TRIG with CTRL/2 and THRES with CTRL (single thresholds, no hysteresis)
    thresholds: (pin, c) => {
      if (pin === 'TRIG') { const t = c.v('CTRL') / 2; return [t, t]; }
      if (pin === 'THRES') { const t = c.v('CTRL'); return [t, t]; }
      return [0.4, 0.8]; // RESET: bipolar input, ~0.7 V threshold
    },
    init: () => ({ q: 0 }),
    evaluate(c, st) {
      let q = st.q as Level;
      const trigLow = c.v('TRIG') < c.v('CTRL') / 2, thresHigh = c.v('THRES') > c.v('CTRL');
      if (!c.level('RESET')) q = 0;
      else if (trigLow) q = 1; // trigger wins over threshold, as in the real chip
      else if (thresHigh) q = 0;
      st.q = q;
      return { OUT: q, DISCH: q ? 'z' : 0 };
    },
  },

  // L298N dual H-bridge module: IN1/IN2 set OUT1/OUT2 while ENA is high (OUT3/OUT4 from IN3/IN4 and ENB);
  // TTL inputs (≈ 2.3 V threshold, so 3.3 V logic works); the bipolar outputs lose ~2 V at 1 A
  l298n: {
    type: 'l298n', name: 'L298N motor driver', vcc: '12V', gnd: 'GND', module: true,
    pins: ['IN1', 'IN2', 'IN3', 'IN4', 'ENA', 'ENB', 'OUT1', 'OUT2', 'OUT3', 'OUT4', '12V', 'GND', '5V'],
    inputs: ['IN1', 'IN2', 'IN3', 'IN4', 'ENA', 'ENB'],
    outputs: ['OUT1', 'OUT2', 'OUT3', 'OUT4'],
    rout: 2,
    thresholds: () => [1.5, 2.3],
    init: () => ({}),
    evaluate(c) {
      const a = c.level('ENA'), b = c.level('ENB');
      return { OUT1: a ? c.level('IN1') : 'z', OUT2: a ? c.level('IN2') : 'z', OUT3: b ? c.level('IN3') : 'z', OUT4: b ? c.level('IN4') : 'z' };
    },
  },
};
