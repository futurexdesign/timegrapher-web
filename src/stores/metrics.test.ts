/** Tests for the metrics store helpers and claim lifecycle. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DBFS_FLOOR, METRICS_OWNER, pushCapped, toDbfs, useMetricsStore } from './metrics';
import { useSubscriptionsStore } from './subscriptions';

describe('helpers', () => {
  it('converts to dBFS with a floor', () => {
    expect(toDbfs(1)).toBeCloseTo(0);
    expect(toDbfs(0.5)).toBeCloseTo(-6.02, 1);
    expect(toDbfs(0)).toBe(DBFS_FLOOR);
    expect(toDbfs(1e-9)).toBe(DBFS_FLOOR);
  });

  it('caps a series from the front', () => {
    expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushCapped([1], 2, 3)).toEqual([1, 2]);
  });
});

describe('metrics store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('claims metricsHz while held and releases after the last holder', () => {
    const m = useMetricsStore();
    const subs = useSubscriptionsStore();
    m.acquire();
    m.acquire();
    expect(subs.claims.get(METRICS_OWNER)).toEqual({ metricsHz: 5 });
    m.release();
    expect(subs.claims.has(METRICS_OWNER)).toBe(true);
    m.release();
    expect(subs.claims.has(METRICS_OWNER)).toBe(false);
  });
});
