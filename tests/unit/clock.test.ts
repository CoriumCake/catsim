import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimClock } from '../../src/clock.ts';

describe('SimClock', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });
  const make = () => new SimClock(() => Date.now());

  it('tracks wall-clock time at speed 1', () => {
    const c = make();
    vi.advanceTimersByTime(250);
    expect(c.millis()).toBe(250);
  });

  it('fires timers in due order, each at its exact virtual time', () => {
    const c = make(); const seen: Array<[string, number]> = [];
    c.schedule(30, () => seen.push(['b', c.millis()]));
    c.schedule(10, () => seen.push(['a', c.millis()]));
    c.schedule(30, () => seen.push(['c', c.millis()]));
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([['a', 10], ['b', 30], ['c', 30]]);
  });

  it('runs faster and slower', () => {
    const c = make(); let fired = -1;
    c.setSpeed(5);
    c.schedule(1000, () => { fired = Date.now(); });
    vi.advanceTimersByTime(199); expect(fired).toBe(-1);
    vi.advanceTimersByTime(1); expect(fired).toBe(200);
    c.setSpeed(0.5);
    const at = c.millis(); vi.advanceTimersByTime(100);
    expect(c.millis() - at).toBe(50);
  });


  it('drops lateness instead of skipping time when it fires late', () => {
    const c = make(); let at = -1;
    c.schedule(10, () => { at = c.millis(); });
    vi.setSystemTime(500); // the page was blocked for half a second…
    vi.advanceTimersByTime(10); // …so the 10 ms timer only runs now, at wall-clock 510
    expect(at).toBe(10);
    expect(c.millis()).toBe(10);
  });

  it('cancels single timers and everything on reset', () => {
    const c = make(); let n = 0;
    const cancel = c.schedule(10, () => n++);
    c.schedule(20, () => n++);
    cancel(); vi.advanceTimersByTime(15); expect(n).toBe(0);
    c.reset(); expect(c.millis()).toBe(0);
    vi.advanceTimersByTime(100); expect(n).toBe(0);
  });

  it('does not lose time to ordinary timer jitter (browsers clamp short timeouts to ≥ 4 ms)', () => {
    let now = 0; const c = new SimClock(() => now);
    let at = -1;
    c.schedule(2, () => { at = c.millis(); });
    now = 4.3;                 // the 2 ms timeout really ran after 4.3 ms
    vi.advanceTimersByTime(5); // let the (fake) setTimeout fire
    expect(at).toBeCloseTo(4.3, 6); // the clock kept running: no time was dropped
    expect(c.millis()).toBeCloseTo(4.3, 6);
  });
});
