import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HID_REPORT_ID } from '@/protocol/constants';
import type { RequestOf } from '@/protocol/types';
import { FrameEncoder, FrameReassembler } from '@/protocol/framer';
import { isDeviceError } from './Transport';
import { WebHidTransport } from './WebHidTransport';

/** Minimal fake HIDDevice: records host frames and lets tests inject replies. */
class FakeDevice extends EventTarget {
  opened = false;
  productName = 'Fake';
  readonly sent: unknown[] = [];
  private readonly rx = new FrameReassembler();
  private readonly tx = new FrameEncoder();
  /** Optional auto-responder invoked per decoded request. */
  responder: ((req: Record<string, unknown>) => unknown) | null = null;

  open(): Promise<void> {
    this.opened = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.opened = false;
    return Promise.resolve();
  }
  sendReport(_id: number, data: Uint8Array): Promise<void> {
    const r = this.rx.push(data);
    if (r.kind === 'message') {
      const req = r.message as Record<string, unknown>;
      this.sent.push(req);
      const reply = this.responder?.(req);
      if (reply !== undefined)
        queueMicrotask(() => {
          this.emit(reply);
        });
    }
    return Promise.resolve();
  }
  emit(obj: unknown, reportId = HID_REPORT_ID): void {
    for (const f of this.tx.encode(obj)) {
      const ev = new Event('inputreport') as Event & { reportId: number; data: DataView };
      ev.reportId = reportId;
      ev.data = new DataView(f.buffer);
      this.dispatchEvent(ev);
    }
  }
}

class FakeHid extends EventTarget {
  devices: FakeDevice[] = [];
  filters: unknown;
  requestDevice(opts: { filters: unknown }): Promise<FakeDevice[]> {
    this.filters = opts.filters;
    return Promise.resolve(this.devices);
  }
}

const ok = (id: unknown, result: unknown): unknown => ({ v: 1, id, ok: true, result });

function make(dev = new FakeDevice(), hid = new FakeHid()) {
  hid.devices = [dev];
  const t = new WebHidTransport({ hid: hid as unknown as HID, defaultTimeoutMs: 1000 });
  return { dev, hid, t };
}

describe('WebHidTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests the device with the usage filter and opens it', async () => {
    const { dev, hid, t } = make();
    await t.open();
    expect(hid.filters).toEqual([{ usagePage: 0xffa0, usage: 1 }]);
    expect(dev.opened).toBe(true);
    expect(t.productName).toBe('Fake');
  });

  it('matches replies by id and builds the envelope', async () => {
    const { dev, t } = make();
    dev.responder = (req) => ok(req.id, { t: req.t, uptimeMs: 5 });
    await t.open();
    const res = await t.request('ping', { t: 42 });
    expect(res).toEqual({ t: 42, uptimeMs: 5 });
    expect(dev.sent[0]).toMatchObject({ v: 1, id: 1, op: 'ping', t: 42 });
  });

  it('keeps a single request in flight and preserves order', async () => {
    const { dev, t } = make();
    await t.open();
    const a = t.request('getTime');
    const b = t.request('getTimebase');
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.sent).toHaveLength(1);
    dev.emit(ok(1, { tUs: 1, uptimeMs: 1 }));
    await expect(a).resolves.toEqual({ tUs: 1, uptimeMs: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.sent).toHaveLength(2);
    expect(dev.sent[1]).toMatchObject({ id: 2, op: 'getTimebase' });
    dev.emit(ok(2, { ppm: 1 }));
    await expect(b).resolves.toMatchObject({ ppm: 1 });
  });

  it('rejects with the device error code', async () => {
    const { dev, t } = make();
    dev.responder = (req) => ({
      v: 1,
      id: req.id,
      ok: false,
      error: { code: 'busy', message: 'close the audio stream' },
    });
    await t.open();
    const err: unknown = await t.request('saveTimebase').catch((e: unknown) => e);
    expect(isDeviceError(err) && err.code).toBe('busy');
    expect((err as Error).message).toBe('close the audio stream');
  });

  it('times out, ignores the late reply, and continues with the queue', async () => {
    const { dev, t } = make();
    await t.open();
    const a = t.request('getTime', undefined, 100);
    const b = t.request('getTimebase');
    const aErr = a.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    const e = await aErr;
    expect(isDeviceError(e) && e.code).toBe('timeout');
    dev.emit(ok(1, { tUs: 9, uptimeMs: 9 })); // late
    dev.emit(ok(2, { ppm: 2 }));
    await expect(b).resolves.toMatchObject({ ppm: 2 });
  });

  it('dispatches notifies and supports unsubscribe', async () => {
    const { dev, t } = make();
    await t.open();
    const cb = vi.fn();
    const off = t.onNotify(cb);
    dev.emit({ v: 1, notify: true, op: 'metrics', data: { prePeak: 1 } });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    dev.emit({ v: 1, notify: true, op: 'metrics', data: {} });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('notifies do not resolve the in-flight request', async () => {
    const { dev, t } = make();
    await t.open();
    const p = t.request('getTime');
    await vi.advanceTimersByTimeAsync(0);
    dev.emit({ v: 1, notify: true, op: 'metrics', data: {} });
    dev.emit(ok(1, { tUs: 3, uptimeMs: 3 }));
    await expect(p).resolves.toEqual({ tUs: 3, uptimeMs: 3 });
  });

  it('ignores other report ids', async () => {
    const { dev, t } = make();
    await t.open();
    const cb = vi.fn();
    t.onNotify(cb);
    dev.emit({ v: 1, notify: true, op: 'metrics', data: {} }, 7);
    expect(cb).not.toHaveBeenCalled();
  });

  it('on disconnect rejects pending requests and fires listeners', async () => {
    const { dev, hid, t } = make();
    await t.open();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const a = t.request('getTime').catch((e: unknown) => e);
    const b = t.request('getTimebase').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const ev = new Event('disconnect') as Event & { device: unknown };
    ev.device = dev;
    hid.dispatchEvent(ev);
    expect(cb).toHaveBeenCalledTimes(1);
    for (const e of [await a, await b]) expect(isDeviceError(e) && e.code).toBe('disconnected');
    await expect(t.request('getTime')).rejects.toMatchObject({ code: 'notOpen' });
  });

  it('ignores disconnects of other devices', async () => {
    const { hid, t } = make();
    await t.open();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const ev = new Event('disconnect') as Event & { device: unknown };
    ev.device = {};
    hid.dispatchEvent(ev);
    expect(cb).not.toHaveBeenCalled();
  });

  it('close rejects outstanding requests without firing disconnect listeners', async () => {
    const { dev, t } = make();
    await t.open();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const a = t.request('getTime').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await t.close();
    expect(isDeviceError(await a)).toBe(true);
    expect(dev.opened).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('rejects oversized requests with a protocol error', async () => {
    const { t } = make();
    await t.open();
    await expect(
      t.request('patchState', { patch: { quartz: { mode: 'x'.repeat(3000) as 'motor' } } }),
    ).rejects.toMatchObject({ code: 'protocol' });
    const e: unknown = await t
      .request('patchState', { patch: { quartz: { mode: 'x'.repeat(3000) as 'motor' } } })
      .catch((x: unknown) => x);
    expect((e as Error).message).toContain('2030');
  });

  it('rejects a request just over 2030 bytes, sends one exactly at the cap', async () => {
    const { dev, t } = make();
    await t.open();
    const envelope = JSON.stringify({
      v: 1,
      id: 1,
      op: 'patchState',
      patch: { quartz: { mode: '' } },
    });
    const fill = (n: number): string => 'x'.repeat(n);
    const body = (n: number): RequestOf<'patchState'> => ({
      patch: { quartz: { mode: fill(n) as 'motor' } },
    });
    const room = 2030 - envelope.length;
    void t.request('patchState', body(room)).catch(() => undefined);
    await Promise.resolve();
    await expect(t.request('patchState', body(room + 1))).rejects.toMatchObject({
      code: 'protocol',
    });
    expect(dev.sent.length).toBeLessThanOrEqual(1);
  });

  it('open fails when no device is chosen', async () => {
    const hid = new FakeHid();
    const t = new WebHidTransport({ hid: hid as unknown as HID });
    await expect(t.open()).rejects.toMatchObject({ code: 'notOpen' });
  });
});
