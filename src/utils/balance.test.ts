/** Tests for balance-wheel kinematics and geometry. */
import { describe, expect, it } from 'vitest';
import { arcPath, balanceAngleDeg, hairspringPath, oscillationHz, polar } from './balance';

describe('balance kinematics', () => {
  it('f = vph / 7200', () => {
    expect(oscillationHz(28800)).toBe(4);
    expect(oscillationHz(21600)).toBe(3);
    expect(oscillationHz(0)).toBe(0);
  });
  it('swings sinusoidally between +-A', () => {
    // 28800 A/h at 1/30: period = 30 / 4 = 7.5 s
    expect(balanceAngleDeg(0, 285, 28800, 30)).toBeCloseTo(0);
    expect(balanceAngleDeg(7.5 / 4, 285, 28800, 30)).toBeCloseTo(285);
    expect(balanceAngleDeg((3 * 7.5) / 4, 285, 28800, 30)).toBeCloseTo(-285);
    expect(balanceAngleDeg(7.5, 285, 28800, 30)).toBeCloseTo(0);
  });
  it('is zero without a valid rate', () => {
    expect(balanceAngleDeg(1, 285, 0, 30)).toBe(0);
  });
});

describe('geometry', () => {
  it('polar: 0 deg is up, 90 deg is right', () => {
    const up = polar(100, 100, 10, 0);
    expect(up.x).toBeCloseTo(100);
    expect(up.y).toBeCloseTo(90);
    expect(polar(100, 100, 10, 90).x).toBeCloseTo(110);
  });
  it('arcPath uses the large-arc flag past 180 degrees', () => {
    expect(arcPath(0, 0, 10, 0, 90)).toContain(' 0 0 1 ');
    expect(arcPath(0, 0, 10, 0, 270)).toContain(' 0 1 1 ');
  });
  it('hairspring keeps the outer end fixed and breathes', () => {
    const o = { cx: 0, cy: 0, rInner: 5, rOuter: 20, turns: 3 };
    const a = hairspringPath(0, 280, o);
    const b = hairspringPath(200, 280, o);
    expect(a).not.toEqual(b);
    // last point (outer end): rotation fades to 0, only radius changes by breath
    const last = (d: string): string => d.split('L').pop() ?? '';
    expect(last(a).split(' ').length).toBe(2);
    expect(a.startsWith('M')).toBe(true);
  });
});
