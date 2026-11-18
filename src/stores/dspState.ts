/**
 * DSP state store: mirrors the device's `getState` snapshot and edits it
 * through `patchState`.
 *
 * - The post-patch snapshot returned by the device is authoritative and
 *   always replaces the local state (the device may clamp values, or clear
 *   bypass when a process block is enabled).
 * - Edits are shown optimistically through an overlay keyed by field
 *   (`bypass`, `<block>.enabled`, `<block>.<param>`), so a slider does not
 *   jump back while its debounced write (or another field's response) is in
 *   flight. A failed write drops the overlay (rollback), shows a snackbar and
 *   re-reads the state.
 * - Writes are debounced per field (sliders 250 ms) and serialised so replies
 *   never interleave.
 */
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { DspBlockKey, DspState, DspStatePatch } from '@/protocol/types';
import { isDeviceError } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';

/** Debounce for continuous controls (ms). */
export const SLIDER_DEBOUNCE_MS = 250;

/**
 * Builds the merge patch for one field.
 * @param block Block key, or `null` for the master bypass.
 * @param field `'enabled'` or a param key (ignored for bypass).
 * @param value New value.
 */
export function buildPatch(
  block: string | null,
  field: string,
  value: number | boolean,
): DspStatePatch {
  if (block === null) return { bypass: Boolean(value) };
  const entry = field === 'enabled' ? { enabled: Boolean(value) } : { params: { [field]: value } };
  return { blocks: { [block]: entry } };
}

/**
 * Reads a param from a snapshot.
 * @param s Snapshot.
 * @param block Block key.
 * @param param Param key.
 */
export function readParam(s: DspState | null, block: string, param: string): number | undefined {
  const b = (
    s?.blocks as Record<string, { params?: Record<string, unknown> } | undefined> | undefined
  )?.[block];
  const v = b?.params?.[param];
  return typeof v === 'number' ? v : undefined;
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
}

/** Pinia store for the DSP state. */
export const useDspStateStore = defineStore('dspState', () => {
  const connection = useConnectionStore();
  const snackbar = useSnackbarStore();

  /** Last authoritative snapshot from the device. */
  const state = ref<DspState | null>(null);
  /** True during the initial / refresh read. */
  const loading = ref(false);
  /** Optimistic values by field id. */
  const optimistic = ref(new Map<string, number | boolean>());
  const pending = new Map<string, PendingWrite>();
  let chain: Promise<void> = Promise.resolve();
  /** Bumped by {@link clear}; queued writes from an older generation never fire. */
  let generation = 0;

  /** Master bypass (optimistic). */
  const bypass = computed<boolean>(() => {
    const o = optimistic.value.get('bypass');
    return typeof o === 'boolean' ? o : (state.value?.bypass ?? true);
  });

  /**
   * Block enabled flag (optimistic).
   * @param key Block key.
   */
  function blockEnabled(key: DspBlockKey): boolean {
    const o = optimistic.value.get(`${key}.enabled`);
    if (typeof o === 'boolean') return o;
    return (state.value?.blocks[key] as { enabled: boolean } | undefined)?.enabled ?? false;
  }

  /**
   * Param value (optimistic).
   * @param key Block key.
   * @param param Param key.
   * @returns The value, or `undefined` when the device does not report it.
   */
  function paramValue(key: DspBlockKey, param: string): number | undefined {
    const o = optimistic.value.get(`${key}.${param}`);
    if (typeof o === 'number') return o;
    return readParam(state.value, key, param);
  }

  /** (Re)reads the state from the device. Public: other views call it (or `reload`) after patching params themselves. */
  async function load(): Promise<void> {
    if (!connection.isConnected) {
      state.value = null;
      return;
    }
    loading.value = true;
    try {
      state.value = await connection.requireTransport().request('getState');
    } catch (e) {
      snackbar.error(e, 'Could not read DSP state');
    } finally {
      loading.value = false;
    }
  }

  function dropOptimistic(id: string): void {
    if (pending.has(id)) return; // a newer edit is waiting; keep showing it
    const next = new Map(optimistic.value);
    next.delete(id);
    optimistic.value = next;
  }

  async function send(id: string, patch: DspStatePatch, gen: number): Promise<void> {
    if (gen !== generation || !connection.isConnected) return; // stale or disconnected: silent
    try {
      state.value = await connection.requireTransport().request('patchState', { patch });
      dropOptimistic(id);
    } catch (e) {
      if (gen !== generation) return;
      dropOptimistic(id);
      const what = isDeviceError(e) && e.code === 'badParam' ? 'Rejected value' : 'Write failed';
      snackbar.error(e, `${what} (${id})`);
      await load();
    }
  }

  function write(
    id: string,
    block: string | null,
    field: string,
    value: number | boolean,
    delayMs: number,
  ): void {
    const next = new Map(optimistic.value);
    next.set(id, value);
    optimistic.value = next;
    const prev = pending.get(id);
    if (prev) clearTimeout(prev.timer);
    const gen = generation;
    const flush = (): void => {
      pending.delete(id);
      chain = chain.then(() => send(id, buildPatch(block, field, value), gen));
    };
    if (delayMs <= 0) {
      pending.delete(id);
      flush();
      return;
    }
    pending.set(id, { timer: setTimeout(flush, delayMs) });
  }

  /**
   * Sets the master bypass.
   * @param on `true` = process chain bypassed.
   */
  function setBypass(on: boolean): void {
    write('bypass', null, 'bypass', on, 0);
  }

  /**
   * Enables / disables a block.
   * @param key Block key.
   * @param on New flag.
   */
  function setEnabled(key: DspBlockKey, on: boolean): void {
    write(`${key}.enabled`, key, 'enabled', on, 0);
  }

  /**
   * Sets a param.
   * @param key Block key.
   * @param param Param key.
   * @param value New value.
   * @param debounceMs Delay before sending (0 = immediately; default 250 for sliders).
   */
  function setParam(
    key: DspBlockKey,
    param: string,
    value: number,
    debounceMs: number = SLIDER_DEBOUNCE_MS,
  ): void {
    write(`${key}.${param}`, key, param, value, debounceMs);
  }

  /** Cancels pending writes and forgets the snapshot (disconnect). */
  function clear(): void {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    generation += 1;
    optimistic.value = new Map();
    state.value = null;
  }

  watch(
    () => connection.isConnected,
    (connected) => {
      if (connected) void load();
      else clear();
    },
    { immediate: true },
  );

  return {
    state,
    loading,
    bypass,
    blockEnabled,
    paramValue,
    load,
    reload: load,
    setBypass,
    setEnabled,
    setParam,
    clear,
  };
});
