import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { HidHelloResult } from '@/protocol/types';
import { VirtualDevice, VirtualTransport } from '@/sim';
import { DeviceError, type Transport } from '@/transport/Transport';
import { WebBleTransport } from '@/transport/WebBleTransport';
import { defaultTransportFactory, deriveFeatures, useConnectionStore } from './connection';
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
    await store.requireTransport().request('hello');
    expect(t.request).toHaveBeenLastCalledWith('hello');
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

describe('connection store over Bluetooth (CS-01..08)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'bluetooth');
  });

  it('CS-01 the default factory builds a WebBleTransport for webble', () => {
    expect(defaultTransportFactory('webble')).toBeInstanceOf(WebBleTransport);
  });

  it('CS-02 webBleAvailable is false without the API', async () => {
    const store = useConnectionStore();
    await flushPromises();
    expect(store.webBleAvailable).toBe(false);
  });

  it('CS-02 webBleAvailable follows getAvailability and availabilitychanged', async () => {
    let available = true;
    const bt = Object.assign(new EventTarget(), {
      getAvailability: vi.fn(() => Promise.resolve(available)),
    });
    Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
    const store = useConnectionStore();
    await flushPromises();
    expect(store.webBleAvailable).toBe(true);
    available = false;
    bt.dispatchEvent(new Event('availabilitychanged'));
    await flushPromises();
    expect(store.webBleAvailable).toBe(false);
  });

  it('CS-03 connects over webble with an injected transport', async () => {
    const store = useConnectionStore();
    store.setTransportFactory(() => fakeTransport({ kind: 'webble' }));
    await store.connect('webble');
    expect(store.status).toBe('connected');
    expect(store.kind).toBe('webble');
    expect(store.hello?.board).toBe('Pico2');
  });

  it('CS-04 a cancelled chooser is quiet and returns to disconnected', async () => {
    const store = useConnectionStore();
    store.setTransportFactory(() =>
      fakeTransport({
        kind: 'webble',
        open: () => Promise.reject(new DeviceError('notOpen', 'No device selected')),
      }),
    );
    await store.connect('webble');
    expect(store.status).toBe('disconnected');
    expect(useSnackbarStore().open).toBe(false);
  });

  it('CS-05 linkUnsupported shows an error that names the MTU and suggests alternatives', async () => {
    const store = useConnectionStore();
    store.setTransportFactory(() =>
      fakeTransport({
        kind: 'webble',
        open: () =>
          Promise.reject(
            new DeviceError(
              'linkUnsupported',
              'BLE link MTU 23 is below 66; this browser/OS cannot run the control plane',
            ),
          ),
      }),
    );
    await store.connect('webble');
    const snackbar = useSnackbarStore();
    expect(snackbar.level).toBe('error');
    expect(snackbar.message).toContain('MTU 23');
    expect(snackbar.message).toContain('another browser or device');
    expect(store.status).toBe('disconnected');
  });

  it('CS-06 the label ends with BLE only for webble', async () => {
    const store = useConnectionStore();
    store.setTransportFactory(() => fakeTransport({ kind: 'webble' }));
    await store.connect('webble');
    expect(store.deviceLabel).toBe('Pico2 · fw 0.1.0 · BLE');
    await store.disconnect();
    store.setTransportFactory(() => fakeTransport({ kind: 'webhid' }));
    await store.connect('webhid');
    expect(store.deviceLabel).toBe('Pico2 · fw 0.1.0');
  });

  it('CS-07 a disconnect event warns and resets the state', async () => {
    const store = useConnectionStore();
    const t = fakeTransport({ kind: 'webble' });
    store.setTransportFactory(() => t);
    await store.connect('webble');
    t.fireDisconnect();
    expect(store.status).toBe('disconnected');
    expect(store.hello).toBeNull();
    const snackbar = useSnackbarStore();
    expect(snackbar.level).toBe('warning');
    expect(snackbar.message).toContain('unplugged');
  });

  it('CS-08 a hello without link still connects', async () => {
    const store = useConnectionStore();
    expect(hello.link).toBeUndefined();
    store.setTransportFactory(() => fakeTransport({ kind: 'webhid' }));
    await store.connect('webhid');
    expect(store.status).toBe('connected');
  });
});

describe('exclusive control (OWN-01..07)', () => {
  /** Device handle captured by the factory of {@link useSimStore}. */
  let device: VirtualDevice;
  let requests: string[];

  /** Store whose factory builds a simulator that pretends to be a BLE link. */
  function useSimStore(foreign: 'usbHid' | null): ReturnType<typeof useConnectionStore> {
    const store = useConnectionStore();
    store.setTransportFactory(() => {
      device = new VirtualDevice({ linkKind: 'ble' });
      if (foreign !== null) device.setForeignOwner(foreign);
      const t = new VirtualTransport({ device, register: false, latencyMs: 0 });
      const orig = t.request.bind(t);
      t.request = ((op: string, ...rest: unknown[]) => {
        requests.push(op);
        return (orig as (o: string, ...r: unknown[]) => Promise<unknown>)(op, ...rest);
      }) as Transport['request'];
      return t;
    });
    return store;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    requests = [];
  });

  it('OWN-01 a free device connects without a dialog', async () => {
    const store = useSimStore(null);
    await store.connect('webble');
    expect(store.status).toBe('connected');
    expect(store.takeoverRequest).toBeNull();
  });

  it('OWN-02 a held device pauses in needsTakeover after hello only', async () => {
    const store = useSimStore('usbHid');
    await store.connect('webble');
    expect(store.status).toBe('needsTakeover');
    expect(store.takeoverRequest).toEqual({ owner: 'usbHid', phase: 'connect' });
    expect(requests).toEqual(['hello']);
  });

  it('OWN-03 Take over claims and finishes the connect', async () => {
    const store = useSimStore('usbHid');
    await store.connect('webble');
    await store.confirmTakeover();
    expect(requests).toEqual(['hello', 'claim']);
    expect(store.status).toBe('connected');
    expect(store.takeoverRequest).toBeNull();
    await expect(store.requireTransport().request('getState')).resolves.toBeDefined();
  });

  it('OWN-04 Cancel disconnects quietly', async () => {
    const store = useSimStore('usbHid');
    await store.connect('webble');
    await store.cancelTakeover();
    expect(store.status).toBe('disconnected');
    expect(store.takeoverRequest).toBeNull();
    expect(useSnackbarStore().open).toBe(false);
  });

  it('OWN-05 a later linkBusy opens the dialog and Take over re-claims', async () => {
    const store = useSimStore(null);
    await store.connect('webble');
    device.setForeignOwner('usbHid');
    await expect(store.requireTransport().request('getState')).rejects.toMatchObject({
      code: 'linkBusy',
    });
    expect(store.takeoverRequest).toEqual({ owner: 'usbHid', phase: 'busy' });
    const epoch = store.ownershipEpoch;
    await store.confirmTakeover();
    expect(store.takeoverRequest).toBeNull();
    expect(store.ownershipEpoch).toBe(epoch + 1);
    expect(store.status).toBe('connected');
    await expect(store.requireTransport().request('getState')).resolves.toBeDefined();
  });

  it('OWN-06 controlReleased warns, names the new owner and resets', async () => {
    const store = useSimStore(null);
    await store.connect('webble');
    // The simulator delivers the notify from its poll loop, which runs while subscribed.
    await store.requireTransport().request('subscribe', { metricsHz: 5 });
    device.setForeignOwner('usbHid');
    await vi.waitFor(() => {
      expect(store.status).toBe('disconnected');
    });
    const snackbar = useSnackbarStore();
    expect(snackbar.level).toBe('warning');
    expect(snackbar.message).toBe('Another app took control over USB');
    expect(store.hello).toBeNull();
  });

  it('OWN-06 a takeover reported as a transport disconnect gets the same message', async () => {
    const store = useConnectionStore();
    const fire: { cb: ((reason?: string) => void) | null } = { cb: null };
    store.setTransportFactory(() =>
      fakeTransport({
        kind: 'webble',
        onDisconnect: (c) => {
          fire.cb = c;
          return () => undefined;
        },
      }),
    );
    await store.connect('webble');
    fire.cb?.('Control taken over by ble');
    expect(useSnackbarStore().message).toBe('Another app took control over Bluetooth');
    expect(store.status).toBe('disconnected');
  });

  it('OWN-07 firmware without hello.control connects with no dialog', async () => {
    const store = useConnectionStore();
    expect(hello.control).toBeUndefined();
    store.setTransportFactory(() => fakeTransport({ kind: 'webble' }));
    await store.connect('webble');
    expect(store.status).toBe('connected');
    expect(store.takeoverRequest).toBeNull();
  });
});
