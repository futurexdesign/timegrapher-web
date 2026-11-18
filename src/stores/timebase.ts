/**
 * Timebase store: the device's sample-clock correction (`getTimebase`), the
 * persisted calibration log (`getTimebaseLog`) and an in-memory "this session"
 * series of live PPS ppm.
 *
 * The device has no push notify for the timebase, so consumers call
 * {@link TimebaseStore.startPolling} while visible (reference counted; 1 Hz).
 * Every poll that finds PPS locked appends `[ms, ppm]` to `sessionPps`
 * (capped at {@link SESSION_CAP} points, about 24 h at 1 Hz).
 */
import { ref, shallowRef, triggerRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { Timebase, TimebaseLog } from '@/protocol/timegrapher_hid';
import type { RequestOf } from '@/protocol/types';
import { isDeviceError } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';

/** Poll period (ms). */
export const POLL_MS = 1000;
/** Maximum retained live PPS samples (24 h at 1 Hz). */
export const SESSION_CAP = 24 * 3600;
/** Valid `logDeltaPpm` range. */
export const LOG_DELTA_RANGE = { min: 0.05, max: 10 } as const;
/** Message shown when flash writes are refused because audio is streaming. */
export const BUSY_HINT =
  'Device busy: close the audio stream (PC timegrapher software) before saving.';

/** A reference-counted 1 Hz poller. */
export interface Poller {
  /** Adds a user; the first one starts the timer (with an immediate tick). */
  start(): void;
  /** Removes a user; the last one stops the timer. */
  stop(): void;
}

/**
 * Creates a reference-counted poller that never overlaps ticks.
 * @param tick Async work per period.
 * @param periodMs Period.
 */
export function createPoller(tick: () => Promise<void>, periodMs = POLL_MS): Poller {
  let users = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const run = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tick();
    } finally {
      inFlight = false;
    }
  };
  return {
    start() {
      users++;
      if (users === 1) {
        void run();
        timer = setInterval(() => void run(), periodMs);
      }
    },
    stop() {
      users = Math.max(0, users - 1);
      if (users === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Pinia store for the timebase. */
export const useTimebaseStore = defineStore('timebase', () => {
  const connection = useConnectionStore();
  const snackbar = useSnackbarStore();

  /** Latest getTimebase result. */
  const tb = ref<Timebase | null>(null);
  /** Latest getTimebaseLog result. */
  const log = ref<TimebaseLog | null>(null);
  /** Live PPS ppm samples `[unix ms, ppm]`, oldest first, capped. */
  const sessionPps = shallowRef<[number, number][]>([]);
  /** A write operation is in progress. */
  const working = ref(false);
  let pollErrorShown = false;

  /** Reports an error; `busy` gets the explanatory hint. */
  function report(e: unknown, context: string): void {
    if (isDeviceError(e) && e.code === 'busy') snackbar.show(BUSY_HINT, 'warning');
    else snackbar.error(e, context);
  }

  /**
   * Appends a live PPS sample, trimming to the cap.
   * @param ms Unix ms.
   * @param ppm PPS ppm.
   */
  function pushSession(ms: number, ppm: number): void {
    const arr = sessionPps.value;
    arr.push([ms, ppm]);
    if (arr.length > SESSION_CAP) arr.splice(0, arr.length - SESSION_CAP);
    // The array is mutated in place (no 86 400-entry copy per second); the
    // shallowRef is told explicitly so dependents re-run.
    triggerRef(sessionPps);
  }

  /** Reads the timebase once. Returns whether it succeeded. */
  async function refresh(quiet = false): Promise<boolean> {
    if (!connection.isConnected) return false;
    try {
      const r = await connection.requireTransport().request('getTimebase');
      tb.value = r;
      pollErrorShown = false;
      if (r.pps.enabled && r.pps.locked) pushSession(Date.now(), r.pps.ppm);
      return true;
    } catch (e) {
      if (!quiet || !pollErrorShown) report(e, 'getTimebase failed');
      pollErrorShown = true;
      return false;
    }
  }

  const poller = createPoller(async () => {
    await refresh(true);
  });

  /** Starts (reference counted) 1 Hz polling of getTimebase. */
  function startPolling(): void {
    poller.start();
  }
  /** Stops one polling user. */
  function stopPolling(): void {
    poller.stop();
  }

  /**
   * Runs a write op and stores its Timebase result.
   * @param fn Request issuing function.
   * @param context Error context.
   */
  async function write(fn: () => Promise<Timebase>, context: string): Promise<boolean> {
    working.value = true;
    try {
      tb.value = await fn();
      return true;
    } catch (e) {
      report(e, context);
      return false;
    } finally {
      working.value = false;
    }
  }

  /**
   * Sets the stored correction (RAM only).
   * @param body setTimebase request fields (`ppm` is required by the protocol).
   */
  function setTimebase(body: RequestOf<'setTimebase'>): Promise<boolean> {
    return write(
      () => connection.requireTransport().request('setTimebase', body),
      'Set timebase failed',
    );
  }

  /** Writes the stored correction to flash (`busy` while audio streams). */
  function save(): Promise<boolean> {
    return write(() => connection.requireTransport().request('saveTimebase'), 'Save failed');
  }

  /** Clears the stored correction in RAM (0 ppm / none). */
  function clear(): Promise<boolean> {
    return write(() => connection.requireTransport().request('clearTimebase'), 'Clear failed');
  }

  /**
   * Sets the log append threshold. `ppm` is optional in `setTimebase`, so only
   * `logDeltaPpm` is sent and the stored calibration stays untouched.
   * @param logDeltaPpm Threshold, clamped to 0.05..10.
   */
  function setLogDelta(logDeltaPpm: number): Promise<boolean> {
    const v = Math.min(LOG_DELTA_RANGE.max, Math.max(LOG_DELTA_RANGE.min, logDeltaPpm));
    return setTimebase({ logDeltaPpm: v });
  }

  /**
   * Reads the whole calibration log, following pages until
   * `offset + entries.length >= total`. A page without progress stops the loop.
   */
  async function refreshLog(): Promise<boolean> {
    if (!connection.isConnected) return false;
    try {
      const t = connection.requireTransport();
      let page = await t.request('getTimebaseLog');
      const all = [...page.entries];
      let guard = 0;
      while (
        page.offset + page.entries.length < page.total &&
        page.entries.length > 0 &&
        guard++ < 64
      ) {
        page = await t.request('getTimebaseLog', { offset: all.length });
        all.push(...page.entries);
      }
      log.value = { ...page, entries: all, offset: 0 };
      return true;
    } catch (e) {
      report(e, 'getTimebaseLog failed');
      return false;
    }
  }

  /** Erases the calibration log (writes flash; `busy` while audio streams). */
  async function clearLog(): Promise<boolean> {
    working.value = true;
    try {
      log.value = await connection.requireTransport().request('clearTimebaseLog');
      return true;
    } catch (e) {
      report(e, 'Clear log failed');
      return false;
    } finally {
      working.value = false;
    }
  }

  /** Forgets the live PPS samples. */
  function clearSession(): void {
    sessionPps.value = [];
  }

  watch(
    () => connection.isConnected,
    () => {
      tb.value = null;
      log.value = null;
      pollErrorShown = false;
      clearSession();
    },
  );

  return {
    tb,
    log,
    sessionPps,
    pushSession,
    working,
    refresh,
    startPolling,
    stopPolling,
    setTimebase,
    save,
    clear,
    setLogDelta,
    refreshLog,
    clearLog,
    clearSession,
  };
});
