/**
 * Timebase model: the board crystal (true ppm error with slow
 * temperature-like drift), the device microsecond counter behind `getTime`,
 * the stored calibration (RAM value and the flash copy) and the GPS PPS
 * averaging filter.
 *
 * The counter runs at `1 + ppm*1e-6` of the host clock, so the app's
 * PC-assisted calibration (`src/utils/calibration.ts`) measures the
 * configured ppm.
 */
import type { TimebaseSource } from '@/protocol/types';
import type { Rng } from '../rng';

/** Largest accepted |ppm| (firmware `TIMEBASE_PPM_MAX`). */
export const TIMEBASE_PPM_MAX = 1000;
/** PPS averaging window (pulses). */
export const PPS_WINDOW = 64;

/** Crystal behaviour parameters. */
export interface TimebaseSimParams {
  /** Mean board crystal error (ppm, + = fast). */
  crystalPpm: number;
  /** Amplitude of the temperature-like sinusoidal drift (ppm). */
  driftPpm: number;
  /** Period of the drift (s of simulated time). */
  driftPeriodS: number;
  /** Random-walk strength (ppm per sqrt(s)). */
  walkPpmPerSqrtS: number;
  /** PPS single-pulse measurement noise, 1 sigma (ppm). */
  ppsNoisePpm: number;
  /** Pulses of valid PPS needed before the filter reports locked. */
  ppsLockPulses: number;
}

/** Defaults: a crystal 12.3 ppm fast with +-0.4 ppm drift. */
export const DEFAULT_TIMEBASE: TimebaseSimParams = {
  crystalPpm: 12.3,
  driftPpm: 0.4,
  driftPeriodS: 1800,
  walkPpmPerSqrtS: 0.0004,
  ppsNoisePpm: 0.3,
  ppsLockPulses: 16,
};

/** The stored (RAM) calibration. */
export interface Calibration {
  ppm: number;
  source: Exclude<TimebaseSource, 'pps'>;
  dateUnix: number;
  durationS: number;
}

/** PPS filter state, as reported in `Timebase.pps`. */
export interface PpsState {
  locked: boolean;
  ppm: number;
  window: number;
  good: number;
  rejects: number;
  noFix: number;
  /** Seconds of continuous lock (for the log policy). */
  lockedS: number;
}

/** Crystal + counter + calibration store + PPS filter. */
export class TimebaseModel {
  /** Crystal parameters; mutate between advances. */
  params: TimebaseSimParams;
  /** Stored calibration (RAM). */
  cal: Calibration = { ppm: 0, source: 'none', dateUnix: 0, durationS: 0 };

  private readonly rng: Rng;
  private readonly phase: number;
  private flash: Calibration | null = null;
  private t = 0;
  private walk = 0;
  private counterUs: number;
  private ppsFrac = 0;
  private ring: number[] = [];
  private good = 0;
  private rejects = 0;
  private noFix = 0;
  private lockedS = 0;

  /**
   * @param rng Random source.
   * @param params Initial crystal parameters.
   */
  constructor(rng: Rng, params: TimebaseSimParams = DEFAULT_TIMEBASE) {
    this.rng = rng;
    this.params = { ...params };
    this.phase = rng.range(0, 2 * Math.PI);
    this.counterUs = 5_000_000 + Math.floor(rng.range(0, 1_000_000));
  }

  /** @returns The true board crystal error now (ppm, + = fast). */
  get xtalPpm(): number {
    const p = this.params;
    const drift =
      p.driftPeriodS > 0
        ? p.driftPpm * Math.sin((2 * Math.PI * this.t) / p.driftPeriodS + this.phase)
        : 0;
    return p.crystalPpm + drift + this.walk;
  }

  /** @returns The device microsecond counter. */
  get counter(): number {
    return this.counterUs;
  }

  /**
   * Advances the slow processes (drift, random walk).
   * @param dtSimS Simulated seconds.
   */
  advanceSlow(dtSimS: number): void {
    this.t += dtSimS;
    if (this.params.walkPpmPerSqrtS > 0) {
      this.walk += this.rng.gaussian() * this.params.walkPpmPerSqrtS * Math.sqrt(dtSimS);
    }
  }

  /**
   * Advances the counter, which follows host time (not accelerated).
   * @param dtRealMs Real milliseconds elapsed.
   */
  advanceCounter(dtRealMs: number): void {
    this.counterUs += dtRealMs * 1000 * (1 + this.xtalPpm * 1e-6);
  }

  /**
   * Advances the PPS filter, one pulse per simulated second.
   * @param dtSimS Simulated seconds.
   * @param pulsing The receiver outputs pulses (has time).
   * @param fix GPS has a position fix (pulses without a fix are ignored).
   */
  advancePps(dtSimS: number, pulsing: boolean, fix: boolean): void {
    this.ppsFrac += dtSimS;
    let guard = 0;
    while (this.ppsFrac >= 1 && guard++ < 200000) {
      this.ppsFrac -= 1;
      if (!pulsing) continue;
      if (!fix) {
        this.noFix++;
        this.ring = [];
        this.lockedS = 0;
        continue;
      }
      if (this.rng.chance(0.004)) {
        this.rejects++;
        continue;
      }
      this.good++;
      this.ring.push(this.xtalPpm + this.rng.gaussian() * this.params.ppsNoisePpm);
      if (this.ring.length > PPS_WINDOW) this.ring.shift();
      if (this.ring.length >= this.params.ppsLockPulses) this.lockedS++;
    }
    if (!fix || !pulsing) {
      this.lockedS = 0;
      if (!fix) this.ring = [];
    }
  }

  /** Forgets the PPS filter (receiver power cycle). */
  resetPps(): void {
    this.ring = [];
    this.good = 0;
    this.rejects = 0;
    this.noFix = 0;
    this.lockedS = 0;
    this.ppsFrac = 0;
  }

  /** @returns The PPS filter state. */
  pps(): PpsState {
    const n = this.ring.length;
    const locked = n >= this.params.ppsLockPulses;
    let sum = 0;
    for (const v of this.ring) sum += v;
    return {
      locked,
      ppm: n > 0 ? sum / n : 0,
      window: n,
      good: this.good,
      rejects: this.rejects,
      noFix: this.noFix,
      lockedS: locked ? this.lockedS : 0,
    };
  }

  /** @returns The correction in effect (PPS while locked, else stored) and its source. */
  effective(ppsEnabled: boolean): { ppm: number; source: TimebaseSource } {
    const p = this.pps();
    if (ppsEnabled && p.locked) return { ppm: p.ppm, source: 'pps' };
    return { ppm: this.cal.ppm, source: this.cal.source };
  }

  /**
   * Sets the stored calibration (RAM only), as `timebase_set`.
   * @param ppm Correction.
   * @param source `manual`, `ntp` or `none` (ppm 0 with `manual` is stored as `none`).
   * @param dateUnix Measurement date; 0 takes `utcNow`.
   * @param durationS Measurement length.
   * @param utcNow GPS UTC, 0 = unknown.
   * @returns `false` when out of range.
   */
  set(
    ppm: number,
    source: 'manual' | 'ntp' | 'none',
    dateUnix: number,
    durationS: number,
    utcNow: number,
  ): boolean {
    if (!Number.isFinite(ppm) || Math.abs(ppm) > TIMEBASE_PPM_MAX) return false;
    const src: Calibration['source'] = ppm === 0 && source === 'manual' ? 'none' : source;
    this.cal = { ppm, source: src, dateUnix: dateUnix === 0 ? utcNow : dateUnix, durationS };
    return true;
  }

  /** Clears the stored calibration (RAM): 0 ppm, source none. */
  clear(): void {
    this.cal = { ppm: 0, source: 'none', dateUnix: 0, durationS: 0 };
  }

  /** Commits the stored calibration to the flash copy. */
  commit(): void {
    this.flash = { ...this.cal };
  }

  /** @returns `true` when the flash copy equals the stored calibration. */
  get saved(): boolean {
    const f = this.flash;
    const c = this.cal;
    return (
      f !== null &&
      f.ppm === c.ppm &&
      f.source === c.source &&
      f.dateUnix === c.dateUnix &&
      f.durationS === c.durationS
    );
  }
}
