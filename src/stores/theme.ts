/**
 * Theme preference store: light / dark / system, persisted in localStorage.
 * Storage access is wrapped in try/catch (private windows, blocked storage).
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

/** User-selectable theme preference. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** localStorage key. */
export const THEME_STORAGE_KEY = 'timegrapher.theme';

/** Reads the stored preference; falls back to `'system'` when absent or storage is blocked. */
function load(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

/**
 * Pinia store for the theme preference. `resolved` is the concrete Vuetify
 * theme name ('light' | 'dark') given the OS preference.
 */
export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>(load());
  const systemDark = ref(
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      systemDark.value = e.matches;
    });
  }

  /** Concrete theme name to apply. */
  const resolved = computed<'light' | 'dark'>(() =>
    preference.value === 'system' ? (systemDark.value ? 'dark' : 'light') : preference.value,
  );

  /**
   * Sets and persists the preference.
   * @param p New preference.
   */
  function setPreference(p: ThemePreference): void {
    preference.value = p;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, p);
    } catch {
      /* storage unavailable */
    }
  }

  return { preference, resolved, setPreference };
});
