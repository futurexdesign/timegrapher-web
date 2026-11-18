/**
 * PC-assisted sample-clock calibration maths, ported from the firmware
 * repo's `docs/hid/example.html` (same method as `scripts/calibrate_timebase.py`).
 *
 * Method: poll `getTime`, stamp each reply with the round-trip midpoint of this
 * computer's wall clock (`Date.now`, NTP-disciplined by the OS), keep the
 * lowest-RTT sample per time bucket, and fit `device_us = a + b * host_us`;
 * `ppm = (b - 1) * 1e6`. `performance.now()` measures the RTT and detects wall
 * clock steps; it is not used as the reference because on macOS / Windows it
 * runs from an undisciplined counter.
 */

/** Seconds per day gained or lost per ppm of clock error. */
export const S_PER_DAY_PER_PPM = 0.0864;
/** A wall-clock step larger than this (ms) between samples restarts the run. */
export const CAL_STEP_LIMIT_MS = 20;

/** One `getTime` probe. */
export interface CalSample {
  /** Host wall-clock time at the RTT midpoint (ms since epoch). */
  hostMs: number;
  /** Device µs timer from the reply. */
  devUs: number;
  /** Round-trip time (ms, `performance.now`). */
  rttMs: number;
  /** `Date.now() - performance.now()` at reply, for step detection. */
  wallMinusPerf: number;
}

/** Result of {@link calFit}. */
export interface CalFit {
  /** Clock error in ppm (+ = board clock fast). */
  ppm: number;
  /** Standard error of {@link ppm}. */
  stderrPpm: number;
  /** RMS residual of the fit (µs). */
  residUs: number;
  /** Points used. */
  points: number;
  /** Host time spanned by the points (s). */
  spanS: number;
}

/**
 * Keeps the lowest-RTT sample in each `bucketS`-second slice of host time.
 * @param samples Probes in arrival order.
 * @param bucketS Bucket width in seconds.
 * @returns Selected samples, ordered by bucket.
 */
export function calSelect(samples: readonly CalSample[], bucketS: number): CalSample[] {
  const first = samples[0];
  if (first === undefined) return [];
  const best = new Map<number, CalSample>();
  for (const s of samples) {
    const k = Math.floor((s.hostMs - first.hostMs) / (bucketS * 1000));
    const b = best.get(k);
    if (b === undefined || s.rttMs < b.rttMs) best.set(k, s);
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

/**
 * Least-squares slope of device µs against host µs (values centred first).
 * @param points Selected samples (see {@link calSelect}).
 * @returns The fit, or `null` with fewer than 3 points or no time spread.
 */
export function calFit(points: readonly CalSample[]): CalFit | null {
  const n = points.length;
  const p0 = points[0];
  if (n < 3 || p0 === undefined) return null;
  const xs = points.map((p) => (p.hostMs - p0.hostMs) * 1000);
  const ys = points.map((p) => p.devUs - p0.devUs);
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - xbar;
    sxx += dx * dx;
    sxy += dx * ((ys[i] ?? 0) - ybar);
  }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  const a = ybar - b * xbar;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = (ys[i] ?? 0) - (a + b * (xs[i] ?? 0));
    rss += r * r;
  }
  const sigma = Math.sqrt(rss / (n - 2));
  return {
    ppm: (b - 1) * 1e6,
    stderrPpm: (sigma / Math.sqrt(sxx)) * 1e6,
    residUs: Math.sqrt(rss / n),
    points: n,
    spanS: ((xs[n - 1] ?? 0) - (xs[0] ?? 0)) / 1e6,
  };
}

/**
 * Converts a ppm clock error into seconds per day.
 * @param ppm Clock error in ppm.
 */
export function ppmToSecPerDay(ppm: number): number {
  return ppm * S_PER_DAY_PER_PPM;
}

/** Chart-ready data for a calibration run (see {@link calOffsetSeries}). */
export interface CalOffsetSeries {
  /** `[seconds since first point, device-minus-host offset in µs]` per selected point. */
  points: [number, number][];
  /** Two end points of the fitted line in the same coordinates (empty without a fit). */
  line: [number, number][];
}

/**
 * Builds the offset-vs-time series that the calibration chart plots. The
 * offset is `(devUs - dev0) - (hostUs - host0)`, so its slope in µs/s equals
 * the fitted ppm and a perfect clock is a horizontal line.
 * @param points Selected samples (see {@link calSelect}).
 * @param fit Fit of the same points, or `null`.
 */
export function calOffsetSeries(points: readonly CalSample[], fit: CalFit | null): CalOffsetSeries {
  const p0 = points[0];
  if (p0 === undefined) return { points: [], line: [] };
  const pts: [number, number][] = points.map((p) => [
    (p.hostMs - p0.hostMs) / 1000,
    p.devUs - p0.devUs - (p.hostMs - p0.hostMs) * 1000,
  ]);
  if (fit === null || pts.length < 2) return { points: pts, line: [] };
  const n = pts.length;
  const tBar = pts.reduce((a, p) => a + p[0], 0) / n;
  const yBar = pts.reduce((a, p) => a + p[1], 0) / n;
  const tStart = pts[0]?.[0] ?? 0;
  const tEnd = pts[n - 1]?.[0] ?? 0;
  const yStart = yBar + fit.ppm * (tStart - tBar);
  return {
    points: pts,
    line: [
      [tStart, yStart],
      [tEnd, yStart + fit.ppm * (tEnd - tStart)],
    ],
  };
}

/** One point of a ppm history (UNIX seconds, ppm). */
export interface PpmPoint {
  dateUnix: number;
  ppm: number;
}

/** Crystal drift statistics over a calibration history. */
export interface DriftStats {
  /** Number of entries used. */
  count: number;
  /** Time from first to last entry (days). */
  spanDays: number;
  /** Smallest ppm. */
  minPpm: number;
  /** Largest ppm. */
  maxPpm: number;
  /** Linear-fit slope scaled to 30 days (ppm/month); `null` without a time spread. */
  driftPpmPerMonth: number | null;
}

/** Seconds in a 30-day month. */
const MONTH_S = 30 * 86400;

/**
 * Span, min/max and linear-fit drift of a ppm history.
 * @param entries History entries (any order).
 * @returns Stats, or `null` for an empty history.
 */
export function driftStats(entries: readonly PpmPoint[]): DriftStats | null {
  const n = entries.length;
  if (n === 0) return null;
  const ts = entries.map((e) => e.dateUnix);
  const ys = entries.map((e) => e.ppm);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const base: DriftStats = {
    count: n,
    spanDays: (tMax - tMin) / 86400,
    minPpm: Math.min(...ys),
    maxPpm: Math.max(...ys),
    driftPpmPerMonth: null,
  };
  if (n < 2 || tMax === tMin) return base;
  const tBar = ts.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (ts[i] ?? 0) - tBar;
    sxx += dx * dx;
    sxy += dx * ((ys[i] ?? 0) - yBar);
  }
  return { ...base, driftPpmPerMonth: sxx > 0 ? (sxy / sxx) * MONTH_S : null };
}

/**
 * Median of a list.
 * @param values Numbers (not modified).
 * @returns The median, or `NaN` for an empty list.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? NaN) : ((s[m - 1] ?? NaN) + (s[m] ?? NaN)) / 2;
}

/**
 * Reduces a series to at most `maxPoints` by averaging consecutive groups.
 * @param points `[x, y]` pairs in x order.
 * @param maxPoints Upper bound on the result length (>= 1).
 */
export function downsample(
  points: readonly [number, number][],
  maxPoints: number,
): [number, number][] {
  if (points.length <= maxPoints) return points.map((p) => [p[0], p[1]]);
  const group = Math.ceil(points.length / maxPoints);
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i += group) {
    const g = points.slice(i, i + group);
    out.push([
      g.reduce((a, p) => a + p[0], 0) / g.length,
      g.reduce((a, p) => a + p[1], 0) / g.length,
    ]);
  }
  return out;
}
