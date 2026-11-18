/** Tests that the metadata table covers the firmware blocks and is self-consistent. */
import { describe, expect, it } from 'vitest';
import type { DspBlockKey } from '@/protocol/types';
import { BLOCK_META, STATIC_PIPELINE, blockGroup, blocksInGroup, validateParam } from './dspMeta';

/** Sample `caps.blocks` as advertised by current firmware. */
const SAMPLE_CAPS_BLOCKS: DspBlockKey[] = [
  'levelMeter',
  'gain',
  'limiter',
  'filterBank',
  'eventDetect',
  'beatRate',
  'noiseFloor',
  'eventLog',
  'softGate',
  'notch',
  'agc',
  'matchedFilter',
  'firBank',
  'spectrum',
];

describe('BLOCK_META', () => {
  it('covers every block in a sample caps.blocks list', () => {
    for (const k of SAMPLE_CAPS_BLOCKS) {
      expect(BLOCK_META[k], k).toBeDefined();
      expect(BLOCK_META[k].key).toBe(k);
      expect(BLOCK_META[k].description.length).toBeGreaterThan(20);
    }
  });

  it('has valid param definitions', () => {
    for (const b of Object.values(BLOCK_META)) {
      for (const p of b.params) {
        expect(p.readOnly).toBe(p.kind === 'readonly');
        if (p.kind === 'slider') {
          expect(p.min).toBeDefined();
          expect(p.max).toBeDefined();
          expect(p.step).toBeGreaterThan(0);
          expect(p.default).toBeGreaterThanOrEqual(p.min ?? 0);
          expect(p.default).toBeLessThanOrEqual(p.max ?? 0);
        }
        if (p.kind === 'select') {
          expect(p.options?.some((o) => o.value === p.default)).toBe(true);
        }
      }
    }
  });

  it('matches the firmware ranges and read-only flags', () => {
    const p = (b: DspBlockKey, k: string) => BLOCK_META[b].params.find((x) => x.key === k);
    expect([p('gain', 'db')?.min, p('gain', 'db')?.max]).toEqual([-40, 40]);
    expect([p('eventDetect', 'threshold')?.min, p('eventDetect', 'threshold')?.max]).toEqual([
      1, 100,
    ]);
    expect([p('softGate', 'releaseMs')?.min, p('softGate', 'releaseMs')?.max]).toEqual([1, 500]);
    expect([p('beatRate', 'liftAngle')?.min, p('beatRate', 'liftAngle')?.max]).toEqual([10, 90]);
    expect([p('agc', 'tauS')?.min, p('agc', 'tauS')?.max]).toEqual([0.05, 30]);
    expect(p('filterBank', 'preset')?.options?.map((o) => o.value)).toEqual([0, 1, 2, 3]);
    expect(p('notch', 'hz')?.options?.map((o) => o.value)).toEqual([50, 60]);
    for (const [b, k] of [
      ['agc', 'gainDb'],
      ['beatRate', 'calPpm'],
      ['matchedFilter', 'score'],
    ] as const) {
      expect(p(b, k)?.readOnly).toBe(true);
    }
  });
});

describe('groups', () => {
  it('prefers the device group and falls back to the table', () => {
    expect(blockGroup('gain')).toBe('process');
    expect(blockGroup('gain', [{ key: 'gain', group: 'analysis', order: 1, inputs: [] }])).toBe(
      'analysis',
    );
    expect(blockGroup('unknownBlock')).toBeUndefined();
  });

  it('lists present blocks in order, hiding absent ones', () => {
    const keys = blocksInGroup('process', ['agc', 'gain', 'notch', 'spectrum']).map((b) => b.key);
    expect(keys).toEqual(['notch', 'gain', 'agc']);
    expect(blocksInGroup('analysis', SAMPLE_CAPS_BLOCKS, STATIC_PIPELINE)[0]?.key).toBe(
      'levelMeter',
    );
  });
});

describe('validateParam', () => {
  const vph = BLOCK_META.beatRate.params.find((x) => x.key === 'vph');
  it('accepts auto and 3600..72000 integers only', () => {
    if (!vph) throw new Error('vph missing');
    expect(validateParam(vph, 0)).toBeNull();
    expect(validateParam(vph, 21600)).toBeNull();
    expect(validateParam(vph, 3599)).not.toBeNull();
    expect(validateParam(vph, 72001)).not.toBeNull();
    expect(validateParam(vph, 21600.5)).not.toBeNull();
    expect(validateParam(vph, NaN)).not.toBeNull();
  });
});
