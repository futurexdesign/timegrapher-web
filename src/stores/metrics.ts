/**
 * Metrics store: while a view "holds" it (`acquire` / `release`), claims
 * `metricsHz: 5` from the shared subscription manager and keeps the latest
 * sample plus capped level / noise / AGC series for sparklines and meters.
 * Values arrive linear (full scale = 1.0); helpers convert to dBFS.
 */
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { DspMetrics } from '@/protocol/types';
import { useConnectionStore } from './connection';
import { useSubscriptionsStore } from './subscriptions';

/** Owner id of this store's subscription claim. */
export const METRICS_OWNER = 'metrics';
/** Requested metrics push rate (Hz). */
export const METRICS_HZ = 5;
/** Maximum retained samples per series (about 2 minutes at 5 Hz). */
export const METRICS_SERIES_CAP = 600;
/** Floor used when converting silence to dBFS. */
export const DBFS_FLOOR = -120;

/**
 * Linear full-scale amplitude to dBFS, clamped at {@link DBFS_FLOOR}.
 * @param lin Linear amplitude (1.0 = full scale).
 */
export function toDbfs(lin: number): number {
  if (!(lin > 0)) return DBFS_FLOOR;
  return Math.max(DBFS_FLOOR, 20 * Math.log10(lin));
}

/**
 * Appends to a series, dropping the oldest entries beyond `cap`.
 * @param series Existing series (not mutated).
 * @param v New value.
 * @param cap Maximum length.
 */
export function pushCapped(series: readonly number[], v: number, cap: number): number[] {
  const next = series.length >= cap ? series.slice(series.length - cap + 1) : series.slice();
  next.push(v);
  return next;
}

/** Pinia store for live DSP metrics. */
export const useMetricsStore = defineStore('metrics', () => {
  const connection = useConnectionStore();
  const subs = useSubscriptionsStore();

  /** Latest metrics, or `null` before the first push. */
  const latest = ref<DspMetrics | null>(null);
  /** Peak level (pre), dBFS. */
  const preSeries = ref<number[]>([]);
  /** Noise floor, dBFS. */
  const noiseSeries = ref<number[]>([]);
  /** AGC gain, dB. */
  const agcSeries = ref<number[]>([]);

  let holders = 0;
  let off: (() => void) | null = null;

  /** Stores the latest sample and appends to the capped series. */
  function onMetrics(m: DspMetrics): void {
    latest.value = m;
    preSeries.value = pushCapped(preSeries.value, toDbfs(m.prePeak), METRICS_SERIES_CAP);
    noiseSeries.value = pushCapped(noiseSeries.value, toDbfs(m.noiseFloor), METRICS_SERIES_CAP);
    agcSeries.value = pushCapped(agcSeries.value, m.agcGainDb, METRICS_SERIES_CAP);
  }

  /** Starts receiving metrics (reference counted; call once per mounted view). */
  function acquire(): void {
    holders += 1;
    if (holders > 1) return;
    off = subs.on('metrics', onMetrics);
    void subs.claim(METRICS_OWNER, { metricsHz: METRICS_HZ });
  }

  /** Stops receiving metrics when the last holder releases. */
  function release(): void {
    if (holders === 0) return;
    holders -= 1;
    if (holders > 0) return;
    off?.();
    off = null;
    void subs.release(METRICS_OWNER);
  }

  /** Discards the retained series. */
  function reset(): void {
    latest.value = null;
    preSeries.value = [];
    noiseSeries.value = [];
    agcSeries.value = [];
  }

  watch(
    () => connection.isConnected,
    () => {
      reset();
    },
  );

  const preDb = computed(() => (latest.value ? toDbfs(latest.value.prePeak) : DBFS_FLOOR));
  const preRmsDb = computed(() => (latest.value ? toDbfs(latest.value.preRms) : DBFS_FLOOR));
  const postDb = computed(() => (latest.value ? toDbfs(latest.value.postPeak) : DBFS_FLOOR));
  const postRmsDb = computed(() => (latest.value ? toDbfs(latest.value.postRms) : DBFS_FLOOR));
  const noiseDb = computed(() => (latest.value ? toDbfs(latest.value.noiseFloor) : DBFS_FLOOR));

  return {
    latest,
    preSeries,
    noiseSeries,
    agcSeries,
    preDb,
    preRmsDb,
    postDb,
    postRmsDb,
    noiseDb,
    acquire,
    release,
    reset,
  };
});
