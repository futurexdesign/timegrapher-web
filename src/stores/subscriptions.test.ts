/** Unit tests for the pure claim merge / diff helpers of the subscriptions store. */
import { describe, expect, it } from 'vitest';
import { diffSubscription, mergeClaims } from './subscriptions';

describe('mergeClaims', () => {
  it('is quiet with no claims', () => {
    expect(mergeClaims([])).toEqual({
      metricsHz: 0,
      beatHz: 0,
      timingHz: 0,
      quartzHz: 0,
      events: false,
      errors: false,
      quartzPulses: false,
      beats: false,
    });
  });

  it('takes the maximum rate and ORs flags', () => {
    const m = mergeClaims([
      { beatHz: 1, beats: true },
      { beatHz: 4, metricsHz: 10 },
      { errors: true },
    ]);
    expect(m.beatHz).toBe(4);
    expect(m.metricsHz).toBe(10);
    expect(m.beats).toBe(true);
    expect(m.errors).toBe(true);
    expect(m.events).toBe(false);
  });
});

describe('diffSubscription', () => {
  const base = mergeClaims([]);

  it('returns null when nothing changed', () => {
    expect(diffSubscription(base, mergeClaims([]))).toBeNull();
  });

  it('sends only the changed fields', () => {
    const next = mergeClaims([{ quartzHz: 2, quartzPulses: true }]);
    expect(diffSubscription(base, next)).toEqual({ quartzHz: 2, quartzPulses: true });
  });

  it('treats a missing beats flag as false', () => {
    const prev = { ...base, beats: undefined };
    expect(diffSubscription(prev, base)).toBeNull();
  });
});
