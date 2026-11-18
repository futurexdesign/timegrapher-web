/** Tests for the DSP state store: debounce, optimistic overlay, rollback. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { DspState, DspStatePatch } from '@/protocol/types';
import { DeviceError, type Transport } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { buildPatch, useDspStateStore } from './dspState';
import { useSnackbarStore } from './snackbar';

const baseState = (): DspState => ({
  bypass: true,
  blocks: {
    gain: { enabled: false, params: { db: 0 } },
    notch: { enabled: false, params: { hz: 60 } },
  },
});

function setup(patchImpl: (p: DspStatePatch) => Promise<DspState>) {
  setActivePinia(createPinia());
  const request = vi.fn((op: string, body?: { patch: DspStatePatch }) => {
    if (op === 'hello') return Promise.resolve({ protocolVersion: 1 });
    if (op === 'getState') return Promise.resolve(baseState());
    if (op === 'patchState' && body) return patchImpl(body.patch);
    return Promise.resolve({});
  });
  const t = {
    kind: 'virtual',
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    request,
    onNotify: () => () => undefined,
    onDisconnect: () => () => undefined,
  } as unknown as Transport;
  const conn = useConnectionStore();
  conn.setTransportFactory(() => t);
  return { conn, request, store: useDspStateStore(), snack: useSnackbarStore() };
}

describe('buildPatch', () => {
  it('builds bypass, enabled and param patches', () => {
    expect(buildPatch(null, 'bypass', true)).toEqual({ bypass: true });
    expect(buildPatch('gain', 'enabled', true)).toEqual({ blocks: { gain: { enabled: true } } });
    expect(buildPatch('gain', 'db', 6)).toEqual({ blocks: { gain: { params: { db: 6 } } } });
  });
});

describe('dspState store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces slider writes, shows them optimistically and adopts the snapshot', async () => {
    const { conn, request, store } = setup((p) => {
      const s = baseState();
      s.blocks.gain = { enabled: true, params: { db: p.blocks?.gain?.params?.db ?? 0 } };
      s.bypass = false;
      return Promise.resolve(s);
    });
    await conn.connect('virtual');
    await store.load();
    store.setParam('gain', 'db', 3);
    store.setParam('gain', 'db', 5);
    expect(store.paramValue('gain', 'db')).toBe(5);
    expect(request).not.toHaveBeenCalledWith('patchState', expect.anything());
    await vi.advanceTimersByTimeAsync(300);
    expect(request.mock.calls.filter((c) => c[0] === 'patchState')).toHaveLength(1);
    expect(store.paramValue('gain', 'db')).toBe(5);
    expect(store.blockEnabled('gain')).toBe(true);
    expect(store.bypass).toBe(false);
  });

  it('rolls back and notifies on badParam', async () => {
    const { conn, store, snack } = setup(() =>
      Promise.reject(new DeviceError('badParam', 'patch rejected', 'patchState')),
    );
    await conn.connect('virtual');
    await store.load();
    store.setEnabled('gain', true);
    expect(store.blockEnabled('gain')).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.blockEnabled('gain')).toBe(false);
    expect(snack.open).toBe(true);
    expect(snack.message).toContain('patch rejected');
  });
});

describe('dspState disconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops queued edits silently after clear()', async () => {
    const { conn, request, store, snack } = setup(() => Promise.resolve(baseState()));
    await conn.connect('virtual');
    await store.load();
    store.setParam('gain', 'db', 3);
    store.clear();
    await vi.advanceTimersByTimeAsync(400);
    expect(request.mock.calls.filter((c) => c[0] === 'patchState')).toHaveLength(0);
    expect(snack.open).toBe(false);
  });
});
