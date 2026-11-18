/**
 * Helpers for showing a measured time against its budget.
 */

/**
 * Percentage of the budget used (0 when the budget is unknown).
 * @param us Measured time (µs).
 * @param budgetUs Budget (µs).
 */
export function budgetPercent(us: number, budgetUs: number): number {
  return budgetUs > 0 ? (us / budgetUs) * 100 : 0;
}

/**
 * Vuetify colour name for a time vs budget: success below 60 %, warning below
 * 90 %, error above.
 * @param us Measured time (µs).
 * @param budgetUs Budget (µs).
 */
export function budgetColor(us: number, budgetUs: number): 'success' | 'warning' | 'error' {
  const p = budgetPercent(us, budgetUs);
  return p < 60 ? 'success' : p < 90 ? 'warning' : 'error';
}
