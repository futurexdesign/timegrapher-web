/**
 * Quartz timegrapher store: measurement snapshot (`quartz` notify), motor
 * pulses (`quartzPulse` notify), settings and the mode / gate / fork controls.
 *
 * Mode selection is `patchState {quartz:{mode}}`; selecting a different mode
 * starts a new measurement. `mechanical` is also a value of that field, so
 * {@link setMode}('mechanical') switches back to the mechanical analysis.
 * Pulses are kept per measurement: a new `measurementId` drops the history.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type {
  DspQuartz,
  DspQuartzPulse,
  QuartzMode,
  QuartzState,
  QuartzStatePatch,
} from '@/protocol/types';
import { useConnectionStore } from './connection';
import { useDeviceStore } from './device';
import { useSnackbarStore } from './snackbar';
import { useSubscriptionsStore } from './subscriptions';

/** Subscription claim owner id. */
export const QUARTZ_OWNER = 'timegrapher.quartz';
/** Subscription this view needs while running. */
export const QUARTZ_CLAIM = { quartzHz: 2, quartzPulses: true } as const;
/** Max retained pulses of one measurement. */
export const PULSE_CAP = 4096;

/** Pinia store for quartz measurement. */
export const useQuartzStore = defineStore('quartz', () => {
  const connection = useConnectionStore();
  const subs = useSubscriptionsStore();
  const device = useDeviceStore();
  const snackbar = useSnackbarStore();

  /** Latest quartz snapshot. */
  const quartz = shallowRef<DspQuartz | null>(null);
  /** Settings from getState / patchState. */
  const settings = shallowRef<QuartzState | null>(null);
  /** Pulses of the current measurement, ordered by sequence. */
  const pulses = shallowRef<DspQuartzPulse[]>([]);
  /** Bumped on every change of {@link pulses}. */
  const pulseVersion = ref(0);
  /** This store holds its subscription claim. */
  const claimed = ref(false);

  /** Active mode (settings first, snapshot as fallback). */
  const mode = computed<QuartzMode | null>(
    () => settings.value?.mode ?? quartz.value?.mode ?? null,
  );

  let measurementId: number | null = null;

  /** Drops the pulse history and adopts `id` as the current measurement. */
  function resetPulses(id: number | null): void {
    measurementId = id;
    pulses.value = [];
    pulseVersion.value++;
  }

  /**
   * Handles a `quartz` snapshot; a new measurementId drops the pulse history.
   * @param q Snapshot.
   */
  function ingestQuartz(q: DspQuartz): void {
    quartz.value = q;
    if (measurementId !== q.measurementId) resetPulses(q.measurementId);
  }

  /**
   * Handles one `quartzPulse` notify (duplicates by sequence are dropped).
   * @param p Pulse.
   */
  function ingestPulse(p: DspQuartzPulse): void {
    if (measurementId !== p.measurementId) resetPulses(p.measurementId);
    const arr = pulses.value;
    const last = arr[arr.length - 1];
    if (last && p.sequence <= last.sequence) return;
    arr.push(p);
    if (arr.length > PULSE_CAP) arr.splice(0, arr.length - PULSE_CAP);
    pulseVersion.value++;
  }

  /** Reads the settings (`getState`); no-op without the quartz feature. */
  async function syncSettings(): Promise<void> {
    if (!connection.features.quartz) return;
    try {
      const s = await connection.requireTransport().request('getState');
      if (s.quartz) settings.value = s.quartz;
    } catch (e) {
      snackbar.error(e, 'Reading quartz settings');
    }
  }

  /**
   * Applies a quartz settings patch.
   * @param patch Fields to change.
   * @returns True on success.
   */
  async function patch(patch: QuartzStatePatch): Promise<boolean> {
    if (!connection.features.quartz) return false;
    try {
      const s = await connection
        .requireTransport()
        .request('patchState', { patch: { quartz: patch } });
      if (s.quartz) settings.value = s.quartz;
      return true;
    } catch (e) {
      snackbar.error(e, 'Quartz setting');
      return false;
    }
  }

  /**
   * Selects the measurement mode ('mechanical' returns to the beat analysis).
   * @param m Mode.
   * @returns True on success.
   */
  async function setMode(m: QuartzMode): Promise<boolean> {
    const ok = await patch({ mode: m });
    if (ok) {
      quartz.value = null;
      resetPulses(null);
    }
    return ok;
  }

  /**
   * Sets the motor gate (0 or 3..960 s).
   * @param s Seconds.
   */
  function setGate(s: number): Promise<boolean> {
    return patch({ gateS: s });
  }

  /**
   * Sets the fork frequency.
   * @param hz One of 300, 341.333, 360, 480, 720.
   */
  function setForkHz(hz: number): Promise<boolean> {
    return patch({ forkHz: hz });
  }

  /** Starts a new measurement in the active mode (`quartzRestart`). */
  async function restart(): Promise<boolean> {
    try {
      ingestQuartz(await connection.requireTransport().request('quartzRestart'));
      return true;
    } catch (e) {
      snackbar.error(e, 'Restart');
      return false;
    }
  }

  /** Starts the device and claims the quartz subscription. @returns True when started. */
  async function begin(): Promise<boolean> {
    if (!(await device.start())) return false;
    claimed.value = true;
    await subs.claim(QUARTZ_OWNER, QUARTZ_CLAIM);
    return true;
  }

  /** Releases the claim, then stops the device. */
  async function end(): Promise<void> {
    await release();
    await device.stop();
  }

  /** Claims the subscription without touching the device. */
  async function claim(): Promise<void> {
    claimed.value = true;
    await subs.claim(QUARTZ_OWNER, QUARTZ_CLAIM);
  }

  /** Releases the subscription claim without touching the device. */
  async function release(): Promise<void> {
    claimed.value = false;
    await subs.release(QUARTZ_OWNER);
  }

  /**
   * Drops all device-specific state, including the remembered measurement id: a
   * new device may reuse an id of the old one and must still ingest its pulses.
   */
  function reset(): void {
    quartz.value = null;
    settings.value = null;
    resetPulses(null);
  }

  watch(
    () => connection.isConnected,
    () => {
      reset();
    },
  );

  subs.on('quartz', ingestQuartz);
  subs.on('quartzPulse', ingestPulse);

  return {
    quartz,
    settings,
    pulses,
    pulseVersion,
    claimed,
    mode,
    reset,
    ingestQuartz,
    ingestPulse,
    syncSettings,
    patch,
    setMode,
    setGate,
    setForkHz,
    restart,
    begin,
    end,
    claim,
    release,
  };
});
