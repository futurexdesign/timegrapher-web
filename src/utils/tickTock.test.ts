/** Tests for the tick-tock maths, including the rate sign convention. */
import { describe, expect, it } from 'vitest';
import {
  fitTickTock,
  foldResidual,
  linearFit,
  plotValueUs,
  rateToSlopeUsPerS,
  slopeToRateSDay,
  windowStart,
  type TickPoint,
} from './tickTock';

/** Synthetic beats of a watch with `rate` s/d and a tick/tock offset. */
function synth(rate: number, offsetUs: number, n = 200, nominalUs = 125000): TickPoint[] {
  const out: TickPoint[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k * nominalUs) / 1e6;
    out.push({
      seq: k,
      gridId: 1,
      tS: t,
      parity: (k & 1) as 0 | 1,
      uUs: rateToSlopeUsPerS(rate) * t + (k & 1 ? offsetUs : 0),
      nominalUs,
      accepted: true,
    });
  }
  return out;
}

describe('foldResidual', () => {
  it('wraps into +-nominal/2', () => {
    expect(foldResidual(10, 100)).toBe(10);
    expect(foldResidual(60, 100)).toBe(-40);
    expect(foldResidual(-60, 100)).toBe(40);
    expect(foldResidual(250, 100)).toBe(-50);
    expect(foldResidual(5, 0)).toBe(5);
  });
});

describe('linearFit', () => {
  it('fits a line', () => {
    const f = linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(f?.slope).toBeCloseTo(2);
    expect(f?.intercept).toBeCloseTo(1);
  });
  it('rejects degenerate input', () => {
    expect(linearFit([1], [1])).toBeNull();
    expect(linearFit([2, 2, 2], [1, 2, 3])).toBeNull();
  });
});

describe('slope <-> rate sign convention', () => {
  it('a gaining watch has u decreasing and a positive rate', () => {
    const pts = synth(30, 0);
    expect(pts[10]?.uUs).toBeLessThan(pts[0]?.uUs ?? 0);
    const fit = fitTickTock(pts);
    expect(fit?.slopeUsPerS).toBeLessThan(0);
    expect(fit?.rateSDay).toBeCloseTo(30, 6);
  });
  it('a losing watch has u increasing and a negative rate', () => {
    expect(fitTickTock(synth(-12.5, 0))?.rateSDay).toBeCloseTo(-12.5, 6);
  });
  it('1 s/d is 11.574 us per second of slope, rate = -slope * 0.0864', () => {
    expect(slopeToRateSDay(-1e6 / 86400)).toBeCloseTo(1, 9);
    expect(slopeToRateSDay(-11.574074)).toBeCloseTo(1, 5);
  });
});

describe('fitTickTock', () => {
  it('recovers beat error as the parity separation despite the slope', () => {
    const fit = fitTickTock(synth(20, 400));
    expect(fit?.beatErrorMs).toBeCloseTo(0.4, 6);
    expect(fit?.parityOffsetUs).toBeCloseTo(400, 4);
    expect(fit?.rateSDay).toBeCloseTo(20, 6);
  });
  it('ignores rejected beats', () => {
    const pts = synth(10, 0);
    pts.push({ ...pts[5]!, uUs: 50000, accepted: false, tS: 999 });
    expect(fitTickTock(pts)?.rateSDay).toBeCloseTo(10, 6);
  });
  it('returns null with too few points', () => {
    expect(fitTickTock(synth(10, 0, 2))).toBeNull();
  });
  it('works with a single parity (no beat error)', () => {
    const pts = synth(10, 0).filter((p) => p.parity === 0);
    const fit = fitTickTock(pts);
    expect(fit?.beatErrorMs).toBeNull();
    expect(fit?.rateSDay).toBeCloseTo(10, 6);
  });
});

describe('plotValueUs / windowStart', () => {
  it('flatten removes the slope, fold wraps', () => {
    const pts = synth(30, 0);
    const fit = fitTickTock(pts);
    for (const p of pts) expect(plotValueUs(p, fit, false)).toBeCloseTo(0, 4);
    const big: TickPoint = { ...pts[0]!, uUs: 70000 };
    expect(plotValueUs(big, null, true)).toBeCloseTo(-55000);
  });
  it('binary-searches the window start', () => {
    const pts = synth(0, 0, 100);
    expect(windowStart(pts, 0)).toBe(0);
    expect(windowStart(pts, 1)).toBe(8);
    expect(windowStart(pts, 1e6)).toBe(100);
  });
});
