/**
 * Connection-lifecycle tests: device data is dropped on disconnect, a failed
 * `subscribe` is retried with backoff, `getDevice` is polled app-wide, and a
 * protocol-version mismatch only warns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type {
  DspBeatRate,
  DspMetrics,
  DspQuartz,
  DspQuartzPulse,
  DspTiming,
  HidHelloResult,
} from '@/protocol/types';
import type { Transport } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { DEVICE_POLL_MS, useDeviceStore } from './device';
import { useDiagnosticsStore } from './diagnostics';
import { useMechanicalStore } from './mechanical';
import { useMetricsStore } from './metrics';
import { useQuartzStore } from './quartz';
import { useSnackbarStore } from './snackbar';
import { SUBSCRIBE_RETRY_MS, useSubscriptionsStore } from './subscriptions';
import { SESSION_CAP, useTimebaseStore } from './timebase';

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
    deviceMode: true,
  },
};

const quiet = {
  metricsHz: 0,
  beatHz: 0,
  timingHz: 0,
  quartzHz: 0,
  events: false,
  errors: false,
  quartzPulses: false,
  beats: false,
};

type Handler = (op: string, body: unknown) => unknown;

interface Fake {
  t: Transport;
  calls: { op: string; body: unknown }[];
  handler: Handler;
  fireDisconnect: () => void;
}

function fake(h: Handler = () => undefined): Fake {
  let dc: (() => void) | null = null;
  const f: Fake = {
    calls: [],
    handler: h,
    fireDisconnect: () => dc?.(),
    t: {
      kind: 'virtual',
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
      request: ((op: string, body?: unknown) => {
        f.calls.push({ op, body });
        if (op === 'hello') return Promise.resolve(hello);
        try {
          return Promise.resolve(f.handler(op, body));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }) as unknown as Transport['request'],
      onNotify: () => () => undefined,
      onDisconnect: (cb) => {
        dc = () => {
          cb('unplugged');
        };
        return () => undefined;
      },
    },
  };
  return f;
}

async function connect(f: Fake): Promise<void> {
  const c = useConnectionStore();
  c.setTransportFactory(() => f.t);
  await c.connect('virtual');
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('data is dropped when the connection goes down', () => {
  it('resets mechanical, quartz, metrics, diagnostics and timebase stores', async () => {
    const f = fake();
    await connect(f);
    const mech = useMechanicalStore();
    const quartz = useQuartzStore();
    const metrics = useMetricsStore();
    const diag = useDiagnosticsStore();
    const tb = useTimebaseStore();

    mech.ingestRate(
      { locked: true, timebaseOk: true, avgLong: {} } as unknown as DspBeatRate,
      1000,
    );
    mech.ingestBeats([
      { seq: 1, gridId: 1, tS: 1, parity: 0, uUs: 0, nominalUs: 0, status: 'ok' },
    ] as never);
    quartz.ingestQuartz({ measurementId: 7, mode: 'motor' } as DspQuartz);
    quartz.ingestPulse({ measurementId: 7, sequence: 3 } as DspQuartzPulse);
    useSubscriptionsStore(); // handlers registered
    metrics.reset();
    diag.timing = { loopBusyPct: 1 } as DspTiming;
    diag.errors = [{ block: 'gain', reason: 'underrun', uptimeMs: 1, sampleIndex: '1' }];
    tb.sessionPps.push([1, 2]);
    expect(mech.ticks).toHaveLength(1);
    expect(mech.trend).toHaveLength(1);
    expect(quartz.pulses).toHaveLength(1);
    // Metrics: simulate a sample through the public series.
    metrics.latest = { prePeak: 0.5 } as DspMetrics;
    metrics.preSeries = [1, 2];

    await useConnectionStore().disconnect();

    expect(mech.rate).toBeNull();
    expect(mech.ticks).toHaveLength(0);
    expect(mech.trend).toHaveLength(0);
    expect(quartz.quartz).toBeNull();
    expect(quartz.settings).toBeNull();
    expect(quartz.pulses).toHaveLength(0);
    expect(metrics.latest).toBeNull();
    expect(metrics.preSeries).toHaveLength(0);
    expect(diag.timing).toBeNull();
    expect(diag.errors).toHaveLength(0);
    expect(tb.sessionPps).toHaveLength(0);
  });

  it('a new device whose measurementId collides with the old one still gets its pulses', async () => {
    const f = fake();
    await connect(f);
    const quartz = useQuartzStore();
    quartz.ingestQuartz({ measurementId: 1, mode: 'motor' } as DspQuartz);
    quartz.ingestPulse({ measurementId: 1, sequence: 5 } as DspQuartzPulse);
    await useConnectionStore().disconnect();
    await connect(fake());
    quartz.ingestPulse({ measurementId: 1, sequence: 0 } as DspQuartzPulse);
    expect(quartz.pulses.map((p) => p.sequence)).toEqual([0]);
  });
});

describe('subscribe retry', () => {
  it('retries with backoff until it succeeds, reporting once', async () => {
    let fail = true;
    const f = fake((op) => {
      if (op === 'subscribe') {
        if (fail) throw new Error('no reply');
        return { ...quiet, beatHz: 2 };
      }
      return undefined;
    });
    await connect(f);
    const subs = useSubscriptionsStore();
    const count = (): number => f.calls.filter((c) => c.op === 'subscribe').length;
    await vi.advanceTimersByTimeAsync(0);
    await subs.claim('x', { beatHz: 2 });
    const n0 = count();
    expect(n0).toBeGreaterThanOrEqual(1);
    expect(useSnackbarStore().open).toBe(true);
    useSnackbarStore().dismiss();

    await vi.advanceTimersByTimeAsync((SUBSCRIBE_RETRY_MS[0] ?? 0) - 1);
    expect(count()).toBe(n0);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(n0 + 1); // after 1 s
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS[1] ?? 0);
    expect(count()).toBe(n0 + 2); // 2 s later
    expect(useSnackbarStore().open).toBe(false); // retries are quiet
    fail = false;
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS[2] ?? 0);
    expect(count()).toBe(n0 + 3);
    expect(subs.active.beatHz).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(n0 + 3); // settled: no more retries
  });

  it('caps the delay at 10 s and stops on disconnect', async () => {
    const f = fake((op) => {
      if (op === 'subscribe') throw new Error('no reply');
      return undefined;
    });
    await connect(f);
    const subs = useSubscriptionsStore();
    const count = (): number => f.calls.filter((c) => c.op === 'subscribe').length;
    await vi.advanceTimersByTimeAsync(0);
    await subs.claim('x', { beatHz: 2 });
    for (const d of SUBSCRIBE_RETRY_MS) await vi.advanceTimersByTimeAsync(d);
    const n = count();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count()).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count()).toBe(n + 2);
    await useConnectionStore().disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(n + 2);
  });
});

describe('device poll', () => {
  it('polls getDevice app-wide while connected and stops on disconnect', async () => {
    const f = fake((op) =>
      op === 'getDevice' ? { mode: 'usbMic', running: false, usbStreaming: false } : undefined,
    );
    await connect(f);
    const device = useDeviceStore();
    const n = (): number => f.calls.filter((c) => c.op === 'getDevice').length;
    await vi.advanceTimersByTimeAsync(0);
    const first = n();
    expect(first).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(DEVICE_POLL_MS * 3);
    expect(n()).toBe(first + 3);
    f.handler = (op) =>
      op === 'getDevice' ? { mode: 'usbMic', running: true, usbStreaming: true } : undefined;
    await vi.advanceTimersByTimeAsync(DEVICE_POLL_MS);
    expect(device.usbStreaming).toBe(true);
    await useConnectionStore().disconnect();
    const after = n();
    await vi.advanceTimersByTimeAsync(DEVICE_POLL_MS * 5);
    expect(n()).toBe(after);
  });
});

describe('protocol version', () => {
  it('warns on a mismatch but stays connected', async () => {
    const f = fake();
    const orig = f.t.request.bind(f.t);
    f.t.request = ((op: string, body?: unknown) =>
      op === 'hello'
        ? Promise.resolve({ ...hello, protocolVersion: 2 })
        : orig(op as 'ping', body as never)) as Transport['request'];
    await connect(f);
    expect(useConnectionStore().status).toBe('connected');
    const sn = useSnackbarStore();
    expect(sn.level).toBe('warning');
    expect(sn.message).toContain('v2');
  });

  it('is quiet for version 1', async () => {
    await connect(fake());
    expect(useSnackbarStore().open).toBe(false);
  });
});

describe('timebase session series', () => {
  it('stays capped without replacing the array each sample', async () => {
    await connect(fake());
    const tb = useTimebaseStore();
    tb.sessionPps.push(...Array.from({ length: SESSION_CAP }, (_, i): [number, number] => [i, 0]));
    const arr = tb.sessionPps;
    tb.pushSession(SESSION_CAP, 1);
    expect(tb.sessionPps).toBe(arr);
    expect(arr).toHaveLength(SESSION_CAP);
    expect(arr[arr.length - 1]).toEqual([SESSION_CAP, 1]);
    expect(arr[0]).toEqual([1, 0]);
  });
});
