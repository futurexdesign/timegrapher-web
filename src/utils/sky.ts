/**
 * Pure mapping from GNSS satellite records to sky-plot data (polar scatter
 * with azimuth as angle and `90 - elevation` as radius) plus the colour and
 * size conventions of the SkyView component.
 */
import type { GpsSat as GpsSatTuple, GpsSystem } from '@/protocol/timegrapher_hid';

/** A satellite with named fields (adapter over the wire tuple {@link GpsSatTuple}). */
export interface SatView {
  /** Constellation code. */
  sys: GpsSystem;
  /** Normalised PRN. */
  prn: number;
  /** Elevation (deg), -1 unknown. */
  el: number;
  /** Azimuth (deg), -1 unknown. */
  az: number;
  /** SNR (dB-Hz), -1 = not tracked. */
  snr: number;
  /** Used in the fix. */
  used: boolean;
}

/** Alias so the rest of this module reads naturally. */
type GpsSat = SatView;

/**
 * Converts a wire tuple `[sys, prn, el, az, snr, used]` to named fields.
 * @param t Tuple from `getGps`.
 */
export function toSat(t: GpsSatTuple): SatView {
  return { sys: t[0], prn: t[1], el: t[2], az: t[3], snr: t[4], used: t[5] === 1 };
}

/** Constellation display info. */
export interface SystemInfo {
  /** Full name. */
  name: string;
  /** Series colour (readable on light and dark backgrounds). */
  color: string;
}

/** Constellations plotted in the legend (GN/?? are folded into "Other"). */
export const SYSTEMS: Record<GpsSystem, SystemInfo> = {
  GP: { name: 'GPS', color: '#2e7d32' },
  GL: { name: 'GLONASS', color: '#c62828' },
  GA: { name: 'Galileo', color: '#1565c0' },
  BD: { name: 'BeiDou', color: '#ef6c00' },
  QZ: { name: 'QZSS', color: '#7b1fa2' },
  '??': { name: 'Unknown', color: '#9e9e9e' },
};

/** Order of the legend entries. */
export const SYSTEM_ORDER: readonly GpsSystem[] = ['GP', 'GL', 'GA', 'BD', 'QZ', '??'];

/** Smallest and largest marker diameters (px). */
const SIZE_MIN = 8;
const SIZE_MAX = 26;
/** SNR (dB-Hz) mapped to the largest marker. */
const SNR_FULL = 50;

/**
 * Short satellite label, e.g. `GP12`.
 * @param s Satellite.
 */
export function satLabel(s: GpsSat): string {
  return `${s.sys === '??' ? '' : s.sys}${s.prn}`;
}

/**
 * Whether the satellite has a known sky position.
 * @param s Satellite.
 */
export function hasPosition(s: GpsSat): boolean {
  return s.el >= 0 && s.az >= 0;
}

/**
 * Polar coordinates for a satellite: `[radius, angle]` with radius `90 - el`
 * (zenith 0, horizon 90) and angle = azimuth (0 = north, clockwise).
 * @param s Satellite.
 * @returns The pair, or `null` when elevation or azimuth is unknown.
 */
export function skyPosition(s: GpsSat): [number, number] | null {
  if (!hasPosition(s)) return null;
  return [90 - Math.min(90, s.el), s.az % 360];
}

/**
 * Marker diameter from SNR (unknown / not tracked gives the minimum).
 * @param snr SNR in dB-Hz, -1 = not tracked.
 */
export function snrSymbolSize(snr: number): number {
  const f = Math.min(1, Math.max(0, snr) / SNR_FULL);
  return SIZE_MIN + f * (SIZE_MAX - SIZE_MIN);
}

/**
 * Splits satellites into those that can be plotted and those with unknown el/az.
 * @param sats All satellites.
 */
export function splitSats(sats: readonly GpsSat[]): { placed: GpsSat[]; unplaced: GpsSat[] } {
  const placed: GpsSat[] = [];
  const unplaced: GpsSat[] = [];
  for (const s of sats) (hasPosition(s) ? placed : unplaced).push(s);
  return { placed, unplaced };
}

/**
 * Sorts by SNR descending; untracked (-1) last; ties by system then PRN.
 * @param sats Satellites (not modified).
 */
export function sortBySnr(sats: readonly GpsSat[]): GpsSat[] {
  return [...sats].sort(
    (a, b) =>
      b.snr - a.snr || SYSTEM_ORDER.indexOf(a.sys) - SYSTEM_ORDER.indexOf(b.sys) || a.prn - b.prn,
  );
}

/**
 * Groups satellites by constellation in legend order (empty groups omitted).
 * @param sats Satellites.
 */
export function groupBySystem(sats: readonly GpsSat[]): { sys: GpsSystem; sats: GpsSat[] }[] {
  return SYSTEM_ORDER.map((sys) => ({ sys, sats: sats.filter((s) => s.sys === sys) })).filter(
    (g) => g.sats.length > 0,
  );
}

/**
 * Compass direction of an azimuth.
 * @param az Azimuth in degrees.
 */
export function compass(az: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round((((az % 360) + 360) % 360) / 45) % 8] ?? 'N';
}
