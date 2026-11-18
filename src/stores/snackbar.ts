/**
 * Global snackbar store: any module can surface an error or notice without
 * owning UI. `App.vue` renders the current message in a `v-snackbar`.
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';

/** Visual severity of a snackbar message. */
export type SnackbarLevel = 'error' | 'warning' | 'info' | 'success';

/** Pinia store for transient messages. */
export const useSnackbarStore = defineStore('snackbar', () => {
  /** Whether the snackbar is open. */
  const open = ref(false);
  /** Current message text. */
  const message = ref('');
  /** Current severity. */
  const level = ref<SnackbarLevel>('info');

  /**
   * Shows a message, replacing any current one.
   * @param text Message text.
   * @param lvl Severity.
   */
  function show(text: string, lvl: SnackbarLevel = 'info'): void {
    message.value = text;
    level.value = lvl;
    open.value = true;
  }

  /**
   * Shows an error, extracting the message from `unknown`.
   * @param e Thrown value.
   * @param prefix Optional context prefix.
   */
  function error(e: unknown, prefix?: string): void {
    const text = e instanceof Error ? e.message : String(e);
    show(prefix ? `${prefix}: ${text}` : text, 'error');
  }

  /** Closes the snackbar. */
  function dismiss(): void {
    open.value = false;
  }

  return { open, message, level, show, error, dismiss };
});
