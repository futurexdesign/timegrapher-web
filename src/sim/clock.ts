/**
 * Injectable monotonic clock for the simulator.
 *
 * The simulator never reads `performance.now()` directly; it calls a
 * {@link Clock}, so tests can drive time with {@link ManualClock}.
 */

/** Returns monotonic milliseconds (arbitrary origin). */
export type Clock = () => number;

/** Default clock: `performance.now()`, resolved at call time (fake-timer friendly). */
export const performanceClock: Clock = () => performance.now();

/** A clock whose time only moves when told to. */
export class ManualClock {
  private t: number;

  /** @param startMs Initial reading in ms. */
  constructor(startMs = 0) {
    this.t = startMs;
  }

  /** Reads the clock (usable directly as a {@link Clock}). */
  readonly now: Clock = () => this.t;

  /**
   * Moves time forward.
   * @param ms Milliseconds to add (must be >= 0).
   */
  advance(ms: number): void {
    this.t += ms;
  }
}
