/**
 * Stepper-motor quartz watch: pulse source and the firmware's motor analysis.
 *
 * A motor watch steps once per `stepS` with alternating pulse polarity. Every
 * `inhibitionPeriodS` the watch IC deletes a few 8192 Hz cycles, delaying the
 * next step by `inhibitionJumpUs`. The analysis mirrors handoff section 5:
 * jump detection (interval excess over 20 µs), pooled segmented regression
 * for the raw rate, a whole-cycle rate between same-polarity jump pulses for
 * the corrected ("with inhibition") rate, and the inhibition status
 * progression `none` -> `may_include_inhibition` / `no_jump_long_gate` ->
 * `need_one_more_cycle` -> `correction_pending` -> `corrected`.
 *
 * Rates are measured against the board clock (the pulse times carry the
 * crystal error) and calibrated afterwards, exactly like the firmware.
 */
import type { DspQuartzMotor, DspQuartzPulse, QuartzInhibitionStatus } from '@/protocol/types';
import { calibrateRate, mean, median } from '../mathutil';
import type { Rng } from '../rng';
import { QUARTZ_LIMITS, type QuartzSourceParams } from './quartzTypes';

/** Step intervals the engine snaps to (s). */
const STEP_LIST = [1, 2, 2.5, 5, 10, 20, 30, 60] as const;
/** Sliding fit window (pulses). */
const FIT_CAP = 2048;
/** Pulse log capacity (firmware keeps 16). */
export const PULSE_LOG_CAP = 16;
/** Median peak/sigma below this triggers the weak-signal hint. */
const WEAK_SNR = 20;
/** 8192 Hz pulse period (µs), for the "n deleted pulses" figure. */
const PULSE_8192_US = 122.07;
/** Seconds of signal before the noise sigma counts as calibrated. */
const NOISE_CAL_S = 1;

interface Pulse {
  /** Detected-pulse counter within the measurement (0-based). */
  seq: number;
  /** Physical step number (counts missed pulses). */
  x: number;
  /** Observed leading-edge time since the measurement start (s, board clock). */
  t: number;
  polarity: 1 | -1;
  peak: number;
  snr: number;
  extras: number;
  clipped: boolean;
  /** Interval excess flagged as an inhibition jump (µs), else 0. */
  jumpUs: number;
}

/** Snaps a measured interval to the engine's step list. */
export function snapStep(intervalS: number): number {
  let best: number = STEP_LIST[0];
  for (const s of STEP_LIST) {
    if (Math.abs(s - intervalS) < Math.abs(best - intervalS)) best = s;
  }
  return best;
}

/** Result of {@link MotorModel.analyse}. */
export interface MotorAnalysis {
  /** The detail object for `DspQuartz.motor`. */
  motor: DspQuartzMotor;
  /** Corrected-or-raw headline (`rateWithSDay`). */
  headline: number;
  /** A fit exists. */
  valid: boolean;
  /** The measurement may freeze (gate 0 and two events with a correction). */
  twoEventsDone: boolean;
}

/** Motor watch source plus measurement. */
export class MotorModel {
  private readonly rng: Rng;
  private pulses: Pulse[] = [];
  private total = 0;
  private clippedPulses = 0;
  private extraPulses = 0;
  private clipped = false;
  private jumpCount = 0;
  private jumpTimes: number[] = [];
  private refIntervals: number[] = [];
  private lastObsT = -1;
  private snrWindow: number[] = [];
  private log: Pulse[] = [];

  // Physical source (continues across measurements).
  private physX = 0;
  private nextBoard = 0;
  private nextTrue = 0;
  private nextEventTrue = 0;
  private started = false;

  /** Board time at which the current measurement started (s). */
  private origin = 0;

  /** @param rng Random source. */
  constructor(rng: Rng) {
    this.rng = rng;
  }

  /**
   * Starts a fresh measurement.
   * @param boardNow Current board clock (s); the new "sample 0".
   */
  restart(boardNow: number): void {
    this.pulses = [];
    this.log = [];
    this.total = 0;
    this.clippedPulses = 0;
    this.extraPulses = 0;
    this.clipped = false;
    this.jumpCount = 0;
    this.jumpTimes = [];
    this.refIntervals = [];
    this.lastObsT = -1;
    this.snrWindow = [];
    this.origin = boardNow;
  }

  /** @returns Pulses detected since the measurement started. */
  get pulseCount(): number {
    return this.total;
  }

  /** @returns Peak level (float full scale) for the level meters. */
  peakLevel(src: QuartzSourceParams): number {
    return src.signalPeak;
  }

  /**
   * Generates the pulses due up to the board clock.
   * @param boardNow Board clock (s).
   * @param trueNow True clock (s since the source started).
   * @param xtalPpm Board crystal error (ppm).
   * @param src Physical parameters.
   * @param kSigma Detection threshold (noise sigmas).
   * @param active A motor watch is attached (else nothing is detected).
   * @param limitT When set, pulses later than this (s since measurement start) are ignored.
   */
  advance(
    boardNow: number,
    trueNow: number,
    xtalPpm: number,
    src: QuartzSourceParams,
    kSigma: number,
    active: boolean,
    limitT: number | null,
  ): void {
    if (!this.started) {
      this.started = true;
      this.nextBoard = boardNow + this.rng.range(0.1, 0.9) * src.motorStepS;
      this.nextTrue = trueNow + (this.nextBoard - boardNow) / (1 + xtalPpm * 1e-6);
      this.nextEventTrue = src.inhibitionPhaseS;
    }
    const x = 1 + xtalPpm * 1e-6;
    let guard = 0;
    while (this.nextBoard <= boardNow && guard++ < 5000) {
      let jump = 0;
      if (src.inhibitionPeriodS > 0 && this.nextTrue >= this.nextEventTrue) {
        jump = src.inhibitionJumpUs * 1e-6;
        this.nextEventTrue += src.inhibitionPeriodS;
        // Catch up when the period or phase was changed to something earlier.
        if (this.nextEventTrue <= this.nextTrue) {
          this.nextEventTrue = this.nextTrue + src.inhibitionPeriodS;
        }
      }
      const pb = this.nextBoard + jump * x;
      const px = this.physX++;
      if (active && pb >= this.origin) {
        this.detect(pb - this.origin, px, src, kSigma, limitT);
      }
      const step = src.motorStepS / (1 + src.motorRateSDay / 86400);
      this.nextTrue += step + jump;
      this.nextBoard += (step + jump) * x;
    }
  }

  private detect(
    tRel: number,
    px: number,
    src: QuartzSourceParams,
    kSigma: number,
    limitT: number | null,
  ): void {
    const polarity: 1 | -1 = (px & 1) === 0 ? 1 : -1;
    const snr = Math.max(0.1, src.motorSnr * (1 + this.rng.gaussian() * 0.08));
    if (snr <= kSigma) return;
    const t =
      tRel +
      (this.rng.gaussian() * src.motorJitterUs) / 1e6 +
      (polarity * src.polarityOffsetUs) / 2e6;
    if (limitT !== null && t > limitT) return;
    let peak = snr * src.motorNoiseSigma;
    const clipped = src.motorClipped || peak >= QUARTZ_LIMITS.adcRail;
    if (clipped) peak = QUARTZ_LIMITS.adcRail;
    const extras = this.rng.chance(src.motorExtraProb) ? 1 : 0;
    let jumpUs = 0;
    if (this.lastObsT >= 0) {
      const iv = t - this.lastObsT;
      const ref = this.refIntervals.length > 0 ? median(this.refIntervals) : iv;
      const nStep = Math.max(1, Math.round(iv / ref));
      const excess = (iv - nStep * ref) * 1e6;
      if (excess > QUARTZ_LIMITS.jumpThresholdUs) {
        jumpUs = excess;
        this.jumpCount++;
        this.jumpTimes.push(t);
      } else {
        this.refIntervals.push(iv / nStep);
        if (this.refIntervals.length > 15) this.refIntervals.shift();
      }
    }
    const p: Pulse = { seq: this.total++, x: px, t, polarity, peak, snr, extras, clipped, jumpUs };
    this.lastObsT = t;
    if (clipped) {
      this.clipped = true;
      this.clippedPulses++;
    }
    this.extraPulses += extras;
    this.pulses.push(p);
    if (this.pulses.length > FIT_CAP) this.pulses.shift();
    this.log.push(p);
    if (this.log.length > PULSE_LOG_CAP) this.log.shift();
    this.snrWindow.push(snr);
    if (this.snrWindow.length > 16) this.snrWindow.shift();
  }

  /**
   * Recent pulses, newest first.
   * @param measurementId Id stamped on each pulse.
   * @param elapsedS Signal time since the start (decides `closed`).
   * @param max Maximum number to return.
   */
  recent(measurementId: number, elapsedS: number, max: number): DspQuartzPulse[] {
    const out: DspQuartzPulse[] = [];
    for (let i = this.log.length - 1; i >= 0 && out.length < max; i--) {
      const p = this.log[i];
      if (p) out.push(this.toWire(p, measurementId, elapsedS));
    }
    return out;
  }

  /**
   * Pulses with `seq >= fromSeq` whose 50 ms group has closed, oldest first.
   * @param measurementId Id stamped on each pulse.
   * @param elapsedS Signal time since the start.
   * @param fromSeq First sequence number wanted.
   */
  closedFrom(measurementId: number, elapsedS: number, fromSeq: number): DspQuartzPulse[] {
    return this.log
      .filter((p) => p.seq >= fromSeq && elapsedS >= p.t + 0.05)
      .map((p) => this.toWire(p, measurementId, elapsedS));
  }

  private toWire(p: Pulse, measurementId: number, elapsedS: number): DspQuartzPulse {
    return {
      measurementId,
      sequence: p.seq,
      sampleIndex: String(Math.round((this.origin + p.t) * 48000)),
      tS: Math.round(p.t * 1e7) / 1e7,
      peak: Math.round(p.peak),
      snr: p.snr,
      polarity: p.polarity,
      extras: p.extras,
      clipped: p.clipped,
      closed: elapsedS >= p.t + 0.05,
    };
  }

  /**
   * Runs the motor analysis over the current pulses.
   * @param src Physical parameters (for settings that the engine reports back).
   * @param kSigma Detection threshold in effect.
   * @param calPpm Correction to apply.
   * @param elapsedS Signal time since the start.
   * @param gateS Gate in effect (0 = until two events).
   */
  analyse(
    src: QuartzSourceParams,
    kSigma: number,
    calPpm: number,
    elapsedS: number,
    gateS: number,
  ): MotorAnalysis {
    const P = this.pulses;
    const noiseOk = elapsedS >= NOISE_CAL_S;
    const noiseSigma = noiseOk ? src.motorNoiseSigma : 0;
    const peakSnr = this.snrWindow.length > 0 ? median(this.snrWindow) : 0;
    const base: DspQuartzMotor = {
      valid: false,
      pulses: this.total,
      fitPulses: P.length,
      stepS: snapStep(median(this.refIntervals) || src.motorStepS),
      spanS: P.length > 1 ? (P[P.length - 1]?.t ?? 0) - (P[0]?.t ?? 0) : 0,
      rateWithSDay: 0,
      rateWithUncalSDay: 0,
      rateWithoutSDay: 0,
      rateWithoutUncalSDay: 0,
      inhibition: 'none',
      inhibitionPeriodValid: false,
      inhibitionPeriodS: 0,
      events: this.jumpCount,
      cyclesUsed: 0,
      jumpLastUs: 0,
      jumpLastN: 0,
      jumpMeanUs: 0,
      jumpMeanN: 0,
      residualRmsUs: 0,
      polarityOffsetUs: 0,
      clipped: this.clipped,
      clippedPulses: this.clippedPulses,
      extraPulses: this.extraPulses,
      noiseSigma,
      threshold: noiseSigma * kSigma,
      peakSnr,
      hintWeakSignal: peakSnr > 0 && peakSnr < WEAK_SNR,
      hintClipped: this.clipped,
      noJumpSpanS: QUARTZ_LIMITS.noJumpSpanS,
      jumpThresholdUs: QUARTZ_LIMITS.jumpThresholdUs,
      rebuilding: false,
    };
    if (P.length < 3) return { motor: base, headline: 0, valid: false, twoEventsDone: false };

    const stepS = base.stepS;
    // Pooled regression inside the inhibition-free segments.
    let sxxAll = 0;
    let sxyAll = 0;
    const residualsByPol: Record<string, number[]> = { '1': [], '-1': [] };
    const segments: Pulse[][] = [];
    let seg: Pulse[] = [];
    for (const p of P) {
      if (p.jumpUs > 0 && seg.length > 0) {
        segments.push(seg);
        seg = [];
      }
      seg.push(p);
    }
    segments.push(seg);
    const lines: { xbar: number; tbar: number }[] = [];
    for (const s of segments) {
      const xbar = mean(s.map((p) => p.x));
      const tbar = mean(s.map((p) => p.t));
      lines.push({ xbar, tbar });
      for (const p of s) {
        sxxAll += (p.x - xbar) * (p.x - xbar);
        sxyAll += (p.x - xbar) * (p.t - tbar);
      }
    }
    const slope = sxxAll > 0 ? sxyAll / sxxAll : stepS;
    for (let i = 0; i < segments.length; i++) {
      const line = lines[i];
      if (!line) continue;
      for (const p of segments[i] ?? []) {
        const r = (p.t - line.tbar - slope * (p.x - line.xbar)) * 1e6;
        residualsByPol[String(p.polarity)]?.push(r);
      }
    }
    const mPos = mean(residualsByPol['1'] ?? []);
    const mNeg = mean(residualsByPol['-1'] ?? []);
    let ss = 0;
    let n = 0;
    for (const key of ['1', '-1'] as const) {
      const m = key === '1' ? mPos : mNeg;
      for (const r of residualsByPol[key] ?? []) {
        ss += (r - m) * (r - m);
        n++;
      }
    }
    const rawUncal = (stepS / slope - 1) * 86400;

    // Inhibition status and the whole-cycle (corrected) rate.
    const jumps = P.filter((p) => p.jumpUs > 0);
    let withUncal = rawUncal;
    let status: QuartzInhibitionStatus;
    let cyclesUsed = 0;
    let twoEventsDone = false;
    const jf = jumps[0];
    if (jumps.length === 0) {
      status =
        base.spanS >= QUARTZ_LIMITS.noJumpSpanS ? 'no_jump_long_gate' : 'may_include_inhibition';
    } else if (jumps.length === 1) {
      status = 'need_one_more_cycle';
    } else {
      status = 'correction_pending';
      let jl: Pulse | undefined;
      for (let i = jumps.length - 1; i > 0; i--) {
        const c = jumps[i];
        if (c && jf && c.polarity === jf.polarity) {
          jl = c;
          cyclesUsed = i;
          break;
        }
      }
      if (jf && jl && P.length - 1 - P.indexOf(jl) >= 2) {
        const interval = (jl.t - jf.t) / (jl.x - jf.x);
        withUncal = (stepS / interval - 1) * 86400;
        status = 'corrected';
        twoEventsDone = true;
      } else {
        cyclesUsed = 0;
      }
    }
    const jumpSizes = jumps.map((p) => p.jumpUs);
    const spacing: number[] = [];
    for (let i = 1; i < this.jumpTimes.length; i++) {
      spacing.push((this.jumpTimes[i] ?? 0) - (this.jumpTimes[i - 1] ?? 0));
    }
    const lastJump = jumpSizes.length > 0 ? (jumpSizes[jumpSizes.length - 1] ?? 0) : 0;
    const motor: DspQuartzMotor = {
      ...base,
      valid: true,
      rateWithSDay: calibrateRate(withUncal, calPpm),
      rateWithUncalSDay: withUncal,
      rateWithoutSDay: calibrateRate(rawUncal, calPpm),
      rateWithoutUncalSDay: rawUncal,
      inhibition: status,
      inhibitionPeriodValid: spacing.length >= 1,
      inhibitionPeriodS: spacing.length >= 1 ? median(spacing) : 0,
      cyclesUsed,
      jumpLastUs: lastJump,
      jumpLastN: Math.round(lastJump / PULSE_8192_US),
      jumpMeanUs: mean(jumpSizes),
      jumpMeanN: Math.round(mean(jumpSizes) / PULSE_8192_US),
      residualRmsUs: n > 0 ? Math.sqrt(ss / n) : 0,
      polarityOffsetUs: Math.abs(mPos - mNeg),
    };
    return {
      motor,
      headline: motor.rateWithSDay,
      valid: true,
      twoEventsDone: twoEventsDone && gateS === 0,
    };
  }
}
