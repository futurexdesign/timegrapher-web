/**
 * Pure helpers for the quartz panel: pulse residuals from a linear fit and
 * headline-rate / status-text selection from a {@link DspQuartz} snapshot.
 */
import type {
  DspQuartz,
  DspQuartzPulse,
  QuartzInhibitionStatus,
  QuartzStateName,
} from '@/protocol/types';
import { linearFit } from './tickTock';

/** One residual point of the pulse chart. */
export interface PulseResidual {
  /** Pulse sequence number. */
  seq: number;
  /** Leading-edge time (s since the measurement started). */
  tS: number;
  /** Residual of tS against the fitted line tS = a + b*seq (µs). */
  resUs: number;
  /** Leading-spike polarity. */
  polarity: 1 | -1;
}

/**
 * Residuals of pulse times against a least-squares line over the pulse
 * sequence number. A jump of the inhibition circuit shows as a step; the
 * polarity offset of the two coil halves as two parallel bands.
 * @param pulses Pulses of ONE measurement, ordered by sequence.
 * @returns Residuals (empty with fewer than 3 pulses).
 */
export function pulseResiduals(pulses: readonly DspQuartzPulse[]): PulseResidual[] {
  if (pulses.length < 3) return [];
  const fit = linearFit(
    pulses.map((p) => p.sequence),
    pulses.map((p) => p.tS),
  );
  if (!fit) return [];
  return pulses.map((p) => ({
    seq: p.sequence,
    tS: p.tS,
    resUs: (p.tS - (fit.intercept + fit.slope * p.sequence)) * 1e6,
    polarity: p.polarity,
  }));
}

/** Rates (s/d, + = gaining) selected for the active quartz mode. */
export interface QuartzRates {
  /** Headline, calibrated (motor: with inhibition). */
  headline: number;
  /** Raw oscillator rate without inhibition, calibrated. */
  raw: number;
  /** Headline against the board clock (no sample-clock correction). */
  uncal: number;
  /** The headline is meaningful. */
  valid: boolean;
}

/**
 * Picks headline / raw / uncal rates for the snapshot's mode.
 * @param q Quartz snapshot.
 * @returns Rates, or null in mechanical mode.
 */
export function quartzRates(q: DspQuartz): QuartzRates | null {
  if (q.mode === 'motor' && q.motor) {
    return {
      headline: q.motor.rateWithSDay,
      raw: q.motor.rateWithoutSDay,
      uncal: q.motor.rateWithUncalSDay,
      valid: q.rateValid && q.motor.valid,
    };
  }
  const d = q.mode === 'lcd' ? q.lcd : q.mode === 'fork' ? q.fork : null;
  if (!d) return null;
  return {
    headline: d.rateSDay,
    raw: d.rateSDay,
    uncal: d.rateUncalSDay,
    valid: q.rateValid && d.valid,
  };
}

/** Short label for the measurement state chip. */
export const QUARTZ_STATE_LABEL: Record<QuartzStateName, string> = {
  idle: 'Idle',
  waitTimebase: 'Checking clock',
  unsupportedRate: 'Unsupported rate',
  acquiring: 'Acquiring',
  measuring: 'Measuring',
  done: 'Done',
};

/**
 * Human text for the motor inhibition status.
 * @param s Status from the firmware.
 */
export function inhibitionText(s: QuartzInhibitionStatus): string {
  switch (s) {
    case 'none':
      return 'Not enough pulses yet';
    case 'no_jump_long_gate':
      return 'Rate (no inhibition detected)';
    case 'may_include_inhibition':
      return 'Raw rate, may include inhibition: try a longer gate';
    case 'need_one_more_cycle':
      return 'Raw rate, need one more inhibition cycle';
    case 'correction_pending':
      return 'Correcting: waiting for the next pulse';
    case 'corrected':
      return 'Rate corrected for inhibition';
  }
}

/**
 * Validates a custom motor gate.
 * @param s Candidate gate (s).
 * @returns True for 0 (until two inhibition events) or an integer 3..960.
 */
export function isValidGate(s: number): boolean {
  return Number.isInteger(s) && (s === 0 || (s >= 3 && s <= 960));
}
