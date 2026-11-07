/* Arduino Uno: an ATmega328P emulated instruction by instruction (avr8js), running real compiled
 * firmware, coupled to the analog engine.
 *
 * - Every Uno pin is a Thevenin source in the circuit whose state comes from the chip's DDR/PORT
 *   registers, so PWM (the real timer hardware), millis(), Serial and interrupts all come from the
 *   Arduino core itself.
 * - Inputs are read back from node voltages (ATmega thresholds 0.3·VCC / 0.6·VCC) and the ADC samples
 *   the real voltage on A0–A5.
 * - Simulated time is the CPU's cycle count (16 MHz). The run loop paces it against the virtual clock;
 *   when emulation can't keep up, the deficit is taken out of simulated time (the clock stalls). */
import {
  CPU, avrInstruction, AVRTimer, timer0Config, timer1Config, timer2Config, AVRIOPort, portBConfig, portCConfig,
  portDConfig, AVRUSART, usart0Config, AVRADC, adcConfig, PinState,
} from 'avr8js';
import { parseIntelHex } from './hex.ts';
import { SimClock } from '../clock.ts';
import { AnalogBridge } from '../analog/bridge.ts';
import { dc } from '../analog/waveform.ts';
import type { Project } from '../types.ts';

export const F_CPU = 16e6;
const VCC = 5, VIL = 0.3 * VCC, VIH = 0.6 * VCC;
const R_OUT = 25, R_PULLUP = 35_000;

export interface UnoHost {
  readonly project: Project;
  log(msg: string, level?: string, line?: number): void;
  reportError(e: unknown): void;
  iotChanged(): void;
  onSimState(on: boolean): void;
  restartSim(): void;
}

/** Arduino pin number → port and bit. D0–D7 = PORTD, D8–D13 = PORTB0–5, A0–A5 (14–19) = PORTC0–5. */
function portOf(n: number): ['B' | 'C' | 'D', number] {
  if (n < 8) return ['D', n];
  if (n < 14) return ['B', n - 8];
  return ['C', n - 14];
}

export class UnoRunner {
  // fields shared with the ESP32 Simulator so the worker's snapshot code works for both
  running = false;
  ui: Record<string, { pressed?: boolean } | undefined> = {};
  mode: Record<number, number> = {}; out: Record<number, number> = {}; pwm: Record<number, number> = {};
  tone: Record<number, number> = {}; servo: Record<number, number> = {}; dac: Record<number, number> = {};
  ledcPin = {}; ledcCh = {}; lcd = null; i2c = { sda: 18, scl: 19 };
  wifi = { status: 0, ssid: '' };
  mqtt = { connected: false, clientId: '', host: '', subs: [] as string[], queue: [] as unknown[] };
  serialOut = '';
  txAt = 0;
  readonly clock = new SimClock();
  readonly analog: AnalogBridge;
  readonly board = { name: 'Arduino Uno', drive: (n: number) => this.drive(n) };

  private cpu!: CPU;
  private ports!: Record<'B' | 'C' | 'D', AVRIOPort>;
  private usart!: AVRUSART;
  private adc!: AVRADC;
  private rxQueue: number[] = [];
  private levels = new Map<number, boolean>();
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private inStep = false;

  constructor(readonly app: UnoHost) {
    this.analog = new AnalogBridge(this.bridgeState());
  }

  private bridgeState() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get app() { return self.app; }, get running() { return self.running; }, get ui() { return self.ui; },
      get mode() { return self.mode; }, get out() { return self.out; }, get pwm() { return self.pwm; }, get tone() { return self.tone; },
      get servo() { return self.servo; }, get dac() { return self.dac; }, get ledcPin() { return self.ledcPin; }, get ledcCh() { return self.ledcCh; },
      millis: () => self.millis(), board: self.board,
      // the run loop accounts for analog work itself, so the bridge must not stall the clock again
      clock: { stall: () => {} },
      } as unknown as ConstructorParameters<typeof AnalogBridge>[0];
  }

  /** Simulated time in ms (from the CPU cycle counter). */
  millis(): number { return this.cpu ? this.cpu.cycles / (F_CPU / 1000) : 0; }

  private drive(n: number) {
    const [p, bit] = portOf(n);
    const st = this.ports?.[p].pinState(bit);
    switch (st) {
      case PinState.High: return { wave: dc(VCC), rs: R_OUT, key: 'h' };
      case PinState.Low: return { wave: dc(0), rs: R_OUT, key: 'l' };
      case PinState.InputPullUp: return { wave: dc(VCC), rs: R_PULLUP, key: 'pu' };
      default: return { wave: dc(0), rs: 1e8, key: 'z' };
    }
  }

  /** Load firmware and start running. Returns false (after logging why) if the firmware is unusable. */
  start(hex: string): boolean {
    this.stop(true);
    let flash: Uint8Array;
    try { flash = parseIntelHex(hex); } catch (e) {
      this.app.log(`Firmware error: ${(e as Error).message}. Upload the .hex from Arduino IDE (Sketch → Export Compiled Binary).`, 'error');
      return false;
    }
    const prog = new Uint16Array(flash.buffer.slice(0));
    const cpu = this.cpu = new CPU(prog);
    new AVRTimer(cpu, timer0Config); new AVRTimer(cpu, timer1Config); new AVRTimer(cpu, timer2Config);
    this.ports = { B: new AVRIOPort(cpu, portBConfig), C: new AVRIOPort(cpu, portCConfig), D: new AVRIOPort(cpu, portDConfig) };
    this.usart = new AVRUSART(cpu, usart0Config, F_CPU);
    this.usart.onByteTransmit = (b) => { this.serialOut += String.fromCharCode(b); this.txAt = performance.now(); };
    this.usart.onRxComplete = () => this.feedSerial();
    this.adc = new AVRADC(cpu, adcConfig);
    this.adc.avcc = VCC;
    for (const p of Object.values(this.ports)) p.addListener(() => this.pinsChanged());
    this.serialOut = ''; this.rxQueue = []; this.levels.clear(); this.out = {};
    this.clock.reset();
    this.running = true;
    this.analog.reset();
    this.app.onSimState(true);
    this.loop();
    return true;
  }

  stop(silent = false): void {
    if (this.loopHandle) { clearTimeout(this.loopHandle); this.loopHandle = null; }
    if (!this.running) return;
    this.running = false;
    if (!silent) this.app.onSimState(false);
  }

  pause() { if (this.running) this.clock.pause(); }
  resume() { this.clock.resume(); }
  setSpeed(s: number) { this.clock.setSpeed(+s); }
  setPressed(id: string, on: boolean) { this.ui[id] = { ...(this.ui[id] || {}), pressed: on }; this.touch(); }
  invalidate() {}
  updateWifi() {}
  pollInterrupts() {}
  touch() { if (this.running && !this.inStep) this.analog.sync(); }
  sendSerial(text: string) { for (const ch of text) this.rxQueue.push(ch.charCodeAt(0) & 0xff); this.feedSerial(); }

  private feedSerial() {
    if (!this.usart || this.usart.rxBusy || !this.rxQueue.length) return;
    this.usart.writeByte(this.rxQueue.shift()!);
  }

  /** A port register changed: update the pin drivers in the circuit at this exact cycle. */
  private pinsChanged() {
    const d13 = this.ports.B.pinState(5);
    this.out[13] = d13 === PinState.High ? 1 : 0;
    this.analog.sync();
    // a pull-up switched on (or a pin turned into an input) is visible to the very next read
    this.updateInputs();
  }

  /** Feed node voltages back into the chip: digital input levels and the ADC channels. */
  private syncInputs() {
    this.analog.sync();
    this.updateInputs();
    for (let ch = 0; ch < 6; ch++) {
      const v = this.analog.gpioVoltage(14 + ch);
      this.adc.channelValues[ch] = v == null ? 0 : Math.min(VCC, Math.max(0, v));
    }
  }

  private updateInputs() {
    for (let n = 0; n < 20; n++) {
      const [p, bit] = portOf(n);
      const port = this.ports[p], st = port.pinState(bit);
      if (st === PinState.High || st === PinState.Low) continue;
      const v = this.analog.gpioVoltage(n);
      let lvl: boolean;
      if (v == null) lvl = st === PinState.InputPullUp; // unwired pin
      else { const last = this.levels.get(n) ?? v > VCC / 2; lvl = v >= VIH ? true : v <= VIL ? false : last; }
      if (this.levels.get(n) !== lvl) { this.levels.set(n, lvl); port.setPin(bit, lvl); }
      }
      }

  /** Run the CPU up to the virtual clock's time, in 1 ms slices, then reschedule. */
  private loop = () => {
    this.loopHandle = null;
    if (!this.running) return;
    try {
      if (!this.clock.paused) {
        const target = this.clock.millis();
        const w0 = performance.now(), cpu = this.cpu;
        this.inStep = true;
        while (this.millis() < target && performance.now() - w0 < 14) {
          this.syncInputs();
          const end = Math.min(target, this.millis() + 1) * (F_CPU / 1000);
          while (cpu.cycles < end) { avrInstruction(cpu); cpu.tick(); }
        }
        this.inStep = false;
        const behind = target - this.millis();
        if (behind > 0.5) this.clock.stall(behind / this.clock.speed); // emulation is slower than real time
      }
    } catch (e) {
      this.inStep = false;
      this.app.reportError(e);
      this.stop();
      return;
    }
    this.loopHandle = setTimeout(this.loop, 2);
  };
}
