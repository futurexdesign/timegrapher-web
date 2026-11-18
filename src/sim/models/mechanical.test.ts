/** Unit tests for the mechanical watch model (seeded PRNG, no clock). */
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng';
import {
  DEFAULT_MECHANICAL,
  MechanicalModel,
  amplitudeFromLift,
  liftTimeFromAmplitude,
  type MechanicalConfig,
  type MechanicalParams,
} from './mechanical';
import type { DspBeat } from '@/protocol/types';

const CFG: MechanicalConfig = {
  attached: true,
  sourceHz: 48000,
  timebaseOk: true,
  xtalPpm: 0,
  calPpm: 0,
  calSource: 'none',
  liftAngleDeg: 51,
  vph: 0,
  windowS: 6,
  avgS: 10,
  eventDetectEnabled: true,
  prerollMs: 25,
  tailMs: 25,
  threshold: 6,
  beatRateEnabled: true,
  noiseFloor: 1e-4,
};

const QUIET: Partial<MechanicalParams> = { rateWanderSDay: 0, jitterUs: 10 };

function run(
  seed: number,
  seconds: number,
  p: Partial<MechanicalParams>,
  cfg: MechanicalConfig = CFG,
) {
  const m = new MechanicalModel(createRng(seed), { ...DEFAULT_MECHANICAL, ...QUIET, ...p });
  const beats: DspBeat[] = [];
  let events = 0;
  for (let t = 0; t < seconds; t += 0.25) {
    const o = m.advance(0.25, cfg);
    beats.push(...o.beats);
    events += o.events.length;
  }
  return { m, beats, events };
}

describe('MechanicalModel', () => {
  it('is deterministic for a seed', () => {
    const a = run(7, 10, {});
    const b = run(7, 10, {});
    expect(a.beats).toEqual(b.beats);
    const c = run(8, 10, {});
    expect(c.beats).not.toEqual(a.beats);
  });

  it('emits no beats until the acquisition time has passed, then locks', () => {
    const early = run(1, 2, {});
    expect(early.beats).toHaveLength(0);
    expect(early.events).toBeGreaterThan(5);
    const { m, beats } = run(1, 12, {});
    expect(beats[0]?.status).toBe('started');
    expect(beats[0]?.k).toBe(0);
    expect(beats[0]?.uUs).toBe(0);
    const snap = m.snapshot(CFG);
    expect(snap.locked).toBe(true);
    expect(snap.vphNearest).toBe(28800);
    expect(snap.ratePoints).toBeGreaterThanOrEqual(8);
  });

  it('a gaining watch has u decreasing with slope -rate/86400*nominal per beat', () => {
    const { beats } = run(3, 40, { rateSDay: 20, beatErrorMs: 0 });
    const pts = beats.filter((b) => b.status === 'accepted');
    const n = pts.length;
    const kbar = pts.reduce((s, b) => s + b.k, 0) / n;
    const ubar = pts.reduce((s, b) => s + b.uUs, 0) / n;
    let sku = 0;
    let skk = 0;
    for (const b of pts) {
      sku += (b.k - kbar) * (b.uUs - ubar);
      skk += (b.k - kbar) ** 2;
    }
    expect((sku / skk / 125000) * -86400).toBeCloseTo(20, 0);
    expect(sku / skk).toBeLessThan(0);
  });

  it('separates the parity clouds by the beat error', () => {
    const { beats } = run(4, 30, { beatErrorMs: 2 });
    const even = beats.filter((b) => b.parity === 0).map((b) => b.uUs);
    const odd = beats.filter((b) => b.parity === 1).map((b) => b.uUs);
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    expect(Math.abs(mean(even) - mean(odd))).toBeGreaterThan(1900);
    expect(Math.abs(mean(even) - mean(odd))).toBeLessThan(2100);
  });

  it('reports the true rate when calibrated and a crystal-induced offset when not', () => {
    const base = { rateSDay: 5, beatErrorMs: 0.2 };
    const cal = run(5, 30, base, { ...CFG, xtalPpm: 10, calPpm: 10 }).m.snapshot({
      ...CFG,
      xtalPpm: 10,
      calPpm: 10,
    });
    expect(cal.rateSDay).toBeCloseTo(5, 0);
    const uncal = run(5, 30, base, { ...CFG, xtalPpm: 10 }).m.snapshot({ ...CFG, xtalPpm: 10 });
    expect(uncal.rateSDay).toBeCloseTo(5 - 0.864, 0);
  });

  it('does not lock without a verified timebase', () => {
    const cfg = { ...CFG, timebaseOk: false };
    const { m, beats } = run(6, 15, {}, cfg);
    expect(beats).toHaveLength(0);
    expect(m.snapshot(cfg).locked).toBe(false);
  });

  it('honours a manual vph and a mismatching one never locks', () => {
    const { m } = run(9, 12, {}, { ...CFG, vph: 21600 });
    expect(m.snapshot({ ...CFG, vph: 21600 }).locked).toBe(false);
  });

  it('missed beats leave gaps in k', () => {
    const { beats } = run(10, 30, { missedBeatProb: 0.2 });
    const gaps = beats.filter(
      (b, i) => i > 0 && b.status === 'accepted' && b.k - (beats[i - 1]?.k ?? 0) > 1,
    );
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('converts between lift time and amplitude consistently', () => {
    const lift = liftTimeFromAmplitude(285, 28800, 51);
    expect(amplitudeFromLift(lift, 28800, 51)).toBeCloseTo(285, 3);
    expect(amplitudeFromLift(0, 28800, 51)).toBe(0);
  });

  it('reset restarts seq at 0 and drops the lock', () => {
    const { m } = run(11, 12, {});
    m.reset();
    expect(m.snapshot(CFG).locked).toBe(false);
    const o = m.advance(0.25, CFG);
    expect(o.beats).toHaveLength(0);
  });
});
