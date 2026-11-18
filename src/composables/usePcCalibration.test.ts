/** State-machine tests for the PC calibration with a fake transport and clock. */
import { describe, expect, it, vi } from 'vitest';
import { createPcCalibration, type CalApplyBody, type PcCalDeps } from './usePcCalibration';

/** Fake clocks + device: device timer runs at `1 + ppm*1e-6` of host time. */
function rig(ppm: number, opts: { stepAtCall?: number; stepMs?: number; failEvery?: number } = {}) {
  let perf = 1000;
  let wallOffset = 1_700_000_000_000;
  let calls = 0;
  const hiddenCbs: (() => void)[] = [];
  const applyCalls: { body: CalApplyBody; save: boolean }[] = [];
  const wake = { acquire: vi.fn(() => Promise.resolve()), release: vi.fn(() => Promise.resolve()) };
  const deps: PcCalDeps = {
    perfNow: () => perf,
    dateNow: () => perf + wallOffset,
    getTime() {
      calls++;
      if (opts.failEvery && calls % opts.failEvery === 0) {
        perf += 1;
        return Promise.reject(new Error('timeout'));
      }
      perf += 0.5; // outbound half
      const tUs = (perf - 1000) * 1000 * (1 + ppm * 1e-6) + 5e6;
      perf += 0.5;
      return Promise.resolve({ tUs });
    },
    sleep(ms) {
      perf += ms;
      // The wall clock steps between probes (as NTP would).
      if (opts.stepAtCall === calls) wallOffset += opts.stepMs ?? 500;
      return Promise.resolve();
    },
    apply(body, save) {
      applyCalls.push({ body, save });
      return Promise.resolve({ applied: true, saved: save });
    },
    wakeLock: wake,
    watchHidden(cb) {
      hiddenCbs.push(cb);
      return () => undefined;
    },
  };
  return { deps, wake, applyCalls, hiddenCbs };
}

describe('createPcCalibration', () => {
  it('measures a known ppm, then applies it as ntp', async () => {
    const r = rig(23.5);
    const cal = createPcCalibration(r.deps);
    expect(cal.status.value).toBe('idle');
    await cal.start({ durationS: 300 });
    expect(cal.status.value).toBe('done');
    expect(cal.fit.value?.ppm).toBeCloseTo(23.5, 2);
    expect(cal.fit.value?.stderrPpm).toBeLessThan(0.01);
    expect(cal.progress.value).toBe(1);
    expect(cal.remainingS.value).toBe(0);
    expect(cal.applicable.value).toBe(true);
    expect(cal.chart.value.points.length).toBeGreaterThan(5);
    expect(cal.chart.value.line).toHaveLength(2);
    expect(r.wake.acquire).toHaveBeenCalledTimes(1);
    expect(r.wake.release).toHaveBeenCalledTimes(1);

    expect(await cal.apply(true)).toBe(true);
    const c = r.applyCalls[0];
    expect(c?.save).toBe(true);
    expect(c?.body.source).toBe('ntp');
    expect(c?.body.ppm).toBeCloseTo(23.5, 2);
    expect(c?.body.durationS).toBeGreaterThan(250);
    expect(c?.body.dateUnix).toBeGreaterThan(1_700_000_000);
    expect(cal.applied.value).toBe(true);
    expect(cal.saved.value).toBe(true);
  });

  it('clamps short durations to the 120 s minimum', async () => {
    const cal = createPcCalibration(rig(0).deps);
    await cal.start({ durationS: 10 });
    expect(cal.durationS.value).toBe(120);
  });

  it('restarts after a wall-clock step and still converges', async () => {
    const cal = createPcCalibration(rig(-10, { stepAtCall: 40, stepMs: 500 }).deps);
    await cal.start({ durationS: 300 });
    expect(cal.stepRestarts.value).toBe(1);
    expect(cal.status.value).toBe('done');
    expect(cal.fit.value?.ppm).toBeCloseTo(-10, 2);
  });

  it('counts probe timeouts and keeps going', async () => {
    const cal = createPcCalibration(rig(5, { failEvery: 5 }).deps);
    await cal.start({ durationS: 200 });
    expect(cal.timeouts.value).toBeGreaterThan(5);
    expect(cal.fit.value?.ppm).toBeCloseTo(5, 2);
  });

  it('flags a hidden tab with a warning', async () => {
    const r = rig(1);
    const cal = createPcCalibration(r.deps);
    const run = cal.start({ durationS: 200 });
    r.hiddenCbs[0]?.();
    await run;
    expect(cal.hiddenSeen.value).toBe(true);
    expect(cal.level.value).toBe('warning');
  });

  it('cancel with too little data fails; late cancel keeps partial result applicable', async () => {
    const early = rig(2);
    const cal1 = createPcCalibration(early.deps);
    const p1 = cal1.start({ durationS: 600 });
    cal1.cancel();
    await p1;
    expect(cal1.status.value).toBe('failed');
    expect(cal1.applicable.value).toBe(false);
    expect(await cal1.apply(false)).toBe(false);

    // Cancel after ~100 s of samples via a sleep hook.
    const r = rig(2);
    const cal2 = createPcCalibration({
      ...r.deps,
      sleep: (ms) => {
        const p = r.deps.sleep(ms);
        if (cal2.sampleCount.value >= 50) cal2.cancel();
        return p;
      },
    });
    await cal2.start({ durationS: 600 });
    expect(cal2.stopReason.value).toBe('cancelled');
    expect(cal2.status.value).toBe('done');
    expect(cal2.applicable.value).toBe(true);
    expect(cal2.message.value).toContain('Stopped early');
  });

  it('reports applied-but-not-saved', async () => {
    const r = rig(3);
    r.deps.apply = () => Promise.resolve({ applied: true, saved: false });
    const cal = createPcCalibration(r.deps);
    await cal.start({ durationS: 200 });
    expect(await cal.apply(true)).toBe(false);
    expect(cal.applied.value).toBe(true);
    expect(cal.level.value).toBe('warning');
  });

  it('reset returns to idle', async () => {
    const cal = createPcCalibration(rig(3).deps);
    await cal.start({ durationS: 200 });
    cal.reset();
    expect(cal.status.value).toBe('idle');
    expect(cal.fit.value).toBeNull();
  });
});
