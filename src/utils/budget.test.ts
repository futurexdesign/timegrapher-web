import { describe, expect, it } from 'vitest';
import { budgetColor, budgetPercent } from './budget';

describe('budget', () => {
  it('computes percent and guards a zero budget', () => {
    expect(budgetPercent(250, 1000)).toBe(25);
    expect(budgetPercent(5, 0)).toBe(0);
  });
  it('picks thresholds', () => {
    expect(budgetColor(500, 1000)).toBe('success');
    expect(budgetColor(700, 1000)).toBe('warning');
    expect(budgetColor(950, 1000)).toBe('error');
  });
});
