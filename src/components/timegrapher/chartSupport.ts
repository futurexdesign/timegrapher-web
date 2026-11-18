/**
 * Shared chart helpers for the Time Grapher view: a trailing-edge throttle that rebuilds an ECharts option
 * at most every {@link REDRAW_INTERVAL_MS} (4 Hz).
 */
import { onBeforeUnmount, shallowRef, watch, type ShallowRef, type WatchSource } from 'vue';

/** Minimum time between redraws (ms) = 4 Hz. */
export const REDRAW_INTERVAL_MS = 250;

/**
 * Computes `build()` now and again (at most every `intervalMs`) whenever any
 * of `sources` changes. Trailing-edge: a burst of changes yields one rebuild.
 * @param build Pure builder of the value (option and/or readout).
 * @param sources Reactive sources that invalidate the value.
 * @param intervalMs Minimum time between rebuilds.
 */
export function useThrottled<T>(
  build: () => T,
  sources: WatchSource[],
  intervalMs: number = REDRAW_INTERVAL_MS,
): ShallowRef<T> {
  const out = shallowRef(build()) as ShallowRef<T>;
  let last = performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    timer = null;
    last = performance.now();
    out.value = build();
  };
  watch(sources, () => {
    if (timer !== null) return;
    timer = setTimeout(run, Math.max(0, intervalMs - (performance.now() - last)));
  });
  onBeforeUnmount(() => {
    if (timer !== null) clearTimeout(timer);
  });
  return out;
}
