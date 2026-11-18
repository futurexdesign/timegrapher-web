/**
 * Shared types for the quartz-watch models (motor, LCD, tuning fork).
 */
import type { TimebaseSource } from '@/protocol/types';

/** What is physically on the stand. Only the matching engine mode sees a signal. */
export type WatchKind = 'none' | 'mechanical' | 'motor' | 'lcd' | 'fork';

/** Physical description of a quartz watch (all three kinds; the attached kind selects which is used). */
export interface QuartzSourceParams {
  /** Motor: raw oscillator rate (s/d, + = gaining), i.e. "without inhibition". */
  motorRateSDay: number;
  /** Motor: nominal step interval (s); the engine snaps it to 1/2/2.5/5/10/20/30/60. */
  motorStepS: number;
  /** Motor: inhibition period (s); 0 = the watch has no inhibition compensation. */
  inhibitionPeriodS: number;
  /** Motor: size of one inhibition jump (µs); 4 pulses of 8192 Hz = 488.28. */
  inhibitionJumpUs: number;
  /** Motor: signal time of the first inhibition event after power-up (s). */
  inhibitionPhaseS: number;
  /** Motor: RMS timing jitter of the detected leading edge (µs). */
  motorJitterUs: number;
  /** Motor: constant edge offset between the two coil polarities (µs). */
  polarityOffsetUs: number;
  /** Motor: mean pulse peak / noise sigma. */
  motorSnr: number;
  /** Motor: noise sigma after the 400 Hz high-pass (ADC codes). */
  motorNoiseSigma: number;
  /** Motor: force the ADC to the rail (JP1 closed). */
  motorClipped: boolean;
  /** Motor: probability of an extra detection burst in a pulse group. */
  motorExtraProb: number;
  /** LCD: oscillator rate (s/d). */
  lcdRateSDay: number;
  /** LCD: pattern rate (Hz): 16 / 32 / 64 / 128. */
  lcdPatternHz: number;
  /** LCD: the capacitive pickup sees no pattern (watch not positioned). */
  lcdNoPattern: boolean;
  /** Fork: rate (s/d). */
  forkRateSDay: number;
  /** Signal peak (float full scale) used for the level meters. */
  signalPeak: number;
}

/** Defaults: a typical analog quartz watch with a 60 s inhibition cycle. */
export const DEFAULT_QUARTZ_SOURCE: QuartzSourceParams = {
  motorRateSDay: 0.9,
  motorStepS: 1,
  inhibitionPeriodS: 60,
  inhibitionJumpUs: 488.28,
  inhibitionPhaseS: 23,
  motorJitterUs: 1.65,
  polarityOffsetUs: 0.12,
  /* A well-placed watch; the firmware's weak-signal hint starts at SNR 16. */
  motorSnr: 50,
  motorNoiseSigma: 9900,
  motorClipped: false,
  motorExtraProb: 0,
  lcdRateSDay: 0.35,
  lcdPatternHz: 64,
  lcdNoPattern: false,
  forkRateSDay: -1.2,
  signalPeak: 0.2,
};

/** Environment the quartz models read on each step. */
export interface QuartzContext {
  /** Watch on the stand. */
  attached: WatchKind;
  /** Analysis sample rate (Hz); 48000 is required to measure. */
  sourceHz: number;
  /** Capture rate verified. */
  timebaseOk: boolean;
  /** Board crystal error (ppm, + = fast). */
  xtalPpm: number;
  /** Correction in effect (ppm). */
  calPpm: number;
  /** Where the correction came from. */
  calSource: TimebaseSource;
}

/** Hard limits of the quartz settings (firmware `quartz_engine.cpp`). */
export const QUARTZ_LIMITS = {
  gateMinS: 3,
  gateMaxS: 960,
  kSigmaMin: 4,
  kSigmaMax: 20,
  /** Longest expected inhibition period x 2 (s). */
  noJumpSpanS: 120,
  /** Interval excess that counts as an inhibition jump (µs). */
  jumpThresholdUs: 20,
  /** ADC rail (24-bit signed). */
  adcRail: 8388607,
  /** Selectable fork frequencies (Hz). */
  forkHz: [300, 1024 / 3, 360, 480, 720] as readonly number[],
} as const;
