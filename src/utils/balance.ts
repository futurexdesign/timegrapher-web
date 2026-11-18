/**
 * Pure geometry / kinematics for the balance-wheel animation.
 *
 * The balance swings sinusoidally, one full oscillation per two beats, so its
 * frequency is vph / 7200 Hz (28 800 A/h = 4 Hz). Angle 0 is the rest
 * position, drawn pointing up; positive = clockwise.
 */

/** Slow-motion factors offered by the UI (animation runs at 1/N speed). */
export const SLOW_FACTORS = [10, 30, 100] as const;

/**
 * Oscillation frequency of the balance.
 * @param vph Beats (alternations) per hour.
 * @returns Hz; 0 for an invalid rate.
 */
export function oscillationHz(vph: number): number {
  return vph > 0 && Number.isFinite(vph) ? vph / 7200 : 0;
}

/**
 * Balance angle at wall-clock time t.
 * theta(t) = A * sin(2*pi * f * t / slow)
 * @param tSeconds Wall-clock seconds since the animation started.
 * @param amplitudeDeg Amplitude A (degrees).
 * @param vph Beats per hour.
 * @param slow Slow-motion divisor (e.g. 30 for 1/30 speed).
 * @returns Angle in degrees.
 */
export function balanceAngleDeg(
  tSeconds: number,
  amplitudeDeg: number,
  vph: number,
  slow: number,
): number {
  const f = oscillationHz(vph);
  if (f === 0 || !(slow > 0)) return 0;
  return amplitudeDeg * Math.sin((2 * Math.PI * f * tSeconds) / slow);
}

/**
 * Point on a circle; angle 0 = up, positive clockwise (SVG y axis down).
 * @param cx Centre x.
 * @param cy Centre y.
 * @param r Radius.
 * @param deg Angle in degrees.
 */
export function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
}

/**
 * SVG path of a circular arc (clockwise from a0 to a1).
 * @param cx Centre x.
 * @param cy Centre y.
 * @param r Radius.
 * @param a0 Start angle (deg).
 * @param a1 End angle (deg), a1 > a0.
 */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const s = polar(cx, cy, r, a0);
  const e = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${s.x.toFixed(2)} ${s.y.toFixed(2)}A${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

/** Options for {@link hairspringPath}. */
export interface HairspringOptions {
  /** Centre x. */
  cx: number;
  /** Centre y. */
  cy: number;
  /** Inner radius (collet). */
  rInner: number;
  /** Outer radius (stud end). */
  rOuter: number;
  /** Number of turns. */
  turns: number;
  /** Segments per turn. */
  segments?: number;
}

/**
 * Hairspring as an Archimedean spiral that breathes with the balance angle.
 * The inner end follows the staff (rotates by `thetaDeg`), the outer end is
 * fixed at the stud; in between the rotation fades linearly. The coil
 * radius contracts as the spring winds up (`thetaDeg > 0`) and expands as it
 * unwinds.
 * @param thetaDeg Current balance angle (deg).
 * @param maxDeg Amplitude used to normalise the breathing (>= 1).
 * @param o Geometry.
 * @returns SVG path data.
 */
export function hairspringPath(thetaDeg: number, maxDeg: number, o: HairspringOptions): string {
  const seg = o.segments ?? 28;
  const total = Math.max(2, Math.round(o.turns * seg));
  const norm = maxDeg >= 1 ? Math.max(-1, Math.min(1, thetaDeg / maxDeg)) : 0;
  const breath = 1 - 0.14 * norm;
  const parts: string[] = [];
  for (let i = 0; i <= total; i++) {
    const f = i / total;
    const baseDeg = f * o.turns * 360;
    const r = (o.rInner + (o.rOuter - o.rInner) * f) * breath;
    const p = polar(o.cx, o.cy, r, baseDeg + thetaDeg * (1 - f));
    parts.push(`${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return parts.join('');
}
