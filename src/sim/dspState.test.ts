/** Unit tests for the DspState patch semantics. */
import { describe, expect, it } from 'vitest';
import { DeviceError } from '@/transport/Transport';
import { createRng } from './rng';
import { DspStateStore } from './dspState';
import { QuartzEngine } from './models/quartz';

function store(supported = true): { s: DspStateStore; q: QuartzEngine } {
  const q = new QuartzEngine(createRng(1));
  const s = new DspStateStore({
    supported,
    settings: () => q.settings(),
    setMode: (m) => {
      q.setMode(m);
    },
    setParam: (n, v) => q.setParam(n, v),
  });
  return { s, q };
}

function fails(fn: () => void): DeviceError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DeviceError) return e;
  }
  throw new Error('expected DeviceError');
}

describe('DspStateStore', () => {
  it('has the firmware boot state', () => {
    const { s } = store();
    const st = s.getState();
    expect(st.bypass).toBe(true);
    expect(st.blocks.levelMeter?.enabled).toBe(true);
    expect(st.blocks.limiter?.enabled).toBe(true);
    expect(st.blocks.gain?.enabled).toBe(false);
    expect(st.blocks.softGate?.params).toEqual({ floorDb: -12, attackMs: 1, releaseMs: 40 });
    expect(st.quartz?.kSigma).toBe(8);
  });

  it('omits quartz when unsupported and rejects non-mechanical modes', () => {
    const { s } = store(false);
    expect(s.getState().quartz).toBeUndefined();
    expect(
      fails(() => {
        s.applyPatch({ quartz: { mode: 'motor' } });
      }).message,
    ).toBe('quartz timing needs the PCM1808 source');
    s.applyPatch({ quartz: { mode: 'mechanical' } });
  });

  it('applies bypass, then quartz, then blocks regardless of key order', () => {
    const { s, q } = store();
    s.applyPatch({
      blocks: { gain: { enabled: true } },
      quartz: { mode: 'fork', forkHz: 480 },
      bypass: true,
    });
    // gain enabling (last) clears the bypass written first
    expect(s.bypass).toBe(false);
    expect(q.settings()).toMatchObject({ mode: 'fork', forkHz: 480 });
  });

  it('sets forkHz before mode so the measurement starts with it', () => {
    const { s, q } = store();
    const id = q.currentMeasurementId;
    s.applyPatch({ quartz: { mode: 'fork', forkHz: 720 } });
    expect(q.currentMeasurementId).toBe(id + 1);
  });

  it('accepts case-insensitive names and numeric tsMethod', () => {
    const { s, q } = store();
    s.applyPatch({ quartz: { mode: 'MOTOR' as 'motor', tsMethod: 1 } });
    expect(q.settings()).toMatchObject({ mode: 'motor', tsMethod: 'xcorr' });
    s.applyPatch({ quartz: { tsMethod: 'Threshold' as 'threshold' } });
    expect(q.settings().tsMethod).toBe('threshold');
  });

  it('rejects unknown names before applying anything in quartz', () => {
    const { s, q } = store();
    expect(
      fails(() => {
        s.applyPatch({ quartz: { kSigma: 10, mode: 'x' as 'motor' } });
      }).message,
    ).toBe('quartz.mode must be mechanical, motor, lcd or fork');
    expect(q.settings().kSigma).toBe(8);
    expect(
      fails(() => {
        s.applyPatch({ quartz: { tsMethod: 'x' as 'xcorr' } });
      }).message,
    ).toBe('quartz.tsMethod must be threshold or xcorr');
  });

  it('does not roll back on a range error and continues other params of the block', () => {
    const { s } = store();
    const e = fails(() => {
      s.applyPatch({ blocks: { eventDetect: { params: { threshold: 500, prerollMs: 40 } } } });
    });
    expect(e.code).toBe('badParam');
    expect(s.getState().blocks.eventDetect?.params).toMatchObject({ threshold: 6, prerollMs: 40 });
  });

  it('filter presets toggle the block and clear bypass', () => {
    const { s } = store();
    s.applyPatch({ blocks: { filterBank: { params: { preset: 2 } } } });
    expect(s.getState().blocks.filterBank).toEqual({ enabled: true, params: { preset: 2 } });
    expect(s.bypass).toBe(false);
    s.applyPatch({ blocks: { filterBank: { params: { preset: 0 } } } });
    expect(s.getState().blocks.filterBank?.enabled).toBe(false);
  });

  it('applies enabled before params within a block', () => {
    const { s } = store();
    s.applyPatch({ blocks: { gain: { enabled: false, params: { db: 3 } } } });
    expect(s.getState().blocks.gain?.enabled).toBe(true);
  });

  it('range checks every documented parameter', () => {
    const { s } = store();
    const bad = (patch: object): void => {
      expect(
        fails(() => {
          s.applyPatch({ blocks: patch });
        }).message,
      ).toBe('patch rejected');
    };
    bad({ gain: { params: { db: 41 } } });
    bad({ notch: { params: { hz: 59 } } });
    bad({ beatRate: { params: { liftAngle: 5 } } });
    bad({ beatRate: { params: { vph: 100 } } });
    bad({ beatRate: { params: { windowS: 1 } } });
    bad({ beatRate: { params: { avgS: 61 } } });
    bad({ softGate: { params: { floorDb: 1 } } });
    bad({ agc: { params: { target: 0 } } });
    bad({ spectrum: { params: { stride: 17 } } });
    bad({ matchedFilter: { params: { threshold: 3 } } });
    bad({ gain: { params: { db: NaN } } });
  });
});
