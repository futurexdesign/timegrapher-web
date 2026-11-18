import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { HidHelloResult } from '@/protocol/types';
import { DeviceError, type Transport } from '@/transport/Transport';
import { deriveFeatures, useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';

const hello: HidHelloResult = {
  protocolVersion: 1,
  fwVersion: '0.1.0',
  board: 'Pico2',
  source: 'PCM1808',
  vid: 1,
  pid: 2,
  caps: {
    maxJsonBytes: 2048,
    metricsHzMax: 20,
    beatHzMax: 5,
    timingHzMax: 5,
    timing: true,
    quartz: true,
    quartzHzMax: 5,
    quartzPulsesMax: 8,
    blocks: [],
    beats: true,
    gps: false,
    pipeline: [{ key: 'input', group: 'source', order: 0, inputs: [] }],
  },
};

function fakeTransport(over: Partial<Transport> = {}): Transport & { fireDisconnect: () => void } {
  let dc: (() => void) | null = null;
  return {
    kind: 'virtual',
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    request: vi.fn(() => Promise.resolve(hello)) as unknown as Transport['request'],
    onNotify: () => () => undefined,
    onDisconnect: (cb) => {
      dc = () => {
        cb('unplugged');
      };
      return () => undefined;
    },
    fireDisconnect: () => dc?.(),
    ...over,
  };
}

describe('connection store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('derives feature flags from caps', () => {
    expect(deriveFeatures(null).quartz).toBe(false);
    const f = deriveFeatures(hello.caps);
    expect(f).toMatchObject({
      quartz: true,
      beats: true,
      gps: false,
      deviceMode: false,
      pipeline: true,
    });
  });

  it('connects, says hello and exposes caps', async () => {
    const store = useConnectionStore();
    const t = fakeTransport();
    store.setTransportFactory(() => t);
    await store.connect('virtual');
    expect(store.status).toBe('connected');
    expect(store.deviceLabel).toBe('Pico2 · fw 0.1.0');
    expect(store.features.beats).toBe(true);
    expect(store.requireTransport()).toBe(t);
    await store.disconnect();
    expect(store.status).toBe('disconnected');
    expect(t.close).toHaveBeenCalled();
    expect(() => store.requireTransport()).toThrow(DeviceError);
  });

  it('reports connect failures via the snackbar and resets', async () => {
    const store = useConnectionStore();
    store.setTransportFactory(() =>
      fakeTransport({ open: () => Promise.reject(new Error('boom')) }),
    );
    await store.connect('webhid');
    expect(store.status).toBe('disconnected');
    expect(useSnackbarStore().message).toContain('boom');
  });

  it('does not show an error when the chooser is cancelled', async () => {
    const store = useConnectionStore();
    store.setTransportFactory(() =>
      fakeTransport({
        open: () => Promise.reject(new DeviceError('notOpen', 'No device selected')),
      }),
    );
    await store.connect('webhid');
    expect(useSnackbarStore().open).toBe(false);
  });

  it('resets on device disconnect', async () => {
    const store = useConnectionStore();
    const t = fakeTransport();
    store.setTransportFactory(() => t);
    await store.connect('virtual');
    t.fireDisconnect();
    expect(store.status).toBe('disconnected');
    expect(useSnackbarStore().message).toContain('unplugged');
  });

  it('the default virtual factory connects to the simulator', async () => {
    const store = useConnectionStore();
    await store.connect('virtual');
    expect(store.status).toBe('connected');
    expect(store.kind).toBe('virtual');
    expect(store.features.deviceMode).toBe(true);
    await store.disconnect();
    expect(store.status).toBe('disconnected');
  });
});
