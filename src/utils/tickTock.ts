/**
 * Pure maths for the tick-tock (paper-strip) chart.
 *
 * Firmware convention (`dsp_beat_t`): `uUs` is the arrival time of a beat minus
 * its nominal-grid time, in microseconds, already corrected for the sample
 * clock (timebase ppm). It is NOT relative to a fitted line. A watch that
 * GAINS has beats arriving early, so u DECREASES with time:
 *
 *   du/dt [µs per s] = -rate_s_day / 86400 * 1e6
 *   rate_s_day       = -(du/dt) * 86400 / 1e6 = -slope_us_per_s * 0.0864
 *
 * The even-parity (tick) and odd-parity (tock) clouds are offset by the beat
 * error: beatError = |offset between the clouds|, which we obtain from a joint
 * least-squares fit `u = a + b*t + d*parity` (common slope, `d` = separation).
 *
 * Display convention: the chart plots the LEAD, `-u` (early = up), like a
 * conventional timegrapher strip. Its slope then has the sign of the rate and
 * reads directly against the rate trend: a gaining watch rises,
 *
 *   rate_s_day = +slope_of_plot [µs per s] * 0.0864
 *
 * The fit and the conversions below stay in terms of `u` (the firmware value);
 * only {@link plotValueUs} and {@link fitLinePoints} return display values.
 */

/** Seconds per day. */
export const SECONDS_PER_DAY = 86400;
/** s/d per (µs per s) of residual slope: 86400 / 1e6. */
export const RATE_PER_US_PER_S = 0.0864;

/** Compact copy of the fields of one beat the tick-tock chart needs. */
export interface TickPoint {
  /** Per-stream sequence number. */
  seq: number;
  /** Grid (fit restart) identifier. */
  gridId: number;
  /** Signal time of the unlock (s). */
  tS: number;
  /** 0 = tick, 1 = tock. */
  parity: 0 | 1;
  /** Residual against the nominal grid (µs). */
  uUs: number;
  /** Nominal half-period (µs). */
  nominalUs: number;
  /** False for beats the fit rejected. */
  accepted: boolean;
}

/** Result of {@link linearFit}. */
export interface LinearFit {
  /** y per x. */
  slope: number;
  /** y at x = 0. */
  intercept: number;
  /** Points used. */
  n: number;
}

/**
 * Folds a residual into [-nominal/2, +nominal/2) (paper-strip wrap).
 * @param u Residual (any unit).
 * @param nominal Nominal half-period (same unit); <= 0 returns `u` unchanged.
 */
export function foldResidual(u: number, nominal: number): number {
  if (!(nominal > 0)) return u;
  const m = (((u + nominal / 2) % nominal) + nominal) % nominal;
  return m - nominal / 2;
}

/**
 * Ordinary least-squares line through (x, y).
 * @param xs X values.
 * @param ys Y values (same length).
 * @returns The fit, or null with fewer than two points or no x spread.
 */
export function linearFit(xs: ArrayLike<number>, ys: ArrayLike<number>): LinearFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i] ?? 0;
    my += ys[i] ?? 0;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    sxx += dx * dx;
    sxy += dx * ((ys[i] ?? 0) - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

/**
 * Converts a residual slope to a daily rate.
 * @param slopeUsPerS d(uUs)/d(tS), µs per second of signal time.
 * @returns Rate in s/d, + = gaining (u decreasing).
 */
export function slopeToRateSDay(slopeUsPerS: number): number {
  return -slopeUsPerS * RATE_PER_US_PER_S;
}

/**
 * Inverse of {@link slopeToRateSDay}.
 * @param rateSDay Rate in s/d.
 * @returns Residual slope in µs per second.
 */
export function rateToSlopeUsPerS(rateSDay: number): number {
  return -rateSDay / RATE_PER_US_PER_S;
}

/** Result of {@link fitTickTock}. */
export interface TickTockFit {
  /** Common slope of both parities (µs per s). */
  slopeUsPerS: number;
  /** Intercept of parity 0 at t = 0 (µs). */
  interceptUs: number;
  /** Rate from the slope (s/d, + = gaining). */
  rateSDay: number;
  /** Beat error = parity separation (ms); null when one parity is missing. */
  beatErrorMs: number | null;
  /** Signed offset parity 1 minus parity 0 (µs); null when one parity is missing. */
  parityOffsetUs: number | null;
  /** Points used. */
  n: number;
}

/**
 * Joint least-squares fit `u = a + b*t + d*parity` over accepted points.
 * Falls back to a plain line when only one parity is present.
 * @param points Beats of ONE grid (rejected ones are ignored).
 * @returns The fit, or null with fewer than 3 usable points / no time spread.
 */
export function fitTickTock(points: readonly TickPoint[]): TickTockFit | null {
  const pts = points.filter((p) => p.accepted);
  const n = pts.length;
  if (n < 3) return null;
  const t0 = pts[0]?.tS ?? 0;
  let n1 = 0;
  for (const p of pts) n1 += p.parity;
  if (n1 === 0 || n1 === n) {
    const f = linearFit(
      pts.map((p) => p.tS - t0),
      pts.map((p) => p.uUs),
    );
    if (!f) return null;
    return {
      slopeUsPerS: f.slope,
      interceptUs: f.intercept - f.slope * t0,
      rateSDay: slopeToRateSDay(f.slope),
      beatErrorMs: null,
      parityOffsetUs: null,
      n,
    };
  }
  // Normal equations for [1, t, p]; t centred on t0 for conditioning.
  let st = 0;
  let stt = 0;
  let sp = 0;
  let stp = 0;
  let sy = 0;
  let sty = 0;
  let spy = 0;
  for (const p of pts) {
    const t = p.tS - t0;
    st += t;
    stt += t * t;
    sp += p.parity;
    stp += t * p.parity;
    sy += p.uUs;
    sty += t * p.uUs;
    spy += p.parity * p.uUs;
  }
  const A = [
    [n, st, sp],
    [st, stt, stp],
    [sp, stp, sp],
  ];
  const sol = solve3(A, [sy, sty, spy]);
  if (!sol) return null;
  const [a, b, d] = sol;
  return {
    slopeUsPerS: b,
    interceptUs: a - b * t0,
    rateSDay: slopeToRateSDay(b),
    beatErrorMs: Math.abs(d) / 1000,
    parityOffsetUs: d,
    n,
  };
}

/** Solves a 3x3 linear system by Cramer's rule; null when singular. */
function solve3(m: number[][], r: number[]): [number, number, number] | null {
  const g = (i: number, j: number): number => m[i]?.[j] ?? 0;
  const det3 = (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    gg: number,
    h: number,
    i: number,
  ): number => a * (e * i - f * h) - b * (d * i - f * gg) + c * (d * h - e * gg);
  const D = det3(g(0, 0), g(0, 1), g(0, 2), g(1, 0), g(1, 1), g(1, 2), g(2, 0), g(2, 1), g(2, 2));
  if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return null;
  const col = (k: number): number =>
    det3(
      k === 0 ? (r[0] ?? 0) : g(0, 0),
      k === 1 ? (r[0] ?? 0) : g(0, 1),
      k === 2 ? (r[0] ?? 0) : g(0, 2),
      k === 0 ? (r[1] ?? 0) : g(1, 0),
      k === 1 ? (r[1] ?? 0) : g(1, 1),
      k === 2 ? (r[1] ?? 0) : g(1, 2),
      k === 0 ? (r[2] ?? 0) : g(2, 0),
      k === 1 ? (r[2] ?? 0) : g(2, 1),
      k === 2 ? (r[2] ?? 0) : g(2, 2),
    ) / D;
  return [col(0), col(1), col(2)];
}

/**
 * Index of the first point with `tS >= tMin` in a time-ordered array.
 * @param points Points ordered by `tS`.
 * @param tMin Lower time bound (s).
 */
export function windowStart(points: readonly TickPoint[], tMin: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((points[mid]?.tS ?? 0) < tMin) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Value to plot for a point: the lead `-u` (early = positive), so the raw
 * trace slopes with the sign of the rate.
 * @param p The point.
 * @param fit Fit to subtract (flatten mode), or null for raw.
 * @param fold Wrap into ± nominal/2.
 * @returns Lead in microseconds (+ = early).
 */
export function plotValueUs(p: TickPoint, fit: TickTockFit | null, fold: boolean): number {
  let y = p.uUs;
  if (fit) y -= fit.interceptUs + fit.slopeUsPerS * p.tS;
  const lead = -y;
  return fold ? foldResidual(lead, p.nominalUs) : lead;
}

/**
 * End points of the fitted rate line for one parity, in display units (lead,
 * µs), over `[tFrom, tTo]` of signal time. Drawn over the raw trace so the
 * slope that encodes the rate is explicit.
 * @param fit Joint fit of the visible points.
 * @param parity 0 = tick line, 1 = tock line (offset by the beat error).
 * @param tFrom Start time (s).
 * @param tTo End time (s).
 * @param nominalUs Nominal half-period, for the fold check.
 * @param fold Whether the trace is folded; a line that would wrap is omitted.
 * @returns Two `[tS, leadUs]` points, or null when the line would wrap.
 */
export function fitLinePoints(
  fit: TickTockFit,
  parity: 0 | 1,
  tFrom: number,
  tTo: number,
  nominalUs: number,
  fold: boolean,
): [[number, number], [number, number]] | null {
  const offset = parity === 1 ? (fit.parityOffsetUs ?? 0) : 0;
  const at = (t: number): number => -(fit.interceptUs + offset + fit.slopeUsPerS * t);
  const a = at(tFrom);
  const b = at(tTo);
  if (fold && (Math.abs(a) > nominalUs / 2 || Math.abs(b) > nominalUs / 2)) return null;
  return [
    [tFrom, a],
    [tTo, b],
  ];
}

/**
 * Fixed x-axis span for the selected time window, in seconds since the first
 * beat of the grid. The axis always covers exactly `windowS` (no scaling to the
 * data): while less than a window of beats exists it runs `0..windowS` and the
 * trace fills it from the left. After that it advances in whole steps of
 * `windowS / 6`, like a chart recorder paging, so the tick marks stay on round
 * values and the newest beat is always within one step of the right edge.
 * An infinite window ("All") spans the recorded data.
 * @param elapsedS Seconds from the grid's first beat to its newest beat (>= 0).
 * @param windowS Selected window (s), or Infinity for all.
 * @returns Axis bounds in elapsed seconds, and the tick step (null for "All").
 */
export function xWindow(
  elapsedS: number,
  windowS: number,
): { min: number; max: number; step: number | null } {
  const last = Math.max(0, elapsedS);
  if (!Number.isFinite(windowS)) return { min: 0, max: Math.max(last, 1), step: null };
  const step = windowS / 6;
  const min = last <= windowS ? 0 : Math.ceil((last - windowS) / step) * step;
  return { min, max: min + windowS, step };
}
