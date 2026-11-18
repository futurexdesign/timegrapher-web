/**
 * Shared number / rate formatting helpers for the UI. Pure functions, no
 * Vue dependencies, so any view can import them.
 *
 * Conventions: rates in s/d with an explicit sign (+ = gaining), beat error in
 * ms, amplitude in degrees. Invalid or missing numbers render as an em dash.
 */

/** Placeholder shown for a missing / invalid number. */
export const NO_VALUE = '—';

/**
 * True for a finite number.
 * @param v Any value.
 */
export function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Fixed-point formatting with a placeholder for missing values.
 * @param v Value.
 * @param digits Fraction digits.
 * @param placeholder Text for null / NaN.
 */
export function fmtFixed(
  v: number | null | undefined,
  digits = 1,
  placeholder: string = NO_VALUE,
): string {
  return isNum(v) ? v.toFixed(digits) : placeholder;
}

/**
 * Fixed-point formatting with an explicit leading `+` for positive values.
 * Negative zero (after rounding) is shown unsigned.
 * @param v Value.
 * @param digits Fraction digits.
 */
export function fmtSigned(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return NO_VALUE;
  const s = v.toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/**
 * Signed rate in s/d (no unit suffix).
 * @param v Rate.
 * @param valid False renders the placeholder.
 * @param digits Fraction digits.
 */
export function fmtRate(v: number | null | undefined, valid = true, digits = 1): string {
  return valid ? fmtSigned(v, digits) : NO_VALUE;
}

/**
 * Integer with thousands separators, e.g. 28 800.
 * @param v Value.
 */
export function fmtThousands(v: number | null | undefined): string {
  return isNum(v) ? Math.round(v).toLocaleString('en-US').replace(/,/g, ' ') : NO_VALUE;
}

/**
 * Duration as `m:ss` (or `h:mm:ss` from one hour).
 * @param seconds Duration in seconds.
 */
export function fmtDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return NO_VALUE;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Smallest "nice" symmetric scale (1, 2, 5 x 10^n) that contains `maxAbs`.
 * @param maxAbs Largest absolute value to contain.
 * @param min Lower bound of the result.
 */
export function niceScale(maxAbs: number, min = 1): number {
  if (!isNum(maxAbs) || maxAbs <= min) return min;
  const exp = Math.pow(10, Math.floor(Math.log10(maxAbs)));
  for (const m of [1, 2, 5, 10]) {
    if (m * exp >= maxAbs) return m * exp;
  }
  return 10 * exp;
}
