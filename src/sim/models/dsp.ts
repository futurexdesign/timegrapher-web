/**
 * DSP telemetry model: level meters, noise floor, AGC gain, clip / limiter
 * counters, matched-filter score, spectrum peaks and CPU timing, derived from
 * the signal the active watch model produces and from which blocks are
 * enabled in the {@link DspStateStore}.
 *
 * Reactions that mirror the real graph: analysis taps the RAW input (so the
 * noise floor does not depend on the process chain), the process path only
 * runs with bypass off, the limiter clamps at 1.0 and counts, a disabled
 * limiter lets PCM24 clip instead, the AGC drifts toward `target` within
 * +-12 dB with time constant `tauS` and reports 0 when off.
 */
import type { DspBlockKey, DspMatched, DspMetrics, DspSpectrum, DspTiming } from '@/protocol/types';
import { clamp } from '../mathutil';
import type { Rng } from '../rng';
import { BLOCK_ORDER, PROCESS_BLOCKS, type DspStateStore } from '../dspState';

/** What the active signal source looks like to the DSP. */
export interface SignalInput {
  /** A signal source is running and attached. */
  active: boolean;
  /** Tick / pulse peak level (float full scale). */
  peak: number;
  /** Ticks (events) per second. */
  rate: number;
  /** Seconds since the last tick. */
  sinceTickS: number;
  /** Background noise floor (float full scale). */
  noise: number;
  /** Mean spectral content of the source (for `getSpectrum`). */
  spectrumHz: readonly number[];
}

const FILTER_LOSS_DB = [0, 0.3, 0.8, 1.6] as const;
/** Approximate cost of each block per capture block (µs, RP2350 at 150 MHz). */
const BLOCK_COST_US: Readonly<Record<DspBlockKey, number>> = {
  levelMeter: 12,
  gain: 5,
  limiter: 8,
  filterBank: 60,
  eventDetect: 40,
  beatRate: 6,
  noiseFloor: 10,
  eventLog: 4,
  softGate: 22,
  notch: 28,
  agc: 25,
  matchedFilter: 110,
  firBank: 150,
  spectrum: 95,
};
const BLOCK_SAMPLES = 240;

/** Telemetry model. */
export class DspModel {
  private readonly rng: Rng;
  private agcDb = 0;
  private clipFrac = 0;
  private limFrac = 0;
  private clip = 0;
  private lim = 0;
  private ticksSeen = 0;
  private runS = 0;
  private lastSignal: SignalInput | null = null;
  private lastPre = 0;
  private timingMean = 0;
  private timingMax = 0;
  private resetT = 0;

  /** @param rng Random source for small measurement scatter. */
  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** Stream reset: counters and AGC restart. */
  reset(): void {
    this.agcDb = 0;
    this.clip = 0;
    this.lim = 0;
    this.clipFrac = 0;
    this.limFrac = 0;
    this.ticksSeen = 0;
    this.runS = 0;
    this.timingMean = 0;
    this.timingMax = 0;
  }

  /** Clears the timing maxima (`resetTiming`). */
  resetTiming(): void {
    this.timingMax = 0;
    this.resetT = this.runS;
  }

  /**
   * Advances the dynamics while capture runs.
   * @param dtS Signal seconds.
   * @param sig Source description.
   * @param st DSP state.
   */
  step(dtS: number, sig: SignalInput, st: DspStateStore): void {
    this.runS += dtS;
    this.lastSignal = sig;
    const ticks = sig.active ? sig.rate * dtS : 0;
    this.ticksSeen += ticks;
    const pre = this.prePeak(sig);
    this.lastPre = pre;
    // AGC: drift toward target peak within +-12 dB.
    if (st.enabled('agc') && st.processing) {
      const base = pre * 10 ** (this.chainDbBeforeAgc(st) / 20);
      const target = st.param('agc', 'target');
      const want = clamp(20 * Math.log10(target / Math.max(base, 1e-6)), -12, 12);
      const tau = Math.max(0.05, st.param('agc', 'tauS'));
      this.agcDb += (want - this.agcDb) * (1 - Math.exp(-dtS / tau));
    } else {
      this.agcDb = 0;
    }
    st.live.agcGainDb = this.agcDb;
    // Post-chain clamp accounting.
    const post = pre * 10 ** (this.chainDb(st) / 20);
    if (post > 1 && ticks > 0) {
      if (st.enabled('limiter') && st.processing) {
        this.limFrac += ticks;
      } else {
        this.clipFrac += ticks;
      }
      const l = Math.floor(this.limFrac);
      const c = Math.floor(this.clipFrac);
      this.lim += l;
      this.clip += c;
      this.limFrac -= l;
      this.clipFrac -= c;
    }
    st.live.matchScore = this.matchScore(st);
  }

  /** @param st DSP state. @returns The `getMetrics` payload. */
  metrics(st: DspStateStore): DspMetrics {
    const sig = this.lastSignal;
    const noise = sig?.noise ?? 1e-4;
    const pre = this.lastPre;
    const chain = st.processing ? 10 ** (this.chainDb(st) / 20) : 1;
    let post = pre * chain;
    if (post > 1) post = 1;
    const preRms = Math.max(noise, pre * 0.06 * Math.sqrt(Math.min(sig?.rate ?? 0, 10) / 4 + 0.05));
    const gateCut = st.enabled('softGate') && st.processing ? 0.6 : 1;
    const postRms = Math.min(1, preRms * chain * gateCut);
    return {
      prePeak: pre,
      postPeak: post,
      preRms,
      postRms,
      noiseFloor: noise,
      agcGainDb: this.agcDb,
      matchScore: this.matchScore(st),
      clipCount: this.clip,
      limiterCount: this.lim,
    };
  }

  /** @param st DSP state. @returns The `getMatched` payload. */
  matched(st: DspStateStore): DspMatched {
    const learned = st.enabled('matchedFilter') && this.ticksSeen >= 16;
    return {
      score: this.matchScore(st),
      templatePeak: learned ? (this.lastSignal?.peak ?? 0) : 0,
      templateLen: learned ? 480 : 0,
      learned,
    };
  }

  /**
   * @param st DSP state.
   * @param sourceHz Analysis rate.
   * @returns The `getSpectrum` payload (empty until the block is enabled and running).
   */
  spectrum(st: DspStateStore, sourceHz: number): DspSpectrum {
    const sig = this.lastSignal;
    if (!st.enabled('spectrum') || sig === null || !sig.active || this.runS <= 0.2) {
      return { valid: false, fftN: 0, sourceHz, nPeaks: 0, peaks: [] };
    }
    const peaks = sig.spectrumHz.slice(0, 8).map((hz, i) => ({
      hz: Math.round((hz + this.rng.gaussian() * 15) * 10) / 10,
      mag: Math.round(sig.peak * 0.5 * 0.6 ** i * 1e5) / 1e5,
    }));
    return { valid: true, fftN: 512, sourceHz, nPeaks: peaks.length, peaks };
  }

  /**
   * @param st DSP state.
   * @param quartzActive A quartz mode is selected (engine costs time).
   * @returns The `getTiming` / `timing` payload.
   */
  timing(st: DspStateStore, quartzActive: boolean): DspTiming {
    let us = 140;
    for (const k of BLOCK_ORDER) {
      if (st.enabled(k) && (!PROCESS_BLOCKS.has(k) || st.processing)) us += BLOCK_COST_US[k];
    }
    const last = Math.round(us + this.rng.range(-4, 8));
    this.timingMean = this.timingMean === 0 ? last : this.timingMean * 0.95 + last * 0.05;
    this.timingMax = Math.max(this.timingMax, last + 6);
    const budget = Math.round((BLOCK_SAMPLES * 1e6) / 48000);
    const blocks = Math.floor((this.runS - this.resetT) * 200);
    const busy = clamp(Math.round((this.timingMean / budget) * 100 * 0.75 + 4), 0, 100);
    const q = quartzActive ? 90 + Math.round(this.rng.range(0, 10)) : 6;
    return {
      dspBlockUsLast: last,
      dspBlockUsMean: Math.round(this.timingMean),
      dspBlockUsMax: this.timingMax,
      dspBlockBudgetUs: budget,
      dspBlockSamples: BLOCK_SAMPLES,
      dspBlocks: blocks,
      loopUsLast: 380 + Math.round(this.rng.range(0, 40)),
      loopUsMean: 400,
      loopUsMax: 900,
      loopCount: Math.floor(this.runS * 2500),
      idleUsPerS: Math.round((1 - busy / 100) * 1e6),
      loopBusyPct: busy,
      underruns: 0,
      shortWrites: 0,
      ringMin: 420,
      ringMax: 980,
      quartzBlockUsLast: q,
      quartzBlockUsMean: q,
      quartzBlockUsMax: q + 12,
      quartzBlocks: blocks,
    };
  }

  private prePeak(sig: SignalInput): number {
    if (!sig.active) return sig.noise * 4;
    const env = 0.6 + 0.4 * Math.exp(-Math.min(sig.sinceTickS, 5) / 0.15);
    return Math.max(sig.noise * 4, sig.peak * env);
  }

  private chainDbBeforeAgc(st: DspStateStore): number {
    let db = 0;
    if (st.enabled('filterBank'))
      db -= FILTER_LOSS_DB[Math.trunc(st.param('filterBank', 'preset'))] ?? 0;
    if (st.enabled('firBank')) db -= FILTER_LOSS_DB[Math.trunc(st.param('firBank', 'preset'))] ?? 0;
    if (st.enabled('notch')) db -= 0.1;
    if (st.enabled('gain')) db += st.param('gain', 'db');
    return db;
  }

  private chainDb(st: DspStateStore): number {
    return this.chainDbBeforeAgc(st) + (st.enabled('agc') ? this.agcDb : 0);
  }

  private matchScore(st: DspStateStore): number {
    if (!st.enabled('matchedFilter') || this.ticksSeen < 4) return 0;
    const learn = 1 - Math.exp(-this.ticksSeen / 40);
    return Math.round((0.35 + 0.55 * learn + this.rng.range(-0.02, 0.02)) * 1000) / 1000;
  }
}
