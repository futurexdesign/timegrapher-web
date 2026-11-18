/**
 * Small numeric helpers shared by the simulator models.
 */

/** Seconds per day gained or lost per ppm of clock error (matches the app's calibration maths). */
export const S_PER_DAY_PER_PPM = 0.0864;

/**
 * Clamps a number into `[lo, hi]`.
 * @param v Value.
 * @param lo Lower bound.
 * @param hi Upper bound.
 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Median of a list (upper median for even lengths, as the firmware's `tmp[n/2]`).
 * @param values Samples; not modified.
 * @returns The median, or 0 for an empty list.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Arithmetic mean.
 * @param values Samples.
 * @returns The mean, or 0 for an empty list.
 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * Converts a true rate to what a clock with a given error measures.
 *
 * A board clock fast by `xtalPpm` counts more seconds than elapse, so a
 * watch looks slower; applying a correction `calPpm` (equal to the clock
 * error for a perfect calibration) removes that.
 *
 * @param trueSDay True rate (s/d, + = gaining).
 * @param xtalPpm Board clock error (ppm, + = fast).
 * @param calPpm Correction applied (ppm, + = board fast); 0 gives the "uncal" rate.
 * @returns The measured rate in s/d.
 */
export function measuredRate(trueSDay: number, xtalPpm: number, calPpm: number): number {
  const g = 1 + trueSDay / 86400;
  return (g * ((1 + calPpm * 1e-6) / (1 + xtalPpm * 1e-6)) - 1) * 86400;
}

/**
 * Applies a sample-clock correction to an already board-measured rate.
 * @param uncalSDay Rate against the board clock (s/d).
 * @param calPpm Correction (ppm, + = board fast).
 * @returns The calibrated rate (s/d).
 */
export function calibrateRate(uncalSDay: number, calPpm: number): number {
  return ((1 + uncalSDay / 86400) * (1 + calPpm * 1e-6) - 1) * 86400;
}

/**
 * Rounds to a number of decimals (keeps JSON payloads compact and stable).
 * @param v Value.
 * @param decimals Decimal places.
 */
export function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
