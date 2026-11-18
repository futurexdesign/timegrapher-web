import { describe, expect, it } from 'vitest';
import type { HidHelloCaps } from '@/protocol/types';
import { capChips } from './capsChips';

const caps: HidHelloCaps = {
  maxJsonBytes: 2048,
  metricsHzMax: 20,
  beatHzMax: 5,
  timingHzMax: 5,
  timing: true,
  quartz: false,
  quartzHzMax: 5,
  quartzPulsesMax: 8,
  blocks: ['gain', 'limiter'],
  gps: true,
};

describe('capChips', () => {
  it('marks present and absent features', () => {
    const c = capChips(caps);
    expect(c.find((x) => x.label === 'GPS')?.on).toBe(true);
    expect(c.find((x) => x.label === 'Quartz engine')?.on).toBe(false);
    expect(c.find((x) => x.label === 'Device mode')?.on).toBe(false);
  });
  it('lists limits and omits the quartz rate without quartz', () => {
    const labels = capChips(caps).map((x) => x.label);
    expect(labels).toContain('2 DSP blocks');
    expect(labels.some((l) => l.startsWith('quartz ≤'))).toBe(false);
    expect(capChips({ ...caps, quartz: true }).map((x) => x.label)).toContain('quartz ≤ 5 Hz');
  });
});
