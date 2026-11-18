/**
 * LCD (capacitive pattern) and tuning-fork (tone) quartz measurements.
 *
 * Both firmware pipelines estimate the rate as the slope of a phase against
 * time. The simulator keeps the same observable progression (pattern
 * detection, then 0.5 s / 0.25 s phase blocks) and an estimate whose error
 * shrinks as `blocks^-1.5`, the behaviour of a least-squares phase slope.
 * The error realisation is drawn once per measurement, so a measurement
 * converges smoothly instead of flickering between snapshots.
 */
import type { DspQuartzFork, DspQuartzLcd } from '@/protocol/types';
import { calibrateRate, measuredRate } from '../mathutil';
import type { Rng } from '../rng';
import type { QuartzSourceParams } from './quartzTypes';

/** Seconds the LCD pattern search takes before tracking starts. */
const LCD_DETECT_S = 2;
/** LCD phase block length (s). */
const LCD_BLOCK_S = 0.5;
/** Fork phase block length (s). */
const FORK_BLOCK_S = 0.25;
/** Estimator error at one block (s/d). */
const SIGMA_ONE_BLOCK_SDAY = 3;

/** Result shared by both snapshots. */
interface ToneEstimate {
  rateUncal: number;
  rateCal: number;
}

/**
 * Phase-slope estimate for a true rate.
 * @param trueSDay True rate.
 * @param blocks Phase blocks in the fit.
 * @param z Per-measurement standard-normal draw.
 * @param xtalPpm Board crystal error.
 * @param calPpm Correction applied.
 */
function estimate(
  trueSDay: number,
  blocks: number,
  z: number,
  xtalPpm: number,
  calPpm: number,
): ToneEstimate {
  const err = (z * SIGMA_ONE_BLOCK_SDAY) / Math.pow(Math.max(blocks, 1), 1.5);
  const uncal = measuredRate(trueSDay + err, xtalPpm, 0);
  return { rateUncal: uncal, rateCal: calibrateRate(uncal, calPpm) };
}

/** LCD pattern measurement. */
export class LcdModel {
  private readonly rng: Rng;
  private elapsed = 0;
  private z = 0;

  /** @param rng Random source for the estimator error. */
  constructor(rng: Rng) {
    this.rng = rng;
    this.restart();
  }

  /** Starts a new measurement. */
  restart(): void {
    this.elapsed = 0;
    this.z = this.rng.gaussian();
  }

  /**
   * Advances measurement time.
   * @param dtS Signal seconds.
   */
  advance(dtS: number): void {
    this.elapsed += dtS;
  }

  /** @returns Number of 0.5 s phase blocks accumulated. */
  private blocks(): number {
    return Math.max(0, Math.floor((this.elapsed - LCD_DETECT_S) / LCD_BLOCK_S));
  }

  /**
   * Builds the `lcd` detail.
   * @param src Physical parameters.
   * @param present An LCD watch is attached.
   * @param xtalPpm Board crystal error.
   * @param calPpm Correction applied.
   */
  snapshot(
    src: QuartzSourceParams,
    present: boolean,
    xtalPpm: number,
    calPpm: number,
  ): DspQuartzLcd {
    const detecting = this.elapsed < LCD_DETECT_S;
    if (!present || src.lcdNoPattern) {
      return {
        valid: false,
        status: detecting ? 'detecting_period' : 'no_pattern',
        f0Hz: 0,
        harmonics: [],
        blocks: 0,
        rateSDay: 0,
        rateUncalSDay: 0,
        retries: detecting ? 0 : Math.floor((this.elapsed - LCD_DETECT_S) / LCD_DETECT_S) + 1,
        clipped: false,
      };
    }
    if (detecting) {
      return {
        valid: false,
        status: 'detecting_period',
        f0Hz: 0,
        harmonics: [],
        blocks: 0,
        rateSDay: 0,
        rateUncalSDay: 0,
        retries: 0,
        clipped: false,
      };
    }
    const blocks = this.blocks();
    const valid = blocks >= 2;
    const est = estimate(src.lcdRateSDay, blocks, this.z, xtalPpm, calPpm);
    return {
      valid,
      status: 'tracking',
      f0Hz: src.lcdPatternHz,
      harmonics: [1, 2, 3, 4],
      blocks,
      rateSDay: valid ? est.rateCal : 0,
      rateUncalSDay: valid ? est.rateUncal : 0,
      retries: 0,
      clipped: false,
    };
  }
}

/** Tuning-fork tone measurement. */
export class ForkModel {
  private readonly rng: Rng;
  private elapsed = 0;
  private z = 0;

  /** @param rng Random source for the estimator error. */
  constructor(rng: Rng) {
    this.rng = rng;
    this.restart();
  }

  /** Starts a new measurement. */
  restart(): void {
    this.elapsed = 0;
    this.z = this.rng.gaussian();
  }

  /**
   * Advances measurement time.
   * @param dtS Signal seconds.
   */
  advance(dtS: number): void {
    this.elapsed += dtS;
  }

  /**
   * Builds the `fork` detail.
   * @param src Physical parameters.
   * @param present A tuning-fork watch is attached.
   * @param forkHz Nominal frequency in effect.
   * @param xtalPpm Board crystal error.
   * @param calPpm Correction applied.
   */
  snapshot(
    src: QuartzSourceParams,
    present: boolean,
    forkHz: number,
    xtalPpm: number,
    calPpm: number,
  ): DspQuartzFork {
    const blocks = present ? Math.floor(this.elapsed / FORK_BLOCK_S) : 0;
    const valid = present && blocks >= 2;
    const est = estimate(src.forkRateSDay, blocks, this.z, xtalPpm, calPpm);
    return {
      valid,
      fNomHz: forkHz,
      blocks,
      rateSDay: valid ? est.rateCal : 0,
      rateUncalSDay: valid ? est.rateUncal : 0,
      clipped: false,
    };
  }
}
