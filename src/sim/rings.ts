/**
 * Bounded log with monotonically increasing entry numbers, used for the
 * device's event, error and beat rings so notify baselines survive stream
 * resets (the firmware tracks "what has been sent" against such cursors).
 */

/** A fixed-capacity ring whose entries carry a global counter. */
export class NumberedRing<T> {
  private items: { n: number; v: T }[] = [];
  private counter = 0;

  /** @param cap Maximum entries kept (oldest dropped). */
  constructor(private readonly cap: number) {}

  /** @returns Total number of pushes so far (the cursor of the newest entry + 1). */
  get total(): number {
    return this.counter;
  }

  /** @returns Entries currently held. */
  get length(): number {
    return this.items.length;
  }

  /**
   * Appends an entry.
   * @param v The entry.
   */
  push(v: T): void {
    this.items.push({ n: this.counter++, v });
    if (this.items.length > this.cap) this.items.shift();
  }

  /**
   * @param max Maximum entries.
   * @returns The newest entries, newest first.
   */
  newest(max: number): T[] {
    const out: T[] = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < max; i--) {
      const it = this.items[i];
      if (it) out.push(it.v);
    }
    return out;
  }

  /**
   * @param cursor Entry number baseline (from {@link total}).
   * @param max Maximum entries.
   * @returns Entries with number >= cursor, oldest first, and the next cursor.
   */
  since(cursor: number, max: number): { values: T[]; next: number } {
    const values: T[] = [];
    let next = cursor;
    for (const it of this.items) {
      if (it.n < cursor) continue;
      if (values.length >= max) break;
      values.push(it.v);
      next = it.n + 1;
    }
    return { values, next: Math.max(next, Math.min(cursor, this.counter)) };
  }

  /** Empties the ring (the counter keeps counting). */
  clear(): void {
    this.items = [];
  }
}
