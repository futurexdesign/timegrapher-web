/**
 * Timebase calibration history: the 24-entry ring, the PPS append policy
 * (`timebase_log_pps_decision` in `include/timebase_log.h`) and the deferred
 * flash-write bookkeeping (`pending`, retry spacing).
 */
import type { TimebaseLog, TimebaseLogEntry } from '@/protocol/types';
import { HID_JSON_MAX, REPLY_ENVELOPE_BYTES, fitCount } from '../wire';

/** Ring capacity. */
export const TIMEBASE_LOG_CAP = 24;
/** PPS window that counts as full. */
export const PPS_WINDOW_FULL = 64;
/** Continuous PPS lock needed before a measurement is trusted (s). */
export const PPS_MIN_LOCK_S = 600;
/** Minimum spacing between `delta` entries (s). */
export const MIN_DELTA_AGE_S = 86400;
/** Spacing that forces a `monthly` entry (s). */
export const MONTHLY_S = 30 * 86400;
/** Valid range of `logDeltaPpm`. */
export const LOG_DELTA_RANGE = { min: 0.05, max: 10 } as const;
/** Default `logDeltaPpm`. */
export const LOG_DELTA_DEFAULT = 0.2;
/** Minimum spacing between flash attempts (ms) and after a failed / busy one. */
export const LOG_ATTEMPT_MS = 10_000;
/** Retry spacing after a failed or busy attempt (ms). */
export const LOG_RETRY_MS = 60_000;

/** Inputs to {@link ppsDecision}. */
export interface PpsLogInput {
  /** PPS filter is locked. */
  locked: boolean;
  /** Pulses in the PPS window. */
  window: number;
  /** Seconds of continuous lock. */
  lockedSinceS: number;
  /** Current PPS ppm. */
  ppm: number;
  /** GPS UTC (UNIX s), 0 = unknown. */
  utcNow: number;
}

/** Outcome of {@link ppsDecision}. */
export type PpsDecision = 'none' | 'delta' | 'monthly';

/**
 * Decides whether a PPS measurement is appended (mirror of the firmware helper).
 * Compared against the last entry of ANY source.
 * @param entries Current log, oldest first.
 * @param input PPS state.
 * @param deltaPpm Delta threshold (ppm).
 */
export function ppsDecision(
  entries: readonly TimebaseLogEntry[],
  input: PpsLogInput,
  deltaPpm: number,
): PpsDecision {
  if (
    !input.locked ||
    input.window !== PPS_WINDOW_FULL ||
    input.lockedSinceS < PPS_MIN_LOCK_S ||
    input.utcNow === 0
  ) {
    return 'none';
  }
  const last = entries[entries.length - 1];
  if (last === undefined) return 'delta';
  const moved = Math.abs(input.ppm - last.ppm) >= deltaPpm;
  if (input.utcNow < last.dateUnix) {
    const ahead = last.dateUnix - input.utcNow;
    return ahead > MIN_DELTA_AGE_S && moved ? 'delta' : 'none';
  }
  const age = input.utcNow - last.dateUnix;
  if (age >= MONTHLY_S) return 'monthly';
  if (moved && age >= MIN_DELTA_AGE_S) return 'delta';
  return 'none';
}

/** The log ring plus deferred-write state. */
export class TimebaseLogModel {
  /** Append threshold (ppm). */
  deltaPpm = LOG_DELTA_DEFAULT;

  private entries: TimebaseLogEntry[] = [];
  private pendingFlag = false;
  private lastWrite = 0;
  private lastAttemptMs = -Infinity;
  private retryMs = LOG_ATTEMPT_MS;

  /** @returns A copy of the entries, oldest first. */
  list(): TimebaseLogEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** @returns A flash write is deferred. */
  get pending(): boolean {
    return this.pendingFlag;
  }

  /**
   * Appends an entry to the RAM ring (oldest dropped past 24).
   * @param e Entry.
   */
  append(e: TimebaseLogEntry): void {
    this.entries.push({ ...e });
    if (this.entries.length > TIMEBASE_LOG_CAP) this.entries.shift();
  }

  /** Marks an appended entry as not yet in flash. */
  markPending(): void {
    this.pendingFlag = true;
    this.lastAttemptMs = -Infinity;
  }

  /**
   * Records a successful flash write.
   * @param utcNow UTC at the write (0 = unknown).
   */
  written(utcNow: number): void {
    this.pendingFlag = false;
    this.lastWrite = utcNow;
    this.retryMs = LOG_ATTEMPT_MS;
  }

  /**
   * Flush poll: attempts the deferred write when allowed.
   * @param nowMs Monotonic ms.
   * @param blocked Writes must wait (streaming or a quartz measurement running).
   * @param flashOk The flash accepts the write (fault injection).
   * @param utcNow UTC for `lastWriteUnix`.
   * @returns `true` when the entry was written now.
   */
  flush(nowMs: number, blocked: boolean, flashOk: boolean, utcNow: number): boolean {
    if (!this.pendingFlag || blocked) return false;
    if (nowMs - this.lastAttemptMs < this.retryMs) return false;
    this.lastAttemptMs = nowMs;
    if (!flashOk) {
      this.retryMs = LOG_RETRY_MS;
      return false;
    }
    this.written(utcNow);
    return true;
  }

  /** Empties the ring (after a successful flash write). */
  clear(utcNow: number): void {
    this.entries = [];
    this.written(utcNow);
  }

  /**
   * Builds a `getTimebaseLog` page the way `encode_timebase_log` does: entries
   * from `offset` while the encoded reply stays within 2048 bytes.
   * @param offset First entry wanted (clamped to the total).
   * @param maxBytes Message size limit (bytes).
   * @returns The page.
   */
  result(offset = 0, maxBytes = HID_JSON_MAX): TimebaseLog {
    const all = this.list();
    const off = Math.min(Math.max(0, Math.trunc(offset)), all.length);
    const rest = all.slice(off).map((e) => ({
      dateUnix: e.dateUnix,
      ppm: e.ppm,
      source: e.source,
      durationS: e.durationS,
      reason: e.reason,
    }));
    const tail = {
      total: all.length,
      offset: off,
      pending: this.pendingFlag,
      logDeltaPpm: this.deltaPpm,
      lastWriteUnix: this.lastWrite,
    };
    // `{"entries":[` + `],"total":..}` (the trailer is the tail object minus its opening brace).
    const fixed = '{"entries":['.length + JSON.stringify(tail).length + 1;
    const n = fitCount(rest, maxBytes - REPLY_ENVELOPE_BYTES - fixed);
    return { entries: all.slice(off, off + n), ...tail };
  }
}
