/**
 * The one theme-aware colour set for every ECharts chart (Time Grapher and
 * Timebase views), derived from the active Vuetify theme so charts stay readable
 * in light and dark mode.
 */
import { computed, type ComputedRef } from 'vue';
import { useTheme } from 'vuetify';

/** Colours used by the charts. */
export interface ChartColors {
  /** Axis / label text (`#rrggbb`). */
  text: string;
  /** Axis lines (text colour at 60 % alpha, `#rrggbbaa`). */
  axis: string;
  /** Grid lines. */
  grid: string;
  /** Theme surface colour. */
  surface: string;
  /** Theme primary colour. */
  primary: string;
  /** Theme error colour. */
  error: string;
  /** Theme success colour. */
  success: string;
  /** Theme warning colour. */
  warning: string;
  /** Tick (parity 0) series. */
  tick: string;
  /** Tock (parity 1) series. */
  tock: string;
  /** Rate series. */
  rate: string;
  /** Beat error series. */
  beatError: string;
  /** Amplitude series. */
  amplitude: string;
  /** Zero / reference lines. */
  ref: string;
  /** True in the dark theme. */
  dark: boolean;
}

/**
 * @param v Candidate colour.
 * @param fallback Used when `v` is not a string.
 * @returns A colour string.
 */
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Colours following the active Vuetify theme (colour-blind-safe series pairs).
 * @returns A reactive {@link ChartColors}.
 */
export function useChartColors(): ComputedRef<ChartColors> {
  const theme = useTheme();
  return computed(() => {
    const cur = theme.current.value;
    const c = cur.colors;
    const dark = cur.dark;
    const raw = str(c['on-surface'], dark ? '#eeeeee' : '#222222');
    const text = /^#[0-9a-fA-F]{6}/.test(raw) ? raw.slice(0, 7) : dark ? '#eeeeee' : '#222222';
    return {
      text,
      axis: `${text}99`,
      grid: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
      surface: str(c.surface, dark ? '#1e1e1e' : '#ffffff'),
      primary: str(c.primary, '#1976d2'),
      error: str(c.error, '#d32f2f'),
      success: str(c.success, '#2e7d32'),
      warning: str(c.warning, '#ef6c00'),
      tick: dark ? '#64B5F6' : '#1565C0',
      tock: dark ? '#FFB74D' : '#E65100',
      rate: dark ? '#81C784' : '#2E7D32',
      beatError: dark ? '#CE93D8' : '#7B1FA2',
      amplitude: dark ? '#4DD0E1' : '#00838F',
      ref: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
      dark,
    };
  });
}
