/**
 * Device store: capture mode (usbMic / standalone) and run control
 * (start / stop) via the `getDevice`, `setDevice`, `start` and `stop` ops.
 *
 * The ops need `hello.caps.deviceMode`. On firmware without it capture is
 * always on, so `running` is true while connected and the controls are hidden
 * (`supported` is false); nothing here ever errors on a missing feature.
 *
 * While connected the status is re-read every {@link DEVICE_POLL_MS} (app-wide,
 * not tied to a view) so `usbStreaming` is fresh wherever it is shown.
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { DeviceMode, DeviceStatus } from '@/protocol/types';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';

/** Period of the app-wide `getDevice` poll while connected (ms). */
export const DEVICE_POLL_MS = 2000;

/** Pinia store for device mode and run state. */
export const useDeviceStore = defineStore('device', () => {
  const connection = useConnectionStore();
  const snackbar = useSnackbarStore();

  /** Last status reported by the device, or null. */
  const status = shallowRef<DeviceStatus | null>(null);
  /** True while a start / stop / setDevice request is in flight. */
  const busy = ref(false);

  /** The device implements mode / run control. */
  const supported = computed(() => connection.isConnected && connection.features.deviceMode);
  /** Capture + analysis are running. Always true on devices without run control. */
  const running = computed(() =>
    supported.value ? (status.value?.running ?? false) : connection.isConnected,
  );
  /** Capture mode, or null when unknown / unsupported. */
  const mode = computed<DeviceMode | null>(() => status.value?.mode ?? null);
  /** The PC audio stream is open (usbMic mode): it drives capture. */
  const usbStreaming = computed(() => status.value?.usbStreaming ?? false);

  /**
   * Runs a status-returning request, storing the result.
   * @returns True on success.
   */
  async function run(context: string, call: () => Promise<DeviceStatus>): Promise<boolean> {
    if (!supported.value) return true;
    busy.value = true;
    try {
      status.value = await call();
      return true;
    } catch (e) {
      snackbar.error(e, context);
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** Re-reads the device status (`getDevice`). Quiet on error (used for polling). */
  async function refresh(): Promise<void> {
    if (!supported.value) return;
    try {
      status.value = await connection.requireTransport().request('getDevice');
    } catch {
      /* transient (e.g. disconnect); the connection store reports it */
    }
  }

  /** Starts capture (`start`). @returns True on success. */
  function start(): Promise<boolean> {
    return run('Start failed', () => connection.requireTransport().request('start'));
  }

  /** Stops capture (`stop`). @returns True on success. */
  function stop(): Promise<boolean> {
    return run('Stop failed', () => connection.requireTransport().request('stop'));
  }

  /**
   * Persists the capture mode (`setDevice`); fails with `busy` while audio streams.
   * @param m New mode.
   * @returns True on success.
   */
  function setMode(m: DeviceMode): Promise<boolean> {
    return run('Mode change failed', () =>
      connection.requireTransport().request('setDevice', { mode: m }),
    );
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  function stopPoll(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  watch(
    () => connection.isConnected,
    (c) => {
      status.value = null;
      stopPoll();
      if (!c) return;
      void refresh();
      timer = setInterval(() => void refresh(), DEVICE_POLL_MS);
    },
    { immediate: true },
  );
  onScopeDispose(stopPoll);

  return { status, busy, supported, running, mode, usbStreaming, refresh, start, stop, setMode };
});
