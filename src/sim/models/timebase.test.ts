/** Unit tests for the timebase model and the log policy. */
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng';
import { TimebaseModel } from './timebase';
import { TimebaseLogModel, ppsDecision } from './timebaseLog';

const FULL = { locked: true, window: 64, lockedSinceS: 700, ppm: 1, utcNow: 2_000_000_000 };

describe('ppsDecision', () => {
  it('needs lock, a full window, 600 s and a UTC date', () => {
    expect(ppsDecision([], { ...FULL, locked: false }, 0.2)).toBe('none');
    expect(ppsDecision([], { ...FULL, window: 63 }, 0.2)).toBe('none');
    expect(ppsDecision([], { ...FULL, lockedSinceS: 599 }, 0.2)).toBe('none');
    expect(ppsDecision([], { ...FULL, utcNow: 0 }, 0.2)).toBe('none');
    expect(ppsDecision([], FULL, 0.2)).toBe('delta');
  });

  it('applies delta (>= 1 day) and monthly rules against the last entry', () => {
    const last = {
      dateUnix: FULL.utcNow - 3600,
      ppm: 1,
      source: 'manual' as const,
      durationS: 0,
      reason: 'save' as const,
    };
    expect(ppsDecision([last], { ...FULL, ppm: 5 }, 0.2)).toBe('none');
    const old = { ...last, dateUnix: FULL.utcNow - 2 * 86400 };
    expect(ppsDecision([old], { ...FULL, ppm: 1.1 }, 0.2)).toBe('none');
    expect(ppsDecision([old], { ...FULL, ppm: 1.3 }, 0.2)).toBe('delta');
    const month = { ...last, dateUnix: FULL.utcNow - 31 * 86400 };
    expect(ppsDecision([month], FULL, 0.2)).toBe('monthly');
  });

  it('ignores a small backwards clock step', () => {
    const future = {
      dateUnix: FULL.utcNow + 100,
      ppm: 0,
      source: 'pps' as const,
      durationS: 0,
      reason: 'delta' as const,
    };
    expect(ppsDecision([future], FULL, 0.2)).toBe('none');
  });
});

describe('TimebaseLogModel', () => {
  const e = (ppm: number) => ({
    dateUnix: ppm,
    ppm,
    source: 'ntp' as const,
    durationS: 0,
    reason: 'save' as const,
  });

  it('keeps 24 entries, oldest dropped', () => {
    const l = new TimebaseLogModel();
    for (let i = 0; i < 30; i++) l.append(e(i));
    expect(l.list()).toHaveLength(24);
    expect(l.list()[0]?.ppm).toBe(6);
  });

  it('defers writes while blocked and retries 60 s after a failure', () => {
    const l = new TimebaseLogModel();
    l.append(e(1));
    l.markPending();
    l.flush(0, true, true, 100);
    expect(l.pending).toBe(true);
    l.flush(1, false, false, 100);
    expect(l.pending).toBe(true);
    l.flush(30_000, false, true, 100);
    expect(l.pending).toBe(true);
    l.flush(62_000, false, true, 100);
    expect(l.pending).toBe(false);
    expect(l.result().lastWriteUnix).toBe(100);
  });
});

describe('TimebaseModel', () => {
  const quiet = { crystalPpm: 12, driftPpm: 0, walkPpmPerSqrtS: 0 };

  it('counts at 1 + ppm of real time', () => {
    const t = new TimebaseModel(createRng(1), {
      ...quiet,
      driftPeriodS: 100,
      ppsNoisePpm: 0.3,
      ppsLockPulses: 16,
    });
    const a = t.counter;
    t.advanceCounter(1000);
    expect(t.counter - a).toBeCloseTo(1_000_000 * (1 + 12e-6), 3);
  });

  it('PPS locks after enough fixed pulses and loses lock without a fix', () => {
    const t = new TimebaseModel(createRng(2), {
      ...quiet,
      driftPeriodS: 100,
      ppsNoisePpm: 0.3,
      ppsLockPulses: 16,
    });
    t.advancePps(10, true, true);
    expect(t.pps().locked).toBe(false);
    t.advancePps(70, true, true);
    const p = t.pps();
    expect(p.locked).toBe(true);
    expect(p.window).toBe(64);
    expect(p.ppm).toBeCloseTo(12, 0);
    expect(t.effective(true).source).toBe('pps');
    expect(t.effective(false).source).toBe('none');
    t.advancePps(5, true, false);
    expect(t.pps().locked).toBe(false);
    expect(t.pps().noFix).toBe(5);
  });

  it('stores calibration with the firmware rules', () => {
    const t = new TimebaseModel(createRng(1));
    expect(t.set(2000, 'manual', 0, 0, 0)).toBe(false);
    expect(t.set(0, 'manual', 0, 0, 0)).toBe(true);
    expect(t.cal.source).toBe('none');
    expect(t.set(5, 'ntp', 0, 60, 1234)).toBe(true);
    expect(t.cal).toEqual({ ppm: 5, source: 'ntp', dateUnix: 1234, durationS: 60 });
    expect(t.saved).toBe(false);
    t.commit();
    expect(t.saved).toBe(true);
  });
});
