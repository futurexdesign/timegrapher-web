import { describe, expect, it } from 'vitest';
import { calFit, calSelect, ppmToSecPerDay, type CalSample } from './calibration';

function synth(ppm: number, n: number, stepMs: number): CalSample[] {
  return Array.from({ length: n }, (_, i) => {
    const hostMs = 1_700_000_000_000 + i * stepMs;
    return {
      hostMs,
      devUs: 5e6 + (hostMs - 1_700_000_000_000) * 1000 * (1 + ppm * 1e-6),
      rttMs: 1,
      wallMinusPerf: 0,
    };
  });
}

describe('calibration', () => {
  it('recovers a known ppm', () => {
    const fit = calFit(synth(23.5, 50, 2000));
    expect(fit?.ppm).toBeCloseTo(23.5, 3);
    expect(fit?.points).toBe(50);
    expect(fit?.spanS).toBeCloseTo(98, 3);
  });

  it('needs three points', () => {
    expect(calFit(synth(1, 2, 1000))).toBeNull();
    expect(calFit([])).toBeNull();
  });

  it('keeps the lowest-RTT sample per bucket', () => {
    const s = synth(0, 6, 1000).map((x, i) => ({ ...x, rttMs: 10 - i }));
    const kept = calSelect(s, 3);
    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.rttMs)).toEqual([8, 5]);
    expect(calSelect([], 3)).toEqual([]);
  });

  it('converts ppm to s/d', () => {
    expect(ppmToSecPerDay(10)).toBeCloseTo(0.864, 6);
  });
});

describe('calibration extras', () => {
  it('offset series slope equals the ppm', async () => {
    const { calOffsetSeries } = await import('./calibration');
    const pts = synth(10, 20, 2000);
    const fit = calFit(pts);
    const s = calOffsetSeries(pts, fit);
    expect(s.points).toHaveLength(20);
    const [a, b] = s.line as [[number, number], [number, number]];
    expect((b[1] - a[1]) / (b[0] - a[0])).toBeCloseTo(10, 3);
    expect(s.points[0]?.[1]).toBeCloseTo(0, 6);
  });

  it('driftStats: span, min/max and monthly slope', async () => {
    const { driftStats } = await import('./calibration');
    const day = 86400;
    const e = [0, 30, 60].map((d, i) => ({ dateUnix: 1_700_000_000 + d * day, ppm: 1 + i * 0.5 }));
    const st = driftStats(e);
    expect(st?.spanDays).toBeCloseTo(60);
    expect(st?.minPpm).toBe(1);
    expect(st?.maxPpm).toBe(2);
    expect(st?.driftPpmPerMonth).toBeCloseTo(0.5, 6);
    expect(driftStats([])).toBeNull();
    expect(driftStats([e[0]!])?.driftPpmPerMonth).toBeNull();
  });

  it('median and downsample', async () => {
    const { median, downsample } = await import('./calibration');
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    const d = downsample(
      Array.from({ length: 1000 }, (_, i) => [i, 2 * i] as [number, number]),
      100,
    );
    expect(d.length).toBeLessThanOrEqual(100);
    expect(d[0]?.[1]).toBeCloseTo(9);
  });
});
