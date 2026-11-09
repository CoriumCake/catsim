/* Several microcontrollers in one circuit.
 *
 * Every board gets its own sketch runtime (with ESP32 or Uno rules) running its own program, but they share one virtual clock and one analog circuit: each board drives its own pins,
 * and a wire from one board's output to another board's input carries a real voltage. ESP32 boards
 * also share the built-in MQTT broker, so they can message each other. */
import { Simulator, topicMatch, pressEvent } from './runtime.js';
import { AnalogBridge, espDrive, type BoardDriver, type SimState } from './analog/bridge.ts';
import { SimClock } from './clock.ts';
import type { Project } from './types.ts';

export interface BoardProgram { id: string; type: string; code?: string; nv?: Record<string, unknown> }

export interface MultiHost {
  readonly project: Project;
  log(msg: string, level?: string, line?: number, board?: string): void;
  reportError(e: unknown, board: string): void;
  /** an ESP32 published an MQTT message */
  onPublish?(m: { t: number; topic: string; payload: string; from: string; board: string }): void;
  onRestart?(board: string): void;
  /** a board's saved data (EEPROM, Preferences, RTC) changed */
  onNv?(board: string, nv: Record<string, unknown>): void;
}

// runtime.js is plain JS: its runtime objects are typed loosely here
type EspSim = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Runtime = { rt: EspSim };

export class MultiRun {
  readonly clock = new SimClock();
  readonly ui: Record<string, { pressed?: boolean } | undefined> = {};
  readonly bridge: AnalogBridge;
  readonly runtimes = new Map<string, Runtime>();
  running = false;
  private readonly drivers: Record<string, BoardDriver> = {};

  constructor(private readonly host: MultiHost) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const state = {
      app: { get project() { return host.project; }, log: (m: string, l?: string) => host.log(m, l) },
      get running() { return self.running; }, ui: this.ui,
      mode: {}, out: {}, pwm: {}, tone: {}, servo: {}, dac: {}, ledcPin: {}, ledcCh: {},
      millis: () => self.clock.millis(),
      clock: { stall: (ms: number) => self.clock.stall(ms) },
      drivers: this.drivers,
    } as unknown as SimState;
    this.bridge = new AnalogBridge(state);
  }

  private boardHost(id: string) {
    const h = this.host;
    return {
      get project() { return h.project; },
      log: (msg: string, level?: string, line?: number) => h.log(msg, level, line, id),
      reportError: (e: unknown) => h.reportError(e, id),
      iotChanged() {}, onSimState() {},
      restartSim: () => h.onRestart?.(id),
      nvChanged: (nv: Record<string, unknown>) => h.onNv?.(id, nv),
    };
  }

  /** Start every board. Returns false if none of them could start. */
  start(boards: BoardProgram[], speed = 1): boolean {
    this.stop();
    this.clock.reset(); this.clock.setSpeed(speed);
    this.bridge.reset();
    for (const k of Object.keys(this.drivers)) delete this.drivers[k];
    for (const k of Object.keys(this.ui)) delete this.ui[k];
    this.runtimes.clear();
    this.running = true;
    let started = 0;
    for (const b of boards) {
      const uno = b.type === 'uno'; // an Uno runs its sketch like an ESP32 does, with Uno rules
      const rt = new Simulator(this.boardHost(b.id)) as EspSim;
      rt.boardType = uno ? 'uno' : b.type === 'esp32c3' ? 'esp32c3' : 'esp32';
      rt.nv = b.nv || {};
      rt.clock = this.clock; rt.ownsClock = false;
      rt.analog = this.bridge; rt.ownsAnalog = false;
      rt.boardId = b.id;
      rt.brokerPublish = (topic: string, payload: string, from: string) => this.publish(b.id, topic, payload, from);
      this.drivers[b.id] = { name: `${uno ? 'Uno' : b.type === 'esp32c3' ? 'ESP32-C3' : 'ESP32'} (${b.id})`, drive: (g, vh) => espDrive(rt as unknown as SimState, g, uno, vh) };
      this.runtimes.set(b.id, { rt });
      started++;
      rt.start(b.code || '').then((ok: boolean) => { if (ok === false) started--; });
      rt.ui = this.ui; // buttons are shared by every board (start() replaced it)
    }
    return started > 0;
  }

  stop(): void {
    for (const { rt } of this.runtimes.values()) rt.stop(true);
    this.running = false;
  }

  /** Bring the circuit up to date and let every board react (interrupts, WiFi). */
  touch(): void {
    if (!this.running) return;
    this.bridge.sync();
    for (const { rt } of this.runtimes.values()) { rt.updateWifi(); rt.checkPower(); rt.pollInterrupts(); }
  }

  pause() { this.clock.pause(); }
  resume() { this.clock.resume(); }
  setSpeed(s: number) { this.clock.setSpeed(s); }
  setPressed(id: string, on: boolean, key?: string) { this.ui[id] = pressEvent(this.ui[id], on, key, this.clock.millis()); this.touch(); }
  invalidate() { for (const { rt } of this.runtimes.values()) rt.invalidate(); }

  sendSerial(board: string, text: string) {
    const r = this.runtimes.get(board);
    if (!r) return;
    r.rt.serialIn += text;
  }

  /** MQTT: log device messages and deliver to every subscribed ESP32 (including the sender, as MQTT does). */
  publish(board: string, topic: string, payload: string, from: string) {
    const m = { t: this.clock.millis(), topic: String(topic), payload: String(payload), from };
    if (from === 'device') this.host.onPublish?.({ ...m, board });
    for (const r of this.runtimes.values()) {
      const q = r.rt.mqtt;
      if (q.connected && q.subs.some((f: string) => topicMatch(f, m.topic))) q.queue.push(m);
    }
  }

  /** Per-board state for the UI; serial output is taken (cleared) on read. */
  boardStates() {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, r] of this.runtimes) {
      const rt = r.rt as EspSim;
      let serial = String(rt.serialOut || ''); rt.serialOut = '';
      if (serial.length > 100_000) serial = serial.slice(-100_000);
      out[id] = {
        type: rt.boardType, running: rt.running, serial, mode: rt.mode, out: rt.out, pwm: rt.pwm, servo: rt.servo, tone: rt.tone,
        lcd: rt.lcd, dev: rt.dev, halted: !!rt.halted, i2c: rt.i2c, wifi: { status: rt.wifi.status, ssid: rt.wifi.ssid },
        mqtt: { connected: rt.mqtt.connected, clientId: rt.mqtt.clientId, host: rt.mqtt.host, subs: rt.mqtt.subs },
      };
    }
    return out;
  }
}
