/**
 * Seeded pseudo-random number generator for the simulator.
 *
 * All simulated randomness (timing jitter, noise, missed beats, GPS signal
 * strength) comes from one {@link Rng} so a given seed reproduces a run
 * exactly, which the model unit tests and the contract suite rely on.
 */

/** Deterministic random source. */
export interface Rng {
  /** @returns A uniform float in `[0, 1)`. */
  next(): number;
  /** @returns A standard-normal sample (mean 0, sigma 1). */
  gaussian(): number;
  /**
   * @param p Probability in `[0, 1]`.
   * @returns `true` with probability `p`.
   */
  chance(p: number): boolean;
  /**
   * @param lo Inclusive lower bound.
   * @param hi Exclusive upper bound.
   * @returns A uniform float in `[lo, hi)`.
   */
  range(lo: number, hi: number): number;
}

/**
 * Creates a mulberry32-based generator.
 * @param seed Any 32-bit integer; equal seeds give equal sequences.
 * @returns The generator.
 */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  let spare: number | null = null;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    // Box-Muller; 1 - next() keeps the log argument in (0, 1].
    const r = Math.sqrt(-2 * Math.log(1 - next()));
    const a = 2 * Math.PI * next();
    spare = r * Math.sin(a);
    return r * Math.cos(a);
  };
  return {
    next,
    gaussian,
    chance: (p: number): boolean => next() < p,
    range: (lo: number, hi: number): number => lo + (hi - lo) * next(),
  };
}
