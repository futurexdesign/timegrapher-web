/**
 * PC-assisted sample-clock calibration: a faithful port of the `calRun` loop
 * of the firmware repo's `docs/hid/example.html`.
 *
 * Each cycle sends a `getTime` probe, stamps it with the wall-clock midpoint
 * and the `performance.now()` round-trip time, restarts the run when the wall
 * clock steps by more than {@link CAL_STEP_LIMIT_MS}, keeps the lowest-RTT
 * sample per time bucket and fits `device_us = a + b * host_us`
 * (see `src/utils/calibration.ts`). The state machine is created by
 * {@link createPcCalibration} with injected dependencies (transport, clocks,
 * sleep, apply) so it is unit-testable; {@link usePcCalibration} wires the real
 * ones (connection store, Screen Wake Lock, visibility API).
 */
import { computed, ref, shallowRef } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useTimebaseStore } from '@/stores/timebase';
import {
  CAL_STEP_LIMIT_MS,
  calFit,
  calOffsetSeries,
  calSelect,
  median,
  ppmToSecPerDay,
  type CalFit,
  type CalSample,
} from '@/utils/calibration';

/** Shortest run allowed (s). */
export const CAL_MIN_DURATION_S = 120;
/** Default probe interval (s). */
export const CAL_DEFAULT_INTERVAL_S = 2;
/** Default bucket width (s). */
export const CAL_DEFAULT_BUCKET_S = 30;
/** Minimum fit span (s) for a result to be applicable. */
export const CAL_MIN_SPAN_S = 60;
/** Uncertainty above which the user is told to run longer (ppm). */
export const CAL_STDERR_WARN_PPM = 0.5;

/** Lifecycle of a run. */
export type CalStatus = 'idle' | 'running' | 'done' | 'failed';

/** Message severity. */
export type CalLevel = 'info' | 'success' | 'warning' | 'error';

/** Fields sent to the device when applying a result. */
export interface CalApplyBody {
  ppm: number;
  source: 'ntp';
  dateUnix: number;
  durationS: number;
}

/** Outcome of applying a result. */
export interface CalApplyOutcome {
  /** setTimebase succeeded. */
  applied: boolean;
  /** saveTimebase succeeded (only attempted when requested). */
  saved: boolean;
}

/** Everything the state machine needs from the outside world. */
export interface PcCalDeps {
  /** One `getTime` probe; rejects on timeout. */
  getTime(): Promise<{ tUs: number }>;
  /** `performance.now()` (ms). */
  perfNow(): number;
  /** `Date.now()` (ms). */
  dateNow(): number;
  /** Resolves after `ms`. */
  sleep(ms: number): Promise<void>;
  /** Sends the result to the device (and optionally saves it). */
  apply(body: CalApplyBody, save: boolean): Promise<CalApplyOutcome>;
  /** Optional Screen Wake Lock. Must not throw. */
  wakeLock?: { acquire(): Promise<void>; release(): Promise<void> };
  /** Optional page-visibility feed; returns an unsubscribe function. */
  watchHidden?(cb: () => void): () => void;
}

/** Run parameters. */
export interface CalOptions {
  /** Run length (s); clamped to at least {@link CAL_MIN_DURATION_S}. */
  durationS: number;
  /** Seconds between probes (min 0.5). */
  intervalS?: number;
  /** Bucket width (s, min 5). */
  bucketS?: number;
}

/**
 * Creates the calibration state machine.
 * @param deps Injected dependencies.
 */
export function createPcCalibration(deps: PcCalDeps) {
  const status = ref<CalStatus>('idle');
  const durationS = ref(0);
  const elapsedS = ref(0);
  const sampleCount = ref(0);
  const timeouts = ref(0);
  const stepRestarts = ref(0);
  const hiddenSeen = ref(false);
  const stopReason = ref<string | null>(null);
  /** Latest fit (live while running, final when done). */
  const fit = shallowRef<CalFit | null>(null);
  /** Selected (lowest-RTT per bucket) samples behind the latest fit. */
  const selected = shallowRef<CalSample[]>([]);
  /** True when the final fit may be applied. */
  const applicable = ref(false);
  const applied = ref(false);
  const saved = ref(false);
  const message = ref('');
  const level = ref<CalLevel>('info');
  const progress = computed(() =>
    durationS.value > 0 ? Math.min(1, elapsedS.value / durationS.value) : 0,
  );
  const remainingS = computed(() => Math.max(0, durationS.value - elapsedS.value));
  const secPerDay = computed(() => (fit.value ? ppmToSecPerDay(fit.value.ppm) : null));
  const chart = computed(() => calOffsetSeries(selected.value, fit.value));

  let samples: CalSample[] = [];
  let cancelled = false;
  /** Read through a function so control-flow analysis does not freeze the flag. */
  const isCancelled = (): boolean => cancelled;
  let wake: (() => void) | null = null;
  let finalDateMs = 0;

  function say(text: string, lvl: CalLevel): void {
    message.value = text;
    level.value = lvl;
  }

  async function probe(): Promise<CalSample> {
    const p0 = deps.perfNow();
    const w0 = deps.dateNow();
    const r = await deps.getTime();
    const p1 = deps.perfNow();
    const w1 = deps.dateNow();
    return { hostMs: (w0 + w1) / 2, devUs: r.tUs, rttMs: p1 - p0, wallMinusPerf: w1 - p1 };
  }

  /** Sleeps but wakes immediately on cancel. */
  function nap(ms: number): Promise<void> {
    return Promise.race([
      deps.sleep(ms),
      new Promise<void>((r) => {
        wake = r;
      }),
    ]);
  }

  /**
   * Runs a calibration. Resolves when the run ends (done, cancelled or failed).
   * Ignored while already running.
   * @param opts Run parameters.
   */
  async function start(opts: CalOptions): Promise<void> {
    if (status.value === 'running') return;
    const dur = Math.max(CAL_MIN_DURATION_S, opts.durationS || 1800);
    const intervalS = Math.max(0.5, opts.intervalS ?? CAL_DEFAULT_INTERVAL_S);
    const bucketS = Math.max(5, opts.bucketS ?? CAL_DEFAULT_BUCKET_S);
    status.value = 'running';
    durationS.value = dur;
    elapsedS.value = 0;
    sampleCount.value = 0;
    timeouts.value = 0;
    stepRestarts.value = 0;
    hiddenSeen.value = false;
    stopReason.value = null;
    fit.value = null;
    selected.value = [];
    applicable.value = false;
    applied.value = false;
    saved.value = false;
    cancelled = false;
    samples = [];
    say('Calibrating. Keep this tab in the foreground.', 'info');

    const offHidden = deps.watchHidden?.(() => {
      hiddenSeen.value = true;
    });
    await deps.wakeLock?.acquire();
    let startPerf = deps.perfNow();
    let prevOffset: number | null = null;
    try {
      while (!isCancelled()) {
        elapsedS.value = (deps.perfNow() - startPerf) / 1000;
        if (elapsedS.value >= dur) break;
        try {
          const s = await probe();
          if (prevOffset !== null && Math.abs(s.wallMinusPerf - prevOffset) > CAL_STEP_LIMIT_MS) {
            // Wall clock stepped (NTP slew/step, manual change): data so far is void.
            samples = [];
            startPerf = deps.perfNow();
            stepRestarts.value++;
          }
          prevOffset = s.wallMinusPerf;
          samples.push(s);
        } catch {
          timeouts.value++;
        }
        sampleCount.value = samples.length;
        const sel = calSelect(samples, bucketS);
        selected.value = sel;
        fit.value = calFit(sel);
        await nap(intervalS * 1000);
      }
      finalDateMs = deps.dateNow();
      conclude(bucketS);
    } catch (e) {
      status.value = 'failed';
      say(`Calibration error: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      wake = null;
      offHidden?.();
      await deps.wakeLock?.release();
    }
  }

  /** Final fit, applicability and the summary message (mirrors example.html). */
  function conclude(bucketS: number): void {
    const stopped = stopReason.value;
    const kept = calSelect(samples, bucketS);
    const f = calFit(kept);
    selected.value = kept;
    fit.value = f;
    elapsedS.value = stopped ? elapsedS.value : durationS.value;
    if (f === null || f.spanS < CAL_MIN_SPAN_S) {
      status.value = 'failed';
      say(`Not enough data${stopped ? ` (${stopped})` : ''}. Run at least a few minutes.`, 'error');
      return;
    }
    const rtts = samples.map((s) => s.rttMs).sort((a, b) => a - b);
    let msg =
      (stopped ? `Stopped early (${stopped}). ` : 'Done. ') +
      `RTT min ${(rtts[0] ?? 0).toFixed(2)} / median ${median(rtts).toFixed(2)} ms; ` +
      `residual ${Math.round(f.residUs)} µs.`;
    let lvl: CalLevel = 'success';
    if (f.stderrPpm > CAL_STDERR_WARN_PPM) {
      msg += ` Uncertainty > ${CAL_STDERR_WARN_PPM} ppm: run longer.`;
      lvl = 'warning';
    }
    if (hiddenSeen.value) {
      msg += ' Tab was hidden during the run: sampling may have been throttled.';
      lvl = 'warning';
    }
    if (stepRestarts.value > 0)
      msg += ` The run restarted ${stepRestarts.value}x after clock steps.`;
    status.value = 'done';
    applicable.value = true;
    say(msg + ' Apply sends it to the device (RAM); Save keeps it in flash.', lvl);
  }

  /** Cancels a running calibration; partial data may still be applicable. */
  function cancel(): void {
    if (status.value !== 'running') return;
    cancelled = true;
    stopReason.value = 'cancelled';
    wake?.();
  }

  /**
   * Sends the final fit to the device as an `ntp` calibration.
   * @param save Also write it to flash.
   */
  async function apply(save: boolean): Promise<boolean> {
    const f = fit.value;
    if (status.value !== 'done' || f === null || !applicable.value) return false;
    const ppm = Number(f.ppm.toFixed(3));
    if (Math.abs(ppm) > 1000) {
      say('Measured error exceeds +/-1000 ppm; check the setup.', 'error');
      return false;
    }
    const out = await deps.apply(
      {
        ppm,
        source: 'ntp',
        dateUnix: Math.floor((finalDateMs || deps.dateNow()) / 1000),
        durationS: Math.round(f.spanS),
      },
      save,
    );
    applied.value = out.applied;
    saved.value = out.saved;
    if (out.applied && (!save || out.saved)) {
      say(
        `Applied ${ppm.toFixed(3)} ppm${save ? ' and saved to flash' : ' (RAM). Save to flash to keep it'}.`,
        'success',
      );
    } else if (out.applied) {
      say(`Applied ${ppm.toFixed(3)} ppm (RAM) but saving failed.`, 'warning');
    }
    return out.applied && (!save || out.saved);
  }

  /** Returns to idle (only when not running). */
  function reset(): void {
    if (status.value === 'running') return;
    status.value = 'idle';
    fit.value = null;
    selected.value = [];
    applicable.value = false;
    message.value = '';
    elapsedS.value = 0;
  }

  return {
    status,
    durationS,
    elapsedS,
    remainingS,
    progress,
    sampleCount,
    timeouts,
    stepRestarts,
    hiddenSeen,
    stopReason,
    fit,
    secPerDay,
    chart,
    applicable,
    applied,
    saved,
    message,
    level,
    start,
    cancel,
    apply,
    reset,
  };
}

/** The calibration controller type. */
export type PcCalibration = ReturnType<typeof createPcCalibration>;

/** Minimal Screen Wake Lock typing (not in every TS lib version). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/** Screen Wake Lock wrapper that swallows every failure and re-acquires on return to the tab. */
function browserWakeLock(): NonNullable<PcCalDeps['wakeLock']> {
  let sentinel: WakeLockSentinelLike | null = null;
  let held = false;
  const request = async (): Promise<void> => {
    try {
      const wl = (navigator as WakeLockNavigator).wakeLock;
      if (wl) sentinel = await wl.request('screen');
    } catch {
      /* unsupported or denied: calibration still works */
    }
  };
  const onVisible = (): void => {
    if (held && !document.hidden) void request();
  };
  return {
    async acquire() {
      held = true;
      document.addEventListener('visibilitychange', onVisible);
      await request();
    },
    async release() {
      held = false;
      document.removeEventListener('visibilitychange', onVisible);
      try {
        await sentinel?.release();
      } catch {
        /* already released */
      }
      sentinel = null;
    },
  };
}

/** Creates a calibration controller wired to the connected device and the browser. */
export function usePcCalibration(): PcCalibration {
  const connection = useConnectionStore();
  const timebase = useTimebaseStore();
  return createPcCalibration({
    getTime: () => connection.requireTransport().request('getTime', undefined, 2000),
    perfNow: () => performance.now(),
    dateNow: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async apply(body, save) {
      const applied = await timebase.setTimebase(body);
      const saved = applied && save ? await timebase.save() : false;
      return { applied, saved };
    },
    wakeLock: browserWakeLock(),
    watchHidden(cb) {
      const h = (): void => {
        if (document.hidden) cb();
      };
      document.addEventListener('visibilitychange', h);
      return () => {
        document.removeEventListener('visibilitychange', h);
      };
    },
  });
}
