/**
 * Diagnostics store: DSP timing (`getTiming`, polled at 1 Hz while a consumer
 * is visible), link status (`getLink`, likewise polled), the fault log (`getErrors` + live `error` notifies) and the
 * recent event table (`getEvents`, optional live `event` notifies).
 *
 * Consumers call `startPolling()` / `stopPolling()` (reference counted) and
 * `attach()` / `detach()` for the live notify handlers and subscription
 * claims. Nothing here errors on a device without `caps.timing`. All data is
 * cleared when the connection goes down or a new one is made.
 */
import { ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { DspError, DspEvent, DspTiming, HidLinkStatus } from '@/protocol/types';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';
import { useSubscriptionsStore } from './subscriptions';
import { createPoller } from './timebase';

/** Subscription claim owner id. */
export const DIAGNOSTICS_OWNER = 'diagnostics';
/**
 * Events requested by `refreshEvents`. The device returns as many as fit one
 * 2048-byte reply (about 6 of ~330 bytes), newest first, so a shorter list than
 * requested is normal and is shown as is.
 */
export const EVENT_LIMIT = 8;
/** Cap for errors / events retained from live notifies. */
export const LIVE_CAP = 64;

/** Pinia store for timing, errors and events. */
export const useDiagnosticsStore = defineStore('diagnostics', () => {
  const connection = useConnectionStore();
  const snackbar = useSnackbarStore();
  const subs = useSubscriptionsStore();

  /** Latest getTiming result. */
  const timing = ref<DspTiming | null>(null);
  /** Latest getLink result: both links, BLE counters and control ownership. */
  const link = ref<HidLinkStatus | null>(null);
  /** Fault log, oldest first as returned by the device. */
  const errors = shallowRef<DspError[]>([]);
  /** Most recent detected events. */
  const events = shallowRef<DspEvent[]>([]);
  /** Live `{events: true}` push is requested. */
  const liveEvents = ref(false);
  let timingErrorShown = false;
  let linkErrorShown = false;
  let offError: (() => void) | null = null;
  let offEvent: (() => void) | null = null;
  let attached = 0;

  /** Reads getTiming once (no-op without caps.timing). */
  async function refreshTiming(quiet = false): Promise<boolean> {
    if (!connection.isConnected || !connection.features.timing) return false;
    try {
      timing.value = await connection.requireTransport().request('getTiming');
      timingErrorShown = false;
      return true;
    } catch (e) {
      if (!quiet || !timingErrorShown) snackbar.error(e, 'getTiming failed');
      timingErrorShown = true;
      return false;
    }
  }

  const poller = createPoller(async () => {
    await refreshTiming(true);
  });

  /** Starts (reference counted) 1 Hz polling of getTiming. */
  function startPolling(): void {
    poller.start();
  }
  /** Stops one polling user. */
  function stopPolling(): void {
    poller.stop();
  }

  /**
   * Reads getLink once. Every firmware with the control plane answers it; a
   * `linkBusy` reply (another app holds control) is reported once per streak.
   * @param quiet Suppress repeated error snackbars (polling).
   */
  async function refreshLink(quiet = false): Promise<boolean> {
    if (!connection.isConnected) return false;
    try {
      link.value = await connection.requireTransport().request('getLink');
      linkErrorShown = false;
      return true;
    } catch (e) {
      if (!quiet || !linkErrorShown) snackbar.error(e, 'getLink failed');
      linkErrorShown = true;
      return false;
    }
  }

  const linkPoller = createPoller(async () => {
    await refreshLink(true);
  });

  /** Starts (reference counted) 1 Hz polling of getLink. */
  function startLinkPolling(): void {
    linkPoller.start();
  }
  /** Stops one getLink polling user. */
  function stopLinkPolling(): void {
    linkPoller.stop();
  }

  /** Clears the device timing statistics (`resetTiming`) and re-reads them. */
  async function resetTiming(): Promise<boolean> {
    if (!connection.isConnected || !connection.features.timing) return false;
    try {
      await connection.requireTransport().request('resetTiming');
      await refreshTiming();
      return true;
    } catch (e) {
      snackbar.error(e, 'resetTiming failed');
      return false;
    }
  }

  /** Reads the fault log (`getErrors`). */
  async function refreshErrors(): Promise<boolean> {
    if (!connection.isConnected) return false;
    try {
      errors.value = (await connection.requireTransport().request('getErrors')).errors;
      return true;
    } catch (e) {
      snackbar.error(e, 'getErrors failed');
      return false;
    }
  }

  /** Clears the device fault log (`clearErrors`). */
  async function clearErrors(): Promise<boolean> {
    if (!connection.isConnected) return false;
    try {
      await connection.requireTransport().request('clearErrors');
      errors.value = [];
      return true;
    } catch (e) {
      snackbar.error(e, 'clearErrors failed');
      return false;
    }
  }

  /** Reads the newest events (`getEvents`, up to {@link EVENT_LIMIT}; a short reply is fine). */
  async function refreshEvents(): Promise<boolean> {
    if (!connection.isConnected) return false;
    try {
      events.value = (
        await connection.requireTransport().request('getEvents', { limit: EVENT_LIMIT })
      ).events;
      return true;
    } catch (e) {
      snackbar.error(e, 'getEvents failed');
      return false;
    }
  }

  /** Re-issues the subscription claim from the current flags. */
  function claim(): Promise<void> {
    return subs.claim(DIAGNOSTICS_OWNER, { errors: true, events: liveEvents.value });
  }

  /**
   * Enables / disables live event push (applies at once while attached).
   * @param on Whether `event` notifies are wanted.
   */
  async function setLiveEvents(on: boolean): Promise<void> {
    liveEvents.value = on;
    if (attached > 0) await claim();
  }

  /**
   * Starts live `error` (and optionally `event`) notifies; reference counted.
   * Also loads the current error log.
   */
  async function attach(): Promise<void> {
    attached++;
    if (attached > 1) return;
    offError = subs.on('error', (e) => {
      errors.value = [...errors.value, e].slice(-LIVE_CAP);
    });
    offEvent = subs.on('event', (d) => {
      if (!liveEvents.value) return;
      events.value = [...d.events.slice().reverse(), ...events.value].slice(0, LIVE_CAP);
    });
    await claim();
    await refreshErrors();
  }

  /** Releases one attach; the claim and handlers go away with the last one. */
  async function detach(): Promise<void> {
    attached = Math.max(0, attached - 1);
    if (attached > 0) return;
    offError?.();
    offEvent?.();
    offError = null;
    offEvent = null;
    await subs.release(DIAGNOSTICS_OWNER);
  }

  /** Drops all device-specific data (on disconnect / connect). */
  function reset(): void {
    timing.value = null;
    link.value = null;
    errors.value = [];
    events.value = [];
    timingErrorShown = false;
    linkErrorShown = false;
  }

  watch(
    () => connection.isConnected,
    () => {
      reset();
    },
  );

  return {
    timing,
    link,
    errors,
    events,
    liveEvents,
    reset,
    refreshTiming,
    startPolling,
    stopPolling,
    refreshLink,
    startLinkPolling,
    stopLinkPolling,
    resetTiming,
    refreshErrors,
    clearErrors,
    refreshEvents,
    setLiveEvents,
    attach,
    detach,
  };
});
