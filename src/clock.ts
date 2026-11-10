/* CatSim — virtual simulation clock.
 *
 * Simulated time is decoupled from wall-clock time: it can run slower or faster than real time.
 * Timers fire in order of their virtual due time. When a timer fires very late (the page was blocked
 * for more than MAX_LATE), the clock is rebased to the timer's due time, so the simulation runs slower
 * than real time under load instead of skipping. Ordinary timer jitter (browsers clamp nested timers
 * to ≥ 4 ms) is not taken out of simulated time, otherwise every short delay() would slow it down. */

/** Lateness (virtual ms) above which a timer is considered to have been blocked by the page. */
export const MAX_LATE = 25;

type Timer = { at: number; seq: number; fn: () => void };

export class SimClock {
  /** Virtual ms at the moment `realAt` (wall-clock ms) */
  private base = 0;
  private realAt = 0;
  private timers: Timer[] = [];
  private seq = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  speed = 1;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.realAt = this.now();
  }

  /** Current simulated time in ms. */
  millis(): number {
    return this.base + (this.now() - this.realAt) * this.speed;
  }

  reset(): void {
    this.cancelAll();
    this.base = 0; this.realAt = this.now();
  }

  private rebase(at = this.millis()): void { this.base = at; this.realAt = this.now(); }

  setSpeed(s: number): void {
    if (!(s > 0 && Number.isFinite(s))) return;
    this.rebase(); this.speed = s; this.arm();
  }

  /**
   * Take `realMs` of wall-clock time out of simulated time. Used after synchronous work (the analog
   * solver) during which no sketch code ran, so nobody observed the skipped interval and millis()
   * stays monotonic as long as `realMs` does not exceed the time the work took.
   */
  stall(realMs: number): void {
    if (!(realMs > 0)) return;
    this.realAt += realMs;
    this.arm();
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
    if (!this.timers.length) return;
    const wait = (this.timers[0].at - this.millis()) / this.speed;
    this.handle = setTimeout(() => this.fire(), Math.max(0, wait));
  }

  private fire(): void {
    this.handle = null;
    const now = this.millis();
    // Fire everything that is due, each at its exact virtual time.
    while (this.timers.length && this.timers[0].at <= now) {
      const t = this.timers.shift()!;
      if (this.millis() - t.at > MAX_LATE) this.rebase(t.at);
      t.fn();
    }
    this.arm();
  }
}
