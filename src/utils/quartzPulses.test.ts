/** Tests for quartz pulse residuals and rate selection. */
import { describe, expect, it } from 'vitest';
import type { DspQuartz, DspQuartzPulse } from '@/protocol/types';
import { inhibitionText, isValidGate, pulseResiduals, quartzRates } from './quartzPulses';

function pulse(seq: number, tS: number): DspQuartzPulse {
  return {
    measurementId: 1,
    sequence: seq,
    sampleIndex: '0',
    tS,
    peak: 1,
    snr: 20,
    polarity: seq % 2 === 0 ? 1 : -1,
    extras: 0,
    clipped: false,
    closed: true,
  };
}

describe('pulseResiduals', () => {
  it('is flat for evenly spaced pulses', () => {
    const r = pulseResiduals(Array.from({ length: 10 }, (_, i) => pulse(i, i * 2 + 0.5)));
    expect(r).toHaveLength(10);
    for (const p of r) expect(Math.abs(p.resUs)).toBeLessThan(1e-3);
  });
  it('shows an offset of one polarity in microseconds', () => {
    const ps = Array.from({ length: 20 }, (_, i) => pulse(i, i * 2 + (i % 2 ? 100e-6 : 0)));
    const r = pulseResiduals(ps);
    const even = r.filter((p) => p.polarity === 1).map((p) => p.resUs);
    const odd = r.filter((p) => p.polarity === -1).map((p) => p.resUs);
    // the common line leaks a little of the offset into the slope
    expect(Math.abs((odd[0] ?? 0) - (even[0] ?? 0) - 100)).toBeLessThan(2);
  });
  it('needs three pulses', () => {
    expect(pulseResiduals([pulse(0, 0), pulse(1, 2)])).toEqual([]);
  });
});

describe('quartzRates / helpers', () => {
  it('selects motor headline with inhibition', () => {
    const q = {
      mode: 'motor',
      rateValid: true,
      motor: {
        valid: true,
        rateWithSDay: 1,
        rateWithoutSDay: 2,
        rateWithUncalSDay: 3,
      },
      lcd: null,
      fork: null,
    } as unknown as DspQuartz;
    expect(quartzRates(q)).toEqual({ headline: 1, raw: 2, uncal: 3, valid: true });
  });
  it('is null in mechanical mode', () => {
    expect(
      quartzRates({
        mode: 'mechanical',
        motor: null,
        lcd: null,
        fork: null,
      } as unknown as DspQuartz),
    ).toBeNull();
  });
  it('validates gates', () => {
    expect([0, 3, 10, 960].every(isValidGate)).toBe(true);
    expect([1, 2, 961, 5.5].some(isValidGate)).toBe(false);
  });
  it('texts', () => {
    expect(inhibitionText('corrected')).toMatch(/corrected/);
  });
});
