/**
 * Subscription state and periodic-notify scheduling (HID_CONTROL_PLANE.md 7).
 *
 * Mirrors the firmware: rates are clamped (never rejected), omitted fields keep
 * their value, `quartzHz` / `quartzPulses` are forced off without a quartz
 * engine, and every subscribe re-seeds the periodic timers so the first push
 * comes one period later. Only one message is sent per poll, in the order
 * metrics, beat, timing, quartz (the event-like feeds follow in the device).
 */
import type { HidSubscription, HidSubscribePatch } from '@/protocol/types';

/** Rate caps advertised in `hello.caps`. */
export interface RateCaps {
  metricsHzMax: number;
  beatHzMax: number;
  timingHzMax: number;
  quartzHzMax: number;
  /** Build has the quartz engine. */
  quartz: boolean;
  /** `getBeats` / `subscribe.beats` exist. */
  beats: boolean;
}

/** Periodic notify kinds. */
export type PeriodicKind = 'metrics' | 'beat' | 'timing' | 'quartz';

const PERIODIC: readonly PeriodicKind[] = ['metrics', 'beat', 'timing', 'quartz'];

/**
 * Reads an integer rate clamped to `[0, max]` (firmware `read_rate`).
 * @param v Requested value (anything non-numeric leaves `current`).
 * @param max Cap.
 * @param current Current value.
 */
function readRate(v: unknown, max: number, current: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return current;
  return Math.min(max, Math.max(0, Math.trunc(v)));
}

/** Holds the active subscription and the periodic due times. */
export class SubscriptionState {
  private sub: HidSubscription = {
    metricsHz: 0,
    beatHz: 0,
    timingHz: 0,
    quartzHz: 0,
    events: false,
    errors: false,
    quartzPulses: false,
    beats: false,
  };
  private due: Record<PeriodicKind, number> = { metrics: 0, beat: 0, timing: 0, quartz: 0 };

  /** @param caps Rate caps. */
  constructor(private readonly caps: RateCaps) {}

  /** @returns A copy of the active subscription (the `subscribe` result). */
  current(): HidSubscription {
    return { ...this.sub };
  }

  /** @returns `true` when any push is active (the device needs polling). */
  get active(): boolean {
    const s = this.sub;
    return (
      s.metricsHz > 0 ||
      s.beatHz > 0 ||
      s.timingHz > 0 ||
      s.quartzHz > 0 ||
      s.events ||
      s.errors ||
      s.quartzPulses ||
      s.beats === true
    );
  }

  /** @returns Active flag values (for the device's feed checks). */
  get flags(): { events: boolean; errors: boolean; quartzPulses: boolean; beats: boolean } {
    return {
      events: this.sub.events,
      errors: this.sub.errors,
      quartzPulses: this.sub.quartzPulses,
      beats: this.sub.beats === true,
    };
  }

  /**
   * Applies a subscribe request and re-seeds the timers.
   * @param body Request fields.
   * @param nowMs Monotonic ms.
   * @returns The echoed subscription.
   */
  apply(body: HidSubscribePatch, nowMs: number): HidSubscription {
    const c = this.caps;
    const s = this.sub;
    s.metricsHz = readRate(body.metricsHz, c.metricsHzMax, s.metricsHz);
    s.beatHz = readRate(body.beatHz, c.beatHzMax, s.beatHz);
    s.timingHz = readRate(body.timingHz, c.timingHzMax, s.timingHz);
    s.quartzHz = readRate(body.quartzHz, c.quartzHzMax, s.quartzHz);
    if (typeof body.quartzPulses === 'boolean') s.quartzPulses = body.quartzPulses;
    if (typeof body.events === 'boolean') s.events = body.events;
    if (typeof body.errors === 'boolean') s.errors = body.errors;
    if (typeof body.beats === 'boolean') s.beats = body.beats;
    if (!c.quartz) {
      s.quartzHz = 0;
      s.quartzPulses = false;
    }
    if (!c.beats) s.beats = false;
    for (const k of PERIODIC) this.due[k] = nowMs + this.periodMs(k);
    return this.current();
  }

  /**
   * @param nowMs Monotonic ms.
   * @returns The first periodic kind that is due (priority order), or `null`.
   */
  nextDue(nowMs: number): PeriodicKind | null {
    for (const k of PERIODIC) {
      if (this.hz(k) > 0 && nowMs >= this.due[k]) return k;
    }
    return null;
  }

  /**
   * Records that a periodic notify was sent.
   * @param kind The kind.
   * @param nowMs Monotonic ms.
   */
  markSent(kind: PeriodicKind, nowMs: number): void {
    const p = this.periodMs(kind);
    let next = this.due[kind] + p;
    if (next < nowMs - p) next = nowMs;
    this.due[kind] = next;
  }

  private hz(k: PeriodicKind): number {
    switch (k) {
      case 'metrics':
        return this.sub.metricsHz;
      case 'beat':
        return this.sub.beatHz;
      case 'timing':
        return this.sub.timingHz;
      case 'quartz':
        return this.sub.quartzHz;
    }
  }

  private periodMs(k: PeriodicKind): number {
    const hz = this.hz(k);
    return hz > 0 ? 1000 / hz : Infinity;
  }
}
