/** Tests for the timebase and GPS stores against a fake transport. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Timebase } from '@/protocol/timegrapher_hid';
import type { HidHelloResult } from '@/protocol/types';
import { DeviceError, type Transport } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';
import { createPoller, useTimebaseStore, BUSY_HINT } from './timebase';
import { HIDE_POSITION_KEY, useGpsStore } from './gps';

const hello = (gps: boolean): HidHelloResult => ({
  protocolVersion: 1,
  fwVersion: 'x',
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
    gps,
    pps: gps,
    timebaseLog: true,
  },
});

const tbFixture = (over: Partial<Timebase> = {}): Timebase => ({
  ppm: -3,
  source: 'pps',
  calPpm: -23.4,
  calSource: 'ntp',
  dateUnix: 1_763_000_000,
  durationS: 1800,
  saved: true,
  logDeltaPpm: 0.5,
  logPending: false,
  pps: { enabled: true, locked: true, ppm: -3, window: 64, good: 10, rejects: 0, noFix: 0 },
  gps: {
    enabled: true,
    fix: true,
    quality: 1,
    sats: 8,
    hdop: 1,
    utcUnix: 0,
    ageMs: 0,
    sentences: 0,
    errors: 0,
    overruns: 0,
  },
  ...over,
});

type Handler = (op: string, body?: unknown) => unknown;

async function setup(handler: Handler, gps = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const conn = useConnectionStore();
  const calls: { op: string; body?: unknown }[] = [];
  const t: Transport = {
    kind: 'virtual',
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    request: ((op: string, body?: unknown) => {
      calls.push({ op, body });
      if (op === 'hello') return Promise.resolve(hello(gps));
      try {
        return Promise.resolve(handler(op, body));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }) as Transport['request'],
    onNotify: () => () => undefined,
    onDisconnect: () => () => undefined,
  };
  conn.setTransportFactory(() => t);
  await conn.connect('virtual');
  return { calls, conn };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPoller', () => {
  it('is reference counted and does not overlap', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const p = createPoller(tick, 1000);
    p.start();
    p.start();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000); // in flight: skipped
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    release();
    p.stop(); // one user left
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    release();
    p.stop();
    const n = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick.mock.calls.length).toBe(n);
  });
});

describe('timebase store', () => {
  it('refresh stores the result and records live PPS samples', async () => {
    await setup((op) => (op === 'getTimebase' ? tbFixture() : undefined));
    const s = useTimebaseStore();
    expect(await s.refresh()).toBe(true);
    expect(s.tb?.ppm).toBe(-3);
    expect(s.sessionPps).toHaveLength(1);
    expect(s.sessionPps[0]?.[1]).toBe(-3);
  });

  it('does not record samples when PPS is unlocked', async () => {
    const t = tbFixture();
    t.pps.locked = false;
    await setup(() => t);
    const s = useTimebaseStore();
    await s.refresh();
    expect(s.sessionPps).toHaveLength(0);
  });

  it('explains busy on save', async () => {
    await setup((op) => {
      if (op === 'saveTimebase') throw new DeviceError('busy', 'close the audio stream', op);
      return tbFixture();
    });
    const s = useTimebaseStore();
    expect(await s.save()).toBe(false);
    const sn = useSnackbarStore();
    expect(sn.message).toBe(BUSY_HINT);
    expect(sn.level).toBe('warning');
  });

  it('setLogDelta sends only logDeltaPpm (clamped)', async () => {
    const { calls } = await setup(() => tbFixture());
    const s = useTimebaseStore();
    await s.setLogDelta(50);
    await s.setLogDelta(0.01);
    const bodies = calls.filter((c) => c.op === 'setTimebase').map((c) => c.body);
    expect(bodies).toEqual([{ logDeltaPpm: 10 }, { logDeltaPpm: 0.05 }]);
  });

  it('refreshLog follows pages until total is reached', async () => {
    const e = (i: number) => ({
      dateUnix: 1_700_000_000 + i,
      ppm: i,
      source: 'pps',
      durationS: 0,
      reason: 'delta',
    });
    const { calls } = await setup((op, body) => {
      if (op !== 'getTimebaseLog') return undefined;
      const off = (body as { offset?: number } | undefined)?.offset ?? 0;
      const entries = [0, 1, 2, 3, 4].slice(off, off + 2).map(e);
      return { entries, total: 5, offset: off, pending: false, logDeltaPpm: 1, lastWriteUnix: 0 };
    });
    const s = useTimebaseStore();
    expect(await s.refreshLog()).toBe(true);
    expect(s.log?.entries.map((x) => x.ppm)).toEqual([0, 1, 2, 3, 4]);
    expect(calls.filter((c) => c.op === 'getTimebaseLog')).toHaveLength(3);
  });

  it('refreshLog stops on a page without progress', async () => {
    const { calls } = await setup((op) =>
      op === 'getTimebaseLog'
        ? { entries: [], total: 3, offset: 0, pending: false, logDeltaPpm: 1, lastWriteUnix: 0 }
        : undefined,
    );
    expect(await useTimebaseStore().refreshLog()).toBe(true);
    expect(calls.filter((c) => c.op === 'getTimebaseLog')).toHaveLength(1);
  });
});

describe('gps store', () => {
  it('hides the position by default and persists the toggle', () => {
    setActivePinia(createPinia());
    const g = useGpsStore();
    expect(g.hidePosition).toBe(true);
    g.setHidePosition(false);
    expect(localStorage.getItem(HIDE_POSITION_KEY)).toBe('false');
    setActivePinia(createPinia());
    expect(useGpsStore().hidePosition).toBe(false);
  });

  it('does not request getGps without caps.gps', async () => {
    const { calls } = await setup(() => undefined, false);
    expect(await useGpsStore().refresh()).toBe(false);
    expect(calls.some((c) => c.op === 'getGps')).toBe(false);
  });

  it('stores getGps with caps.gps', async () => {
    await setup(() => ({ fix: true, sats: [] }));
    const g = useGpsStore();
    expect(await g.refresh()).toBe(true);
    expect(g.info?.fix).toBe(true);
  });
});
