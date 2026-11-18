/** Unit tests for the quartz engine (motor / LCD / fork), deterministic via seeded PRNG. */
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng';
import { QuartzEngine } from './quartz';
import type { QuartzContext } from './quartzTypes';

const CTX: QuartzContext = {
  attached: 'motor',
  sourceHz: 48000,
  timebaseOk: true,
  xtalPpm: 0,
  calPpm: 0,
  calSource: 'none',
};

function engine(): QuartzEngine {
  return new QuartzEngine(createRng(3));
}

function run(e: QuartzEngine, seconds: number, ctx: QuartzContext = CTX): void {
  for (let t = 0; t < seconds; t += 0.25) e.advance(0.25, ctx);
}

describe('QuartzEngine settings', () => {
  it('validates parameters like the firmware', () => {
    const e = engine();
    expect(e.setParam('gate', 2)).toBe('outOfRange');
    expect(e.setParam('gate', 961)).toBe('outOfRange');
    expect(e.setParam('gate', 0)).toBe('ok');
    expect(e.setParam('gate', 60)).toBe('ok');
    expect(e.setParam('forkHz', 341.33)).toBe('ok');
    expect(e.settings().forkHz).toBeCloseTo(1024 / 3, 6);
    expect(e.setParam('forkHz', 400)).toBe('outOfRange');
    expect(e.setParam('kSigma', 3)).toBe('outOfRange');
    expect(e.setParam('tsMethod', 2)).toBe('outOfRange');
    expect(e.setParam('nope', 1)).toBe('unknownName');
  });

  it('restarts only on a real change that the active mode uses', () => {
    const e = engine();
    e.setMode('motor');
    const id = e.currentMeasurementId;
    e.setMode('motor');
    e.setParam('gate', 0);
    e.setParam('forkHz', 480);
    expect(e.currentMeasurementId).toBe(id);
    e.setParam('gate', 60);
    expect(e.currentMeasurementId).toBe(id + 1);
  });
});

describe('motor measurement', () => {
  it('progresses through the inhibition statuses and freezes with two events', () => {
    const e = engine();
    e.setMode('motor');
    const seen: string[] = [];
    for (let t = 0; t < 140; t += 0.25) {
      e.advance(0.25, CTX);
      const m = e.snapshot(CTX).motor;
      if (m && seen[seen.length - 1] !== m.inhibition) seen.push(m.inhibition);
    }
    expect(seen).toEqual([
      'none',
      'may_include_inhibition',
      'need_one_more_cycle',
      'correction_pending',
      'corrected',
    ]);
    const q = e.snapshot(CTX);
    expect(q.state).toBe('done');
    expect(q.reason).toBe('two inhibition events seen');
    const m = q.motor;
    expect(m?.events).toBe(2);
    expect(m?.cyclesUsed).toBe(1);
    expect(m?.jumpLastUs).toBeGreaterThan(480);
    expect(m?.jumpLastN).toBe(4);
    expect(m?.rateWithoutSDay).toBeCloseTo(0.9, 1);
    expect(m?.rateWithSDay).toBeCloseTo(0.9 - (488.28e-6 / 60) * 86400, 1);
    expect(q.rateSDay).toBe(m?.rateWithSDay);
  });

  it('a timed gate freezes at the gate and keeps the frozen calibration', () => {
    const e = engine();
    e.setMode('motor');
    e.setParam('gate', 30);
    run(e, 40);
    const a = e.snapshot({ ...CTX, calPpm: 0 });
    expect(a.state).toBe('done');
    expect(a.elapsedS).toBe(30);
    expect(a.reason).toBe('gate reached');
    const b = e.snapshot({ ...CTX, calPpm: 50, calSource: 'ntp' });
    expect(b.calPpm).toBe(0);
    expect(b.motor?.inhibition).toBe('need_one_more_cycle');
    expect(e.restart()).toBe(true);
    expect(e.snapshot(CTX).state).not.toBe('done');
  });

  it('applies the calibration to the headline rate', () => {
    const e = engine();
    e.setMode('motor');
    run(e, 20);
    const raw = e.snapshot(CTX).motor?.rateWithoutUncalSDay ?? 0;
    const cal = e.snapshot({ ...CTX, calPpm: 10 }).motor;
    expect(cal?.rateWithoutUncalSDay).toBeCloseTo(raw, 9);
    expect(cal?.rateWithoutSDay).toBeCloseTo(raw + 0.864, 2);
  });

  it('gates on timebase and capture rate', () => {
    const e = engine();
    e.setMode('motor');
    expect(e.snapshot({ ...CTX, timebaseOk: false }).state).toBe('waitTimebase');
    expect(e.snapshot({ ...CTX, sourceHz: 44100 }).state).toBe('unsupportedRate');
    expect(e.snapshot(CTX).reason).toBe('waiting for audio stream');
    run(e, 1);
    expect(e.snapshot(CTX).reason).toBe('waiting for 3 pulses');
  });

  it('records alternating polarity pulses and reports weak signals', () => {
    const e = new QuartzEngine(createRng(3), { ...engine().source, motorSnr: 12 });
    e.setMode('motor');
    run(e, 10);
    const pulses = e.recentPulses(CTX, 8);
    expect(pulses.length).toBe(8);
    expect(pulses[0]?.polarity).not.toBe(pulses[1]?.polarity);
    expect(e.snapshot(CTX).motor?.hintWeakSignal).toBe(true);
  });

  it('sees no pulses when no motor watch is attached', () => {
    const e = engine();
    e.setMode('motor');
    run(e, 10, { ...CTX, attached: 'mechanical' });
    expect(e.snapshot({ ...CTX, attached: 'mechanical' }).motor?.valid).toBe(false);
  });
});

describe('LCD and fork', () => {
  it('LCD detects the pattern, then tracks and converges', () => {
    const e = engine();
    e.setMode('lcd');
    const ctx = { ...CTX, attached: 'lcd' as const };
    run(e, 1, ctx);
    expect(e.snapshot(ctx).lcd?.status).toBe('detecting_period');
    run(e, 30, ctx);
    const q = e.snapshot(ctx);
    expect(q.lcd?.status).toBe('tracking');
    expect(q.lcd?.f0Hz).toBe(64);
    expect(q.state).toBe('measuring');
    expect(q.rateSDay).toBeCloseTo(0.35, 1);
  });

  it('LCD without a pattern reports no_pattern and retries', () => {
    const e = engine();
    e.source.lcdNoPattern = true;
    e.setMode('lcd');
    const ctx = { ...CTX, attached: 'lcd' as const };
    run(e, 7, ctx);
    const l = e.snapshot(ctx).lcd;
    expect(l?.status).toBe('no_pattern');
    expect(l?.retries).toBeGreaterThan(0);
  });

  it('fork measures its rate and reports the nominal frequency', () => {
    const e = engine();
    e.setParam('forkHz', 480);
    e.setMode('fork');
    const ctx = { ...CTX, attached: 'fork' as const };
    run(e, 40, ctx);
    const q = e.snapshot(ctx);
    expect(q.fork?.fNomHz).toBe(480);
    expect(q.rateSDay).toBeCloseTo(-1.2, 1);
  });
});
