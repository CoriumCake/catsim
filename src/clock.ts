/* CatSim — virtual simulation clock.
 *
 * Simulated time is decoupled from wall-clock time: it can be paused and run slower or faster.
 * Timers fire in order of their virtual due time. When a timer fires late (the page was busy),
 * the clock is rebased to the timer's due time, so `delay(1000)` always advances millis() by
 * exactly 1000 and the simulation simply runs slower than real time under load instead of skipping. */

type Timer = { at: number; seq: number; fn: () => void };

export class SimClock {
  /** Virtual ms at the moment `realAt` (wall-clock ms) */
  private base = 0;
  private realAt = 0;
  private timers: Timer[] = [];
  private seq = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private resumeWaiters: Array<() => void> = [];
  speed = 1;
  paused = false;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.realAt = this.now();
  }

  /** Current simulated time in ms. */
  millis(): number {
    return this.paused ? this.base : this.base + (this.now() - this.realAt) * this.speed;
  }

  reset(): void {
    this.cancelAll();
    this.base = 0; this.realAt = this.now(); this.paused = false;
    this.resumeWaiters.splice(0).forEach((f) => f());
  }

  private rebase(at = this.millis()): void { this.base = at; this.realAt = this.now(); }

  setSpeed(s: number): void {
    if (!(s > 0 && Number.isFinite(s))) return;
    this.rebase(); this.speed = s; this.arm();
  }

  pause(): void {
    if (this.paused) return;
    this.rebase(); this.paused = true; this.disarm();
  }

  resume(): void {
    if (!this.paused) return;
    this.realAt = this.now(); this.paused = false; this.arm();
    this.resumeWaiters.splice(0).forEach((f) => f());
  }

  /**
   * Take `realMs` of wall-clock time out of simulated time. Used after synchronous work (the analog
   * solver) during which no sketch code ran, so nobody observed the skipped interval and millis()
   * stays monotonic as long as `realMs` does not exceed the time the work took.
   */
  stall(realMs: number): void {
    if (this.paused || !(realMs > 0)) return;
    this.realAt += realMs;
    this.arm();
  }

  /** Resolves immediately when running, or when the clock is resumed. */
  whenRunning(): Promise<void> | undefined {
    if (!this.paused) return undefined;
    return new Promise((r) => this.resumeWaiters.push(r));
  }

  /** Run `fn` after `ms` of simulated time. Returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void {
    const t: Timer = { at: this.millis() + Math.max(0, ms || 0), seq: this.seq++, fn };
    // keep sorted by (at, seq); timer counts are small
    let i = this.timers.length;
    while (i > 0 && (this.timers[i - 1].at > t.at)) i--;
    this.timers.splice(i, 0, t);
    if (i === 0) this.arm();
    return () => { const k = this.timers.indexOf(t); if (k >= 0) this.timers.splice(k, 1); };
  }

  cancelAll(): void { this.timers = []; this.disarm(); }

  get pending(): number { return this.timers.length; }

  private disarm(): void { if (this.handle !== null) { clearTimeout(this.handle); this.handle = null; } }

  private arm(): void {
    this.disarm();
    if (this.paused || !this.timers.length) return;
    const wait = (this.timers[0].at - this.millis()) / this.speed;
    this.handle = setTimeout(() => this.fire(), Math.max(0, wait));
  }

  private fire(): void {
    this.handle = null;
    if (this.paused) return;
    const now = this.millis();
    // Fire everything that is due, each at its exact virtual time.
    while (this.timers.length && this.timers[0].at <= now && !this.paused) {
      const t = this.timers.shift()!;
      this.rebase(t.at);
      t.fn();
    }
    this.arm();
  }
}
