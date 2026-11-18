/** Tests for the shared formatting helpers. */
import { describe, expect, it } from 'vitest';
import {
  fmtDuration,
  fmtFixed,
  fmtRate,
  fmtSigned,
  fmtThousands,
  niceScale,
  NO_VALUE,
} from './format';

describe('format', () => {
  it('signs rates explicitly', () => {
    expect(fmtSigned(3.14159, 1)).toBe('+3.1');
    expect(fmtSigned(-3.14159, 1)).toBe('-3.1');
    expect(fmtSigned(-0.01, 1)).toBe('0.0');
    expect(fmtRate(5, false)).toBe(NO_VALUE);
  });
  it('handles missing values', () => {
    expect(fmtFixed(null)).toBe(NO_VALUE);
    expect(fmtFixed(NaN)).toBe(NO_VALUE);
    expect(fmtFixed(1.234, 2)).toBe('1.23');
  });
  it('formats thousands and durations', () => {
    expect(fmtThousands(28800)).toBe('28 800');
    expect(fmtDuration(75)).toBe('1:15');
    expect(fmtDuration(3725)).toBe('1:02:05');
  });
  it('picks nice scales', () => {
    expect(niceScale(0.3)).toBe(1);
    expect(niceScale(3)).toBe(5);
    expect(niceScale(12)).toBe(20);
    expect(niceScale(60)).toBe(100);
  });
});
