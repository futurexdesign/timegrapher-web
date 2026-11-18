/**
 * GPS store: polls `getGps` at 1 Hz while a consumer is visible, and owns the
 * "hide position" privacy toggle (default hidden, persisted in localStorage).
 * Does nothing when `caps.gps` is false.
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { GpsInfo } from '@/protocol/timegrapher_hid';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';
import { createPoller } from './timebase';
import { toSat } from '@/utils/sky';

/** localStorage key of the hide-position toggle. */
export const HIDE_POSITION_KEY = 'timegrapher.gps.hidePosition';

/** Reads the persisted toggle (default `true` = hidden). */
export function loadHidePosition(): boolean {
  try {
    return localStorage.getItem(HIDE_POSITION_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Pinia store for GPS detail. */
export const useGpsStore = defineStore('gps', () => {
  const connection = useConnectionStore();
  const snackbar = useSnackbarStore();

  /** Latest getGps result. */
  const info = ref<GpsInfo | null>(null);
  /** Satellites of {@link info} with named fields. */
  const sats = computed(() => (info.value?.sats ?? []).map(toSat));
  /** Position (lat/lon/alt) is hidden in the UI. */
  const hidePosition = ref(loadHidePosition());
  let errorShown = false;

  /**
   * Sets and persists the hide-position toggle.
   * @param v New value.
   */
  function setHidePosition(v: boolean): void {
    hidePosition.value = v;
    try {
      localStorage.setItem(HIDE_POSITION_KEY, String(v));
    } catch {
      /* storage unavailable */
    }
  }

  /** Reads getGps once (no-op without caps.gps). */
  async function refresh(): Promise<boolean> {
    if (!connection.isConnected || !connection.features.gps) return false;
    try {
      info.value = await connection.requireTransport().request('getGps');
      errorShown = false;
      return true;
    } catch (e) {
      if (!errorShown) snackbar.error(e, 'getGps failed');
      errorShown = true;
      return false;
    }
  }

  const poller = createPoller(async () => {
    await refresh();
  });

  /** Starts (reference counted) 1 Hz polling. */
  function startPolling(): void {
    poller.start();
  }
  /** Stops one polling user. */
  function stopPolling(): void {
    poller.stop();
  }

  return { info, sats, hidePosition, setHidePosition, refresh, startPolling, stopPolling };
});
