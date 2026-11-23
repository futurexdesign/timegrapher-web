/** Diagnostics store tests against a fake transport. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type {
  DspError,
  DspEvent,
  DspTiming,
  HidHelloResult,
  HidLinkStatus,
  HidNotify,
} from '@/protocol/types';
import { DeviceError, type Transport } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { EVENT_LIMIT, useDiagnosticsStore } from './diagnostics';
import { useSnackbarStore } from './snackbar';
import { useSubscriptionsStore } from './subscriptions';

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
    quartz: false,
    quartzHzMax: 5,
    quartzPulsesMax: 8,
    blocks: [],
  },
};

const timing = { dspBlockUsLast: 10, dspBlockBudgetUs: 1000, loopBusyPct: 3 } as DspTiming;
const err: DspError = { block: 'gain', reason: 'underrun', uptimeMs: 5, sampleIndex: '1' };
const ev = { startSample: '1', snrDb: 12 } as DspEvent;
const linkStatus: HidLinkStatus = {
  usbHid: { mounted: true },
  control: { owner: 'usbHid', self: true, leaseMs: 10000 },
};

interface Fake {
  t: Transport;
  request: ReturnType<typeof vi.fn>;
  push: (n: HidNotify) => void;
}

function fake(): Fake {
  let listener: ((n: HidNotify) => void) | null = null;
  const request = vi.fn((op: string) => {
    switch (op) {
      case 'hello':
        return Promise.resolve(hello);
      case 'getTiming':
        return Promise.resolve(timing);
      case 'getErrors':
        return Promise.resolve({ errors: [err] });
      case 'getEvents':
        return Promise.resolve({ events: [ev] });
      case 'getLink':
        return Promise.resolve(linkStatus);
      case 'subscribe':
        return Promise.resolve({
          metricsHz: 0,
          beatHz: 0,
          timingHz: 0,
          quartzHz: 0,
          events: false,
          errors: true,
          quartzPulses: false,
          beats: false,
        });
      default:
        return Promise.resolve({ cleared: true });
    }
  });
  const t: Transport = {
    kind: 'virtual',
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    request: request as unknown as Transport['request'],
    onNotify: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    onDisconnect: () => () => undefined,
  };
  return { t, request, push: (n) => listener?.(n) };
}

async function setup(f: Fake): Promise<void> {
  const c = useConnectionStore();
  c.setTransportFactory(() => f.t);
  await c.connect('virtual');
}

describe('diagnostics store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('reads timing, errors and events', async () => {
    const f = fake();
    await setup(f);
    const d = useDiagnosticsStore();
    expect(await d.refreshTiming()).toBe(true);
    expect(d.timing?.loopBusyPct).toBe(3);
    await d.refreshErrors();
    expect(d.errors).toEqual([err]);
    await d.refreshEvents();
    expect(f.request).toHaveBeenCalledWith('getEvents', { limit: EVENT_LIMIT });
    expect(d.events).toEqual([ev]);
  });

  it('reads the link status and clears it on disconnect', async () => {
    const f = fake();
    await setup(f);
    const d = useDiagnosticsStore();
    expect(await d.refreshLink()).toBe(true);
    expect(d.link).toEqual(linkStatus);
    d.reset();
    expect(d.link).toBeNull();
  });

  it('reports a getLink failure once while polling', async () => {
    const f = fake();
    await setup(f);
    /* Only getLink is called from here on. */
    f.request.mockRejectedValue(new DeviceError('linkBusy', 'control held by ble'));
    const d = useDiagnosticsStore();
    const snack = vi.spyOn(useSnackbarStore(), 'error');
    expect(await d.refreshLink(true)).toBe(false);
    expect(await d.refreshLink(true)).toBe(false);
    expect(snack).toHaveBeenCalledTimes(1);
  });

  it('clears errors and resets timing', async () => {
    const f = fake();
    await setup(f);
    const d = useDiagnosticsStore();
    await d.refreshErrors();
    await d.clearErrors();
    expect(d.errors).toEqual([]);
    expect(await d.resetTiming()).toBe(true);
    expect(f.request).toHaveBeenCalledWith('resetTiming');
  });

  it('claims errors while attached and appends live errors', async () => {
    const f = fake();
    await setup(f);
    const d = useDiagnosticsStore();
    const subs = useSubscriptionsStore();
    await d.attach();
    expect(subs.claims.get('diagnostics')).toEqual({ errors: true, events: false });
    f.push({ v: 1, op: 'error', data: { ...err, block: 'agc' } } as HidNotify);
    expect(d.errors.map((e) => e.block)).toEqual(['gain', 'agc']);
    await d.detach();
    expect(subs.claims.has('diagnostics')).toBe(false);
  });

  it('shows live events only when enabled', async () => {
    const f = fake();
    await setup(f);
    const d = useDiagnosticsStore();
    await d.attach();
    f.push({ v: 1, op: 'event', data: { events: [ev] } } as HidNotify);
    expect(d.events).toEqual([]);
    await d.setLiveEvents(true);
    expect(useSubscriptionsStore().claims.get('diagnostics')?.events).toBe(true);
    f.push({ v: 1, op: 'event', data: { events: [ev] } } as HidNotify);
    expect(d.events).toHaveLength(1);
    await d.detach();
  });

  it('does nothing without caps.timing and reports request errors', async () => {
    const f = fake();
    await setup(f);
    const d = useDiagnosticsStore();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    f.request.mockImplementation((op: string): Promise<unknown> =>
      op === 'getErrors'
        ? Promise.reject(new DeviceError('internal', 'boom'))
        : Promise.resolve(hello),
    );
    expect(await d.refreshErrors()).toBe(false);
    expect(useSnackbarStore().message).toContain('boom');
    const c = useConnectionStore();
    if (c.hello) c.hello.caps.timing = false;
    expect(await d.refreshTiming()).toBe(false);
  });
});
