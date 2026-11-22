/**
 * Tests FT-01..13 (docs/plans/BLE_TRANSPORT_TESTS.md) for {@link FramedTransport}
 * using an in-memory subclass: no WebHID, no Bluetooth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameEncoder, FrameReassembler } from '@/protocol/framer';
import type { RequestOf } from '@/protocol/types';
import { FramedTransport, type FramedTransportOptions } from './FramedTransport';
import { isDeviceError } from './Transport';

/** In-memory link: decodes sent frames into `sent` and lets tests inject device messages. */
class MemoryTransport extends FramedTransport {
  readonly kind = 'virtual' as const;
  readonly sent: Record<string, unknown>[] = [];
  closeLinkCalls = 0;
  private readonly rx = new FrameReassembler();
  private readonly tx = new FrameEncoder();

  constructor(options: FramedTransportOptions = {}) {
    super({ defaultTimeoutMs: 1000, ...options });
  }

  protected openLink(): Promise<void> {
    return Promise.resolve();
  }
  protected closeLink(): Promise<void> {
    this.closeLinkCalls++;
    return Promise.resolve();
  }
  protected sendFrame(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const r = this.rx.push(frame);
    if (r.kind === 'message') this.sent.push(r.message as Record<string, unknown>);
    return Promise.resolve();
  }

  /** Delivers a device-to-host message as link frames. */
  inject(obj: unknown): void {
    for (const f of this.tx.encode(obj)) this.onFrame(f);
  }
  /** Exposes the protected link-loss hook. */
  lose(reason: string): void {
    this.onLinkLost(reason);
  }
}

const ok = (id: unknown, result: unknown): unknown => ({ v: 1, id, ok: true, result });
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

async function opened(options: FramedTransportOptions = { keepaliveMs: 0 }) {
  const t = new MemoryTransport(options);
  await t.open();
  return t;
}

describe('FramedTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('FT-01 rejects a request before open with notOpen', async () => {
    const t = new MemoryTransport();
    await expect(t.request('getTime')).rejects.toMatchObject({ code: 'notOpen' });
  });

  it('FT-02 sends the second request only after the first resolves', async () => {
    const t = await opened();
    const a = t.request('getTime');
    const b = t.request('getTimebase');
    await flush();
    expect(t.sent).toHaveLength(1);
    t.inject(ok(1, { tUs: 1, uptimeMs: 1 }));
    await a;
    await flush();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toMatchObject({ id: 2, op: 'getTimebase' });
    t.inject(ok(2, { ppm: 1 }));
    await expect(b).resolves.toMatchObject({ ppm: 1 });
  });

  it('FT-03 ignores a reply with another id', async () => {
    const t = await opened();
    let settled = false;
    const p = t.request('getTime').finally(() => {
      settled = true;
    });
    await flush();
    t.inject(ok(99, { tUs: 1, uptimeMs: 1 }));
    await flush();
    expect(settled).toBe(false);
    t.inject(ok(1, { tUs: 2, uptimeMs: 2 }));
    await expect(p).resolves.toEqual({ tUs: 2, uptimeMs: 2 });
  });

  it('FT-04 maps an error reply to a DeviceError with code and op', async () => {
    const t = await opened();
    const p = t.request('saveTimebase').catch((e: unknown) => e);
    await flush();
    t.inject({ v: 1, id: 1, ok: false, error: { code: 'badParam', message: 'x' } });
    const e = await p;
    expect(isDeviceError(e) && e.code).toBe('badParam');
    expect(isDeviceError(e) && e.op).toBe('saveTimebase');
    expect((e as Error).message).toBe('x');
  });

  it('FT-05 times out and sends the next queued request', async () => {
    const t = await opened();
    const a = t.request('getTime', undefined, 100).catch((e: unknown) => e);
    const b = t.request('getTimebase');
    await vi.advanceTimersByTimeAsync(101);
    const e = await a;
    expect(isDeviceError(e) && e.code).toBe('timeout');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toMatchObject({ id: 2, op: 'getTimebase' });
    t.inject(ok(2, { ppm: 3 }));
    await expect(b).resolves.toMatchObject({ ppm: 3 });
  });

  it('FT-06 ignores a late reply after a timeout', async () => {
    const t = await opened();
    const a = t.request('getTime', undefined, 100).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    await a;
    expect(() => {
      t.inject(ok(1, { tUs: 9, uptimeMs: 9 }));
    }).not.toThrow();
  });

  it('FT-07 dispatches notifies to every listener even if one throws', async () => {
    const t = await opened();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    t.onNotify(bad);
    t.onNotify(good);
    t.inject({ v: 1, notify: true, op: 'metrics', data: { prePeak: 1 } });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('FT-08 rejects an oversize request with protocol and sends nothing', async () => {
    const t = await opened();
    const big = {
      patch: { quartz: { mode: 'x'.repeat(3000) as 'motor' } },
    } as RequestOf<'patchState'>;
    await expect(t.request('patchState', big)).rejects.toMatchObject({ code: 'protocol' });
    await flush();
    expect(t.sent).toHaveLength(0);
  });

  it('FT-09 link loss rejects in-flight and queued requests and fires listeners once', async () => {
    const t = await opened();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const ps = [t.request('getTime'), t.request('getTimebase'), t.request('getTime')].map((p) =>
      p.catch((e: unknown) => e),
    );
    await flush();
    t.lose('x');
    t.lose('x');
    for (const e of await Promise.all(ps)) expect(isDeviceError(e) && e.code).toBe('disconnected');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('x');
  });

  it('FT-10 close is idempotent, rejects pending and does not fire disconnect listeners', async () => {
    const t = await opened();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const p = t.request('getTime').catch((e: unknown) => e);
    await flush();
    await t.close();
    await t.close();
    const e = await p;
    expect(isDeviceError(e) && e.code).toBe('disconnected');
    expect(cb).not.toHaveBeenCalled();
    expect(t.closeLinkCalls).toBe(1);
  });

  it('FT-11 sends a keepalive ping after idle time; a request resets the idle clock', async () => {
    const t = await opened({ keepaliveMs: 3000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sent.map((m) => m.op)).toEqual(['ping']);
    t.inject(ok(1, { uptimeMs: 1 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.sent.map((m) => m.op)).toEqual(['ping', 'ping']);
    t.inject(ok(2, { uptimeMs: 2 }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    const r = t.request('getTime');
    await flush();
    expect(t.sent).toHaveLength(3);
    t.inject(ok(3, { tUs: 1, uptimeMs: 1 }));
    await r;
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sent).toHaveLength(4);
    expect(t.sent[3]).toMatchObject({ op: 'ping' });
  });

  it('FT-12 a failed keepalive is harmless', async () => {
    const t = await opened({ keepaliveMs: 3000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cb = vi.fn();
    t.onDisconnect(cb);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.sent.map((m) => m.op)).toEqual(['ping']);
    await vi.advanceTimersByTimeAsync(2000); // keepalive timeout
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
    const r = t.request('getTime');
    await flush();
    t.inject(ok(2, { tUs: 5, uptimeMs: 5 }));
    await expect(r).resolves.toEqual({ tUs: 5, uptimeMs: 5 });
  });

  it('FT-13 controlReleased tears the transport down with the takeover reason', async () => {
    const t = await opened();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const p = t.request('getTime').catch((e: unknown) => e);
    await flush();
    t.inject({ v: 1, notify: true, op: 'controlReleased', data: { to: 'ble' } });
    const e = await p;
    expect(isDeviceError(e) && e.code).toBe('disconnected');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('Control taken over by ble');
    await expect(t.request('getTime')).rejects.toMatchObject({ code: 'notOpen' });
    expect(t.closeLinkCalls).toBe(1);
  });
});
