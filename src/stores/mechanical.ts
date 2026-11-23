/**
 * Mechanical timegrapher store.
 *
 * Collects, from the shared notify bus:
 * - `beat` (about 2 Hz): latest {@link DspBeatRate} plus a decimated, timestamped
 *   trend series (rate / beat error / amplitude; `null` = not locked / invalid,
 *   rendered as a gap), capped at {@link TREND_CAP} points (about 4 h).
 * - `beats` (<= 8 per notify, oldest first): raw per-beat residuals for the
 *   tick-tock chart, capped at {@link TICK_CAP} points (about 1 h at 10 beats/s).
 *
 * Grid restarts: `u` is relative to a grid origin, so when `gridId` changes the
 * tick trace is CLEARED (not drawn with a separator) and `gridRestarts` counts
 * it. A stream reset (signal time going backwards) clears everything.
 *
 * `begin()` / `end()` couple the device run control with this store's
 * subscription claim.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { DEFAULT_SOURCE_HZ, decodeBeatsPacked } from '@/protocol/beatsPacked';
import type { DspBeat, DspBeatRate } from '@/protocol/types';
import type { TickPoint } from '@/utils/tickTock';
import { useConnectionStore } from './connection';
import { useDeviceStore } from './device';
import { useDspStateStore } from './dspState';
import { useSnackbarStore } from './snackbar';
import { useSubscriptionsStore } from './subscriptions';

/** Subscription claim owner id. */
export const MECHANICAL_OWNER = 'timegrapher.mechanical';
/** Subscription this view needs while running. */
export const MECHANICAL_CLAIM = { beatHz: 2, beats: true } as const;
/** Max retained tick-tock points (about 1 h at 10 beats/s). */
export const TICK_CAP = 36000;
/** Max retained trend samples (about 4 h at one per second). */
export const TREND_CAP = 14400;
/** Minimum spacing between trend samples (ms); `beat` arrives at ~2 Hz. */
export const TREND_MIN_INTERVAL_MS = 900;

/** One trend sample; `null` fields are gaps. */
export interface TrendPoint {
  /** Wall-clock time (ms since epoch). */
  t: number;
  /** avgLong rate (s/d). */
  rate: number | null;
  /** avgLong beat error (ms). */
  beatError: number | null;
  /** avgLong amplitude (degrees). */
  amplitude: number | null;
}

/** Pinia store for the mechanical timegrapher data. */
export const useMechanicalStore = defineStore('mechanical', () => {
  const connection = useConnectionStore();
  const subs = useSubscriptionsStore();
  const device = useDeviceStore();
  const snackbar = useSnackbarStore();

  /** Latest `beat` snapshot. */
  const rate = shallowRef<DspBeatRate | null>(null);
  /** Tick-tock points of the current grid, ordered by seq / tS. */
  const ticks = shallowRef<TickPoint[]>([]);
  /** Bumped on every change of {@link ticks} (the array is mutated in place). */
  const tickVersion = ref(0);
  /** Trend samples, oldest first. */
  const trend = shallowRef<TrendPoint[]>([]);
  /** Bumped on every change of {@link trend}. */
  const trendVersion = ref(0);
  /** Current grid id (0 = none yet). */
  const gridId = ref(0);
  /** Number of grid restarts that cleared the trace. */
  const gridRestarts = ref(0);
  /** This store currently holds its subscription claim. */
  const claimed = ref(false);

  let lastSeq = -1;
  let lastT = Number.NEGATIVE_INFINITY;

  /** True when the firmware has no calibration (timing is uncalibrated). */
  const uncalibrated = computed(() => rate.value !== null && rate.value.calSource === 'none');

  /**
   * Handles a `beat` snapshot: stores it and appends a trend sample.
   * @param d Snapshot.
   * @param nowMs Wall-clock time of arrival (testing hook).
   */
  function ingestRate(d: DspBeatRate, nowMs: number = Date.now()): void {
    rate.value = d;
    const arr = trend.value;
    const last = arr[arr.length - 1];
    if (last && nowMs - last.t < TREND_MIN_INTERVAL_MS) return;
    const w = d.avgLong;
    const ok = d.locked && d.timebaseOk;
    arr.push({
      t: nowMs,
      rate: ok && w.rateValid ? w.rateSDay : null,
      beatError: ok && w.beatErrorValid ? w.beatErrorMs : null,
      amplitude: ok && w.amplitudeValid ? w.amplitudeDeg : null,
    });
    if (arr.length > TREND_CAP) arr.splice(0, arr.length - TREND_CAP);
    trendVersion.value++;
  }

  /**
   * Handles a `beats` notify (oldest first). Duplicates (seq not above the last
   * seen) are dropped; a `gridId` change clears the trace; time running backwards
   * is a stream reset and clears everything.
   * @param beats Beats from the notify or a `getBeats` reply (re-sorted by seq).
   */
  function ingestBeats(beats: readonly DspBeat[]): void {
    if (beats.length === 0) return;
    const sorted = [...beats].sort((a, b) => a.seq - b.seq);
    let arr = ticks.value;
    let changed = false;
    for (const b of sorted) {
      if (b.tS < lastT - 1) {
        arr = [];
        ticks.value = arr;
        lastSeq = -1;
        gridId.value = 0;
      } else if (b.seq <= lastSeq) {
        continue;
      }
      if (b.gridId !== gridId.value) {
        if (gridId.value !== 0) gridRestarts.value++;
        arr.length = 0;
        gridId.value = b.gridId;
      }
      lastSeq = b.seq;
      lastT = b.tS;
      arr.push({
        seq: b.seq,
        gridId: b.gridId,
        tS: b.tS,
        parity: b.parity,
        uUs: b.uUs,
        nominalUs: b.nominalUs,
        accepted: b.status !== 'rejected',
      });
      changed = true;
    }
    if (arr.length > TICK_CAP) arr.splice(0, arr.length - TICK_CAP + Math.floor(TICK_CAP / 10));
    if (changed) tickVersion.value++;
  }

  /**
   * Handles a `beatsPacked` notify: decodes the block and feeds it to
   * {@link ingestBeats}, so charts see the same beats as from a `beats` notify.
   * `tS` needs the stream's sample rate, taken from the latest `beat` snapshot
   * ({@link DEFAULT_SOURCE_HZ} before the first one). A block that does not
   * decode is logged and dropped; the next block continues the stream.
   * @param p Base64 text of the block.
   */
  function ingestPacked(p: string): void {
    try {
      ingestBeats(decodeBeatsPacked(p, rate.value?.sourceHz ?? DEFAULT_SOURCE_HZ));
    } catch (e) {
      console.error('packed beats dropped', e);
    }
  }

  /** Clears all collected data (not the claim). */
  function clear(): void {
    rate.value = null;
    ticks.value = [];
    trend.value = [];
    lastSeq = -1;
    lastT = Number.NEGATIVE_INFINITY;
    gridId.value = 0;
    gridRestarts.value = 0;
    tickVersion.value++;
    trendVersion.value++;
  }

  /**
   * Starts the device and claims the mechanical subscription.
   * @returns True when started.
   */
  async function begin(): Promise<boolean> {
    if (!(await device.start())) return false;
    claimed.value = true;
    await subs.claim(MECHANICAL_OWNER, MECHANICAL_CLAIM);
    return true;
  }

  /** Releases the claim, then stops the device. */
  async function end(): Promise<void> {
    await release();
    await device.stop();
  }

  /** Claims the subscription without touching the device (mode switch while running). */
  async function claim(): Promise<void> {
    claimed.value = true;
    await subs.claim(MECHANICAL_OWNER, MECHANICAL_CLAIM);
  }

  /** Releases the subscription claim without touching the device. */
  async function release(): Promise<void> {
    claimed.value = false;
    await subs.release(MECHANICAL_OWNER);
  }

  /**
   * Sets the lift angle (`patchState` beatRate.params.liftAngle, 10..90).
   * @param deg Degrees; out-of-range values are rejected locally.
   * @returns True on success.
   */
  async function setLiftAngle(deg: number): Promise<boolean> {
    if (!Number.isFinite(deg) || deg < 10 || deg > 90) return false;
    try {
      await connection
        .requireTransport()
        .request('patchState', { patch: { blocks: { beatRate: { params: { liftAngle: deg } } } } });
      /* Keep the Audio view's DSP snapshot in step with this edit. */
      void useDspStateStore().reload();
      return true;
    } catch (e) {
      snackbar.error(e, 'Lift angle');
      return false;
    }
  }

  /* Data belongs to one device: drop it when the connection goes down or a new one starts. */
  watch(
    () => connection.isConnected,
    () => {
      clear();
    },
  );

  subs.on('beat', (d) => {
    ingestRate(d);
  });
  subs.on('beats', (d) => {
    ingestBeats(d.beats);
  });
  subs.on('beatsPacked', (d) => {
    ingestPacked(d.p);
  });

  return {
    rate,
    ticks,
    tickVersion,
    trend,
    trendVersion,
    gridId,
    gridRestarts,
    claimed,
    uncalibrated,
    ingestRate,
    ingestBeats,
    ingestPacked,
    clear,
    begin,
    end,
    claim,
    release,
    setLiftAngle,
  };
});
