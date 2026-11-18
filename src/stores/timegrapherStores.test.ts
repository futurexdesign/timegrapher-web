/**
 * Tests for the device / mechanical / quartz stores against an inline fake
 * {@link Transport}: run control + subscription claims, beat ingest ordering,
 * grid restarts and series caps.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type {
  DeviceStatus,
  DspBeat,
  DspBeatRate,
  DspQuartz,
  DspQuartzPulse,
  HidNotify,
  OpName,
  RequestOf,
  ResultOf,
} from '@/protocol/types';
import type { NotifyListener, Transport } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import { useDeviceStore } from './device';
import { TICK_CAP, TREND_CAP, useMechanicalStore } from './mechanical';
import { useQuartzStore } from './quartz';

/** Records every request; answers the few ops these stores use. */
class FakeTransport implements Transport {
  readonly kind = 'virtual' as const;
  readonly log: { op: string; body: unknown }[] = [];
  private listeners = new Set<NotifyListener>();
  private status: DeviceStatus = {
    mode: 'usbMic',
    running: false,
    runRequested: false,
    usbStreaming: false,
    streamState: 'idle',
    saved: false,
  };
  private sub: Record<string, unknown> = {};

  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  request<O extends OpName>(op: O, body?: RequestOf<O>): Promise<ResultOf<O>> {
    this.log.push({ op, body });
    let r: unknown = {};
    switch (op) {
      case 'hello':
        r = {
          board: 'fake',
          fwVersion: '0',
          caps: { quartz: true, beats: true, deviceMode: true, timing: true },
        };
        break;
      case 'start':
        this.status = { ...this.status, running: true, runRequested: true };
        r = this.status;
        break;
      case 'stop':
        this.status = { ...this.status, running: false, runRequested: false };
        r = this.status;
        break;
      case 'getDevice':
        r = this.status;
        break;
      case 'setDevice':
        this.status = { ...this.status, mode: (body as { mode: DeviceStatus['mode'] }).mode };
        r = this.status;
        break;
      case 'subscribe':
        this.sub = { ...this.sub, ...(body as object) };
        r = this.sub;
        break;
      case 'patchState':
        r = {
          bypass: false,
          blocks: {},
          quartz: { mode: 'motor', gateS: 0, forkHz: 360, tsMethod: 'threshold', kSigma: 8 },
        };
        break;
      default:
        break;
    }
    return Promise.resolve(r as ResultOf<O>);
  }
  onNotify(cb: NotifyListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onDisconnect(): () => void {
    return () => undefined;
  }
  emit(n: HidNotify): void {
    for (const l of this.listeners) l(n);
  }
  ops(): string[] {
    return this.log.map((l) => l.op);
  }
}

async function setup(): Promise<FakeTransport> {
  setActivePinia(createPinia());
  const t = new FakeTransport();
  const conn = useConnectionStore();
  conn.setTransportFactory(() => t);
  await conn.connect('virtual');
  await nextTick();
  await Promise.resolve();
  return t;
}

function beat(seq: number, over: Partial<DspBeat> = {}): DspBeat {
  return {
    seq,
    gridId: 1,
    sampleIndex: '0',
    tS: seq * 0.125,
    k: seq,
    parity: (seq & 1) as 0 | 1,
    uUs: -seq,
    nominalUs: 125000,
    amplitudeDeg: 280,
    amplitudeValid: true,
    liftMs: 1,
    status: 'accepted',
    ...over,
  };
}

function rate(over: Partial<DspBeatRate> = {}): DspBeatRate {
  const w = {
    rateSDay: 3,
    beatErrorMs: 0.2,
    amplitudeDeg: 280,
    samples: 5,
    rateValid: true,
    beatErrorValid: true,
    amplitudeValid: true,
  };
  return {
    locked: true,
    timebaseOk: true,
    calSource: 'none',
    avgLong: w,
    instant: w,
    avg1s: w,
    ...over,
  } as unknown as DspBeatRate;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('device store', () => {
  it('starts, stops and sets the mode through the ops', async () => {
    const t = await setup();
    const device = useDeviceStore();
    expect(device.supported).toBe(true);
    expect(device.running).toBe(false);
    expect(await device.start()).toBe(true);
    expect(device.running).toBe(true);
    await device.stop();
    expect(device.running).toBe(false);
    await device.setMode('standalone');
    expect(device.mode).toBe('standalone');
    expect(t.ops()).toEqual(expect.arrayContaining(['getDevice', 'start', 'stop', 'setDevice']));
  });
});

describe('mechanical store', () => {
  it('begin: start op then claim; end: release then stop op', async () => {
    const t = await setup();
    const mech = useMechanicalStore();
    await mech.begin();
    const ops = t.ops();
    expect(ops.indexOf('start')).toBeLessThan(ops.indexOf('subscribe'));
    expect(t.log.find((l) => l.op === 'subscribe')?.body).toEqual({ beatHz: 2, beats: true });
    expect(mech.claimed).toBe(true);
    t.log.length = 0;
    await mech.end();
    expect(t.ops()).toEqual(['subscribe', 'stop']);
    expect(t.log[0]?.body).toEqual({ beatHz: 0, beats: false });
    expect(mech.claimed).toBe(false);
  });

  it('appends beats in seq order and drops duplicates', async () => {
    const t = await setup();
    const mech = useMechanicalStore();
    t.emit({
      v: 1,
      notify: true,
      op: 'beats',
      data: { beats: [beat(2), beat(0), beat(1)] },
    } as unknown as HidNotify);
    expect(mech.ticks.map((p) => p.seq)).toEqual([0, 1, 2]);
    mech.ingestBeats([beat(1), beat(3)]);
    expect(mech.ticks.map((p) => p.seq)).toEqual([0, 1, 2, 3]);
  });

  it('flags rejected beats', () => {
    setActivePinia(createPinia());
    const mech = useMechanicalStore();
    mech.ingestBeats([beat(0, { status: 'rejected' })]);
    expect(mech.ticks[0]?.accepted).toBe(false);
  });

  it('clears the trace on a new gridId and counts restarts', () => {
    setActivePinia(createPinia());
    const mech = useMechanicalStore();
    mech.ingestBeats([beat(0), beat(1)]);
    expect(mech.gridRestarts).toBe(0);
    mech.ingestBeats([beat(2, { gridId: 2, status: 'started', uUs: 0 })]);
    expect(mech.ticks.map((p) => p.seq)).toEqual([2]);
    expect(mech.gridId).toBe(2);
    expect(mech.gridRestarts).toBe(1);
  });

  it('treats backwards signal time as a stream reset', () => {
    setActivePinia(createPinia());
    const mech = useMechanicalStore();
    mech.ingestBeats([beat(100), beat(101)]);
    mech.ingestBeats([beat(0, { gridId: 1 })]);
    expect(mech.ticks.map((p) => p.seq)).toEqual([0]);
  });

  it('caps tick points', () => {
    setActivePinia(createPinia());
    const mech = useMechanicalStore();
    for (let i = 0; i < TICK_CAP + 500; i += 8) {
      mech.ingestBeats(Array.from({ length: 8 }, (_, j) => beat(i + j)));
    }
    expect(mech.ticks.length).toBeLessThanOrEqual(TICK_CAP);
    expect(mech.ticks[mech.ticks.length - 1]?.seq).toBe(TICK_CAP + 503);
  });

  it('builds a trend with gaps and caps it', () => {
    setActivePinia(createPinia());
    const mech = useMechanicalStore();
    mech.ingestRate(rate(), 0);
    mech.ingestRate(rate(), 100); // decimated
    mech.ingestRate(rate({ locked: false }), 1000);
    expect(mech.trend).toHaveLength(2);
    expect(mech.trend[0]?.rate).toBe(3);
    expect(mech.trend[1]?.rate).toBeNull();
    expect(mech.uncalibrated).toBe(true);
    for (let i = 0; i < TREND_CAP + 10; i++) mech.ingestRate(rate(), 10_000 + i * 1000);
    expect(mech.trend.length).toBe(TREND_CAP);
  });

  it('patches the lift angle within 10..90 only', async () => {
    const t = await setup();
    const mech = useMechanicalStore();
    expect(await mech.setLiftAngle(5)).toBe(false);
    expect(await mech.setLiftAngle(52)).toBe(true);
    expect(t.log).toContainEqual({
      op: 'patchState',
      body: { patch: { blocks: { beatRate: { params: { liftAngle: 52 } } } } },
    });
    /* The DSP snapshot is refreshed after the edit. */
    expect(t.log.at(-1)?.op).toBe('getState');
  });
});

describe('quartz store', () => {
  function q(id: number): DspQuartz {
    return { mode: 'motor', measurementId: id, state: 'measuring' } as unknown as DspQuartz;
  }
  function p(id: number, seq: number): DspQuartzPulse {
    return { measurementId: id, sequence: seq, tS: seq, polarity: 1 } as unknown as DspQuartzPulse;
  }

  it('begin claims quartz rates; end releases then stops', async () => {
    const t = await setup();
    const qs = useQuartzStore();
    await qs.begin();
    expect(t.log.find((l) => l.op === 'subscribe')?.body).toEqual({
      quartzHz: 2,
      quartzPulses: true,
    });
    await qs.end();
    expect(t.ops().slice(-2)).toEqual(['subscribe', 'stop']);
  });

  it('keeps pulses per measurement and ignores duplicates', () => {
    setActivePinia(createPinia());
    const qs = useQuartzStore();
    qs.ingestQuartz(q(1));
    qs.ingestPulse(p(1, 0));
    qs.ingestPulse(p(1, 1));
    qs.ingestPulse(p(1, 1));
    expect(qs.pulses).toHaveLength(2);
    qs.ingestQuartz(q(2));
    expect(qs.pulses).toHaveLength(0);
  });

  it('maps mode selection to patchState {quartz:{mode}}', async () => {
    const t = await setup();
    const qs = useQuartzStore();
    await qs.setMode('mechanical');
    expect(t.log.at(-1)).toEqual({
      op: 'patchState',
      body: { patch: { quartz: { mode: 'mechanical' } } },
    });
    await qs.setGate(60);
    expect(t.log.at(-1)?.body).toEqual({ patch: { quartz: { gateS: 60 } } });
  });
});
