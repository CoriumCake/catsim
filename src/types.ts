/* CatSim — shared types. PartDef is the one format every part follows (see src/components.js). */

export interface Component {
  id: string;
  type: string;
  x: number;
  y: number;
  props: Record<string, unknown>;
}

export interface Wire {
  id: string;
  /** Pin reference "componentId:pinId" */
  from: string;
  to: string;
  color?: string;
}

export interface Project {
  name: string;
  code: string;
  components: Component[];
  wires: Wire[];
  /** 'tidy' = wires routed at right angles around parts; default: curves */
  wireStyle?: 'tidy' | 'curved';
  /** compiled firmware (Intel HEX) for boards that run machine code, e.g. the Arduino Uno */
  firmware?: { name: string; hex: string };
  /**
   * Programs of the second and further boards, by board id. The first board's program stays in
   * `code` / `firmware`, so single-board projects (and old share links) are unchanged.
   */
  programs?: Record<string, { code?: string; firmware?: { name: string; hex: string } }>;
}

/** Direction a wire leaves the pin: left, right, top, bottom. */
export type PinDir = 'l' | 'r' | 't' | 'b';

export interface PinDef {
  id: string;
  label: string;
  /** Position relative to the part's top-left corner, in diagram px. */
  x: number;
  y: number;
  dir: PinDir;
  title?: string;
  /** ESP32 board pins only */
  gpio?: number | null;
  kind?: 'gpio' | 'gnd' | 'vcc' | 'nc';
}

export type ControlDef =
  | { key: string; label: string; type: 'range'; min: number; max: number; step: number; fmt?: (v: number) => string }
  | { key: string; label: string; type: 'select'; options: Array<string | number> }
  | { key: string; label: string; type: 'toggle' }
  /** pasted SPICE .model / .subckt text that replaces the built-in model */
  | { key: string; label: string; type: 'spice'; maxLength: number; accepts: string };

/** The subset of the simulator a part's behaviour hooks may use. */
export interface SimView {
  running: boolean;
  ui: Record<string, { pressed?: boolean } | undefined>;
  mode: Record<number, number>;
  out: Record<number, number>;
  pwm: Record<number, number>;
  servo: Record<number, number>;
  tone: Record<number, number>;
  lcd: unknown;
  i2c: { sda: number; scl: number };
  pinLevel(c: Component, pinId: string): number | null;
  pinGpios(c: Component, pinId: string): number[];
}

export interface PartDef {
  type: string;
  name: string;
  category: string;
  /** Footprint in diagram px */
  w: number;
  h: number;
  pins: PinDef[];
  /** Default property values (validated against `controls` when loading projects) */
  props: Record<string, unknown>;
  controls?: ControlDef[];
  fixed?: boolean;
  /** a microcontroller board (exactly one per project) */
  board?: boolean;
  interactive?: 'press';
  hint?: string;
  // ---- electrical model (logic-level today; Phase 1 adds an analog model reference here) ----
  /** Pairs of this part's pins that are connected internally (resistor, pressed button…) */
  internal?: (c: Component, sim: SimView) => Array<[string, string]>;
  /** Pins this part drives to a logic level (0..1) */
  drive?: Record<string, (c: Component, sim: SimView) => number>;
  /** Pins that output an analog level (0..1 of 3.3 V) */
  analog?: Record<string, (c: Component, sim: SimView) => number>;
  // ---- visuals ----
  /** Live state derived from the simulator, passed to render() (and the 3D view) */
  state?: (c: Component, sim: SimView) => Record<string, unknown>;
  /** 2D SVG markup for the part body */
  render: (c: Component, s: Record<string, unknown>) => string;
}
