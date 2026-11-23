/** Unit tests for the pure claim merge / diff helpers of the subscriptions store. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { HidHelloResult } from '@/protocol/types';
import type { Transport, TransportKind } from '@/transport/Transport';
import { useConnectionStore } from './connection';
import {
  LINK_RATE_CAPS,
  clampToLink,
  diffSubscription,
  mergeClaims,
  preferPackedBeats,
  useSubscriptionsStore,
} from './subscriptions';

describe('mergeClaims', () => {
  it('is quiet with no claims', () => {
    expect(mergeClaims([])).toEqual({
      metricsHz: 0,
      beatHz: 0,
      timingHz: 0,
      quartzHz: 0,
      events: false,
      errors: false,
      quartzPulses: false,
      beats: false,
      beatsPacked: false,
    });
  });

  it('takes the maximum rate and ORs flags', () => {
    const m = mergeClaims([
      { beatHz: 1, beats: true },
      { beatHz: 4, metricsHz: 10 },
      { errors: true },
    ]);
    expect(m.beatHz).toBe(4);
    expect(m.metricsHz).toBe(10);
    expect(m.beats).toBe(true);
    expect(m.errors).toBe(true);
    expect(m.events).toBe(false);
  });
});

describe('diffSubscription', () => {
  const base = mergeClaims([]);

  it('returns null when nothing changed', () => {
    expect(diffSubscription(base, mergeClaims([]))).toBeNull();
  });

  it('sends only the changed fields', () => {
    const next = mergeClaims([{ quartzHz: 2, quartzPulses: true }]);
    expect(diffSubscription(base, next)).toEqual({ quartzHz: 2, quartzPulses: true });
  });

  it('treats a missing beats flag as false', () => {
    const prev = { ...base, beats: undefined };
    expect(diffSubscription(prev, base)).toBeNull();
  });
});

describe('link rate caps (SUB-01..03)', () => {
  const hello = { protocolVersion: 1, fwVersion: '1', board: 'Pico2', caps: {} } as HidHelloResult;

  /** Connects the store with a transport that records `subscribe` bodies. */
  async function connectWith(kind: TransportKind): Promise<ReturnType<typeof vi.fn>> {
    const request = vi.fn((op: string, body?: object) =>
      Promise.resolve(op === 'hello' ? hello : { ...body }),
    );
    const t: Transport = {
      kind,
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
      request: request as unknown as Transport['request'],
      onNotify: () => () => undefined,
      onDisconnect: () => () => undefined,
    };
    const connection = useConnectionStore();
    connection.setTransportFactory(() => t);
    await connection.connect(kind);
    return request;
  }

  const wanted = { metricsHz: 20, beatHz: 5, timingHz: 5, quartzHz: 5 };

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('SUB-01 clamps the requested rates on webble', async () => {
    const request = await connectWith('webble');
    await useSubscriptionsStore().claim('t', wanted);
    const caps = LINK_RATE_CAPS.webble;
    expect(request).toHaveBeenCalledWith('subscribe', caps);
    expect(caps).toEqual({ metricsHz: 10, beatHz: 2, timingHz: 2, quartzHz: 2 });
  });

  it('SUB-02 leaves the rates unchanged on webhid', async () => {
    const request = await connectWith('webhid');
    await useSubscriptionsStore().claim('t', wanted);
    expect(request).toHaveBeenCalledWith('subscribe', wanted);
  });

  it('SUB-03 the clamp is driven by the exported LINK_RATE_CAPS', () => {
    const caps = LINK_RATE_CAPS.webble;
    expect(caps).toBeDefined();
    const sub = clampToLink({ ...mergeClaims([]), ...wanted }, 'webble');
    expect(sub).toMatchObject(caps ?? {});
    expect(clampToLink(mergeClaims([{ metricsHz: 1 }]), 'webble').metricsHz).toBe(1);
    expect(clampToLink(mergeClaims([{ metricsHz: 99 }]), 'virtual').metricsHz).toBe(99);
  });

  it('re-sends the subscription after a takeover bumps the ownership epoch', async () => {
    const request = await connectWith('webble');
    const subs = useSubscriptionsStore();
    await subs.claim('t', { metricsHz: 5 });
    request.mockClear();
    useConnectionStore().ownershipEpoch++;
    await flushPromises();
    expect(request).toHaveBeenCalledWith('subscribe', { metricsHz: 5 });
  });
});

describe('packed beats subscription (W6)', () => {
  /** Connects with `caps` and returns the request spy. */
  async function connectWithCaps(
    kind: TransportKind,
    caps: object,
  ): Promise<ReturnType<typeof vi.fn>> {
    const hello = { protocolVersion: 1, fwVersion: '1', board: 'Pico2', caps } as HidHelloResult;
    const request = vi.fn((op: string, body?: object) =>
      Promise.resolve(op === 'hello' ? hello : { ...body }),
    );
    const t: Transport = {
      kind,
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
      request: request as unknown as Transport['request'],
      onNotify: () => () => undefined,
      onDisconnect: () => () => undefined,
    };
    const connection = useConnectionStore();
    connection.setTransportFactory(() => t);
    await connection.connect(kind);
    return request;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('PK-10 preferPackedBeats swaps beats for beatsPacked only when supported', () => {
    const sub = mergeClaims([{ beats: true, beatHz: 2 }]);
    expect(preferPackedBeats(sub, true)).toMatchObject({ beats: false, beatsPacked: true });
    expect(preferPackedBeats(sub, false)).toMatchObject({ beats: true, beatsPacked: false });
    expect(preferPackedBeats(mergeClaims([]), true).beatsPacked).toBe(false);
  });

  it.each<TransportKind>(['webhid', 'webble'])(
    'PK-11 subscribes with beatsPacked instead of beats when caps.beatsPacked is set (%s)',
    async (kind) => {
      const request = await connectWithCaps(kind, { beats: true, beatsPacked: 1 });
      await useSubscriptionsStore().claim('t', { beats: true });
      expect(request).toHaveBeenCalledWith('subscribe', { beatsPacked: true });
    },
  );

  it('PK-12 keeps beats: true on a device without caps.beatsPacked', async () => {
    const request = await connectWithCaps('webble', { beats: true });
    await useSubscriptionsStore().claim('t', { beats: true });
    expect(request).toHaveBeenCalledWith('subscribe', { beats: true });
  });
});
