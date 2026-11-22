/**
 * Tests for {@link WebBleTransport} against the fake Bluetooth stack
 * (BLE_TRANSPORT_TESTS.md §7, WB-01..20). All tests run under fake timers:
 * the fake peripheral delivers notifications through `setTimeout`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLE_NAME_PREFIX,
  BLE_RX_UUID,
  BLE_SERVICE_UUID,
  BLE_TX_UUID,
  HID_REPORT_BYTES,
} from '@/protocol/constants';
import { FrameEncoder } from '@/protocol/framer';
import type { HidNotify } from '@/protocol/types';
import { DeviceError } from './Transport';
import {
  FakeBluetooth,
  FakeCharacteristic,
  FakePeripheral,
  type FakePeripheralOptions,
} from './fakeBluetooth';
import {
  WebBleTransport,
  isWebBleAvailable,
  isWebBleSupported,
  type WebBleTransportOptions,
} from './WebBleTransport';

/** A fake stack plus a transport over it. Keepalive is off unless a test enables it. */
function setup(
  peripheral: FakePeripheralOptions = {},
  options: Partial<WebBleTransportOptions> = {},
) {
  const bt = new FakeBluetooth(new FakePeripheral({ pollMs: 0, ...peripheral }));
  const t = new WebBleTransport({ bluetooth: bt.api, keepaliveMs: 0, ...options });
  return { bt, p: bt.peripheral, t };
}

/** Lets fake time pass in 1 ms steps until `p` settles (max 10 s), then returns it. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const flag = { done: false };
  p.then(
    () => (flag.done = true),
    () => (flag.done = true),
  );
  for (let i = 0; i < 10_000 && !flag.done; i++) await vi.advanceTimersByTimeAsync(1);
  return p;
}

/** Reads the rejection of `p` (fails when it resolves). */
async function errorOf(p: Promise<unknown>): Promise<DeviceError> {
  try {
    await settle(p);
  } catch (e) {
    if (e instanceof DeviceError) return e;
    throw e;
  }
  throw new Error('expected rejection');
}

/** Payload field that makes a `ping` request span exactly 5 frames. */
const FIVE_FRAGMENT_PAD = 'x'.repeat(240);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WebBleTransport', () => {
  it('WB-01 isWebBleSupported reflects navigator.bluetooth', () => {
    expect(isWebBleSupported()).toBe(false);
    vi.stubGlobal('navigator', { bluetooth: {} });
    expect(isWebBleSupported()).toBe(true);
  });

  it('WB-02 requestDevice uses the service and name-prefix filters', async () => {
    const { bt, t } = setup();
    await t.open();
    expect(bt.requestDeviceCalls).toEqual([
      {
        filters: [{ services: [BLE_SERVICE_UUID] }, { namePrefix: BLE_NAME_PREFIX }],
        optionalServices: [BLE_SERVICE_UUID],
      },
    ]);
  });

  it('WB-03 open sequence starts notifications before the first write', async () => {
    const { p, t } = setup();
    await t.open();
    await settle(t.request('ping'));
    expect(p.log.slice(0, 7)).toEqual([
      'connect',
      'getPrimaryService',
      `getCharacteristic:${BLE_RX_UUID}`,
      `getCharacteristic:${BLE_TX_UUID}`,
      'getCharacteristic:c137e7c3-92b4-4d9e-87e0-9ba757169016',
      'read:info',
      'startNotifications',
    ]);
    expect(p.log.indexOf('write')).toBeGreaterThan(p.log.indexOf('startNotifications'));
  });

  it('WB-04 a dismissed chooser fails quietly with the exact message', async () => {
    const { bt, t } = setup();
    bt.chooserCancelled = true;
    const e = await errorOf(t.open());
    expect(e.code).toBe('notOpen');
    expect(e.message).toBe('No device selected');
    expect((await errorOf(t.request('ping'))).code).toBe('notOpen');
  });

  it('WB-05 an MTU stuck at 23 is retried three times, then linkUnsupported', async () => {
    const { p, t } = setup({ mtu: 23 });
    const open = t.open();
    open.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(299);
    expect(p.infoReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.infoReads).toBe(2);
    const e = await errorOf(open);
    expect(e.code).toBe('linkUnsupported');
    expect(e.message).toBe(
      'BLE link MTU 23 is below 66; this browser/OS cannot run the control plane',
    );
    expect(p.infoReads).toBe(4);
    expect(p.log).toContain('disconnect');
    expect(p.connected).toBe(false);
  });

  it('WB-06 an MTU that becomes usable on the retry opens', async () => {
    const { p, t } = setup({ mtu: 185 });
    p.infoMtuScript = [23, 185];
    await settle(t.open());
    expect(p.infoReads).toBe(2);
    expect(await settle(t.request('ping'))).toHaveProperty('uptimeMs');
  });

  it('WB-07 request and response use unpadded frames', async () => {
    const { p, t } = setup();
    await t.open();
    const r = await settle(t.request('ping', { t: 7 }));
    expect(r.t).toBe(7);
    expect(p.rxWrites).toHaveLength(1);
    const w = p.rxWrites[0];
    expect(w?.length).toBe(5 + (w?.[4] ?? 0));
    expect(w?.length).toBeLessThan(HID_REPORT_BYTES);
  });

  it('WB-08 multi-fragment writes never overlap and keep their order', async () => {
    const { p, t } = setup({ writeLatencyMs: 20 });
    await settle(t.open());
    const big = t.request('ping', { t: 1, pad: FIVE_FRAGMENT_PAD } as never);
    const second = t.request('ping', { t: 2 });
    await settle(big);
    expect((await settle(second)).t).toBe(2);
    const first = p.rxWrites.slice(0, 5);
    expect(first.map((w) => w[2])).toEqual([0, 1, 2, 3, 4]);
    expect(first.every((w) => w[3] === 5)).toBe(true);
    expect(p.rxWrites).toHaveLength(6);
    expect(p.overlapErrors).toBe(0);
  });

  it('WB-09 write mode selects the GATT write method', async () => {
    const a = setup();
    await a.t.open();
    await settle(a.t.request('ping'));
    expect(a.p.log).toContain('write');
    expect(a.p.log).not.toContain('writeNoResponse');

    const b = setup({}, { writeMode: 'withoutResponse' });
    await b.t.open();
    await settle(b.t.request('ping'));
    expect(b.p.log).toContain('writeNoResponse');
    expect(b.p.log).not.toContain('write');
  });

  it('WB-10 unsolicited notifies reach the listeners', async () => {
    const { p, t } = setup();
    await t.open();
    const got: HidNotify[] = [];
    t.onNotify((n) => got.push(n));
    p.sendObject({ v: 1, notify: true, op: 'metrics', data: { x: 1 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toEqual([{ v: 1, notify: true, op: 'metrics', data: { x: 1 } }]);
  });

  it('WB-11 an unexpected disconnect rejects pending requests and fires listeners once', async () => {
    const { bt, p, t } = setup();
    await t.open();
    p.autoReply = false;
    const reasons: (string | undefined)[] = [];
    t.onDisconnect((r) => reasons.push(r));
    const pending = t.request('ping');
    await vi.advanceTimersByTimeAsync(1);
    p.dropLink();
    expect((await errorOf(pending)).code).toBe('disconnected');
    expect(reasons).toEqual(['Device disconnected']);
    expect((await errorOf(t.request('ping'))).code).toBe('notOpen');
    expect(bt.device.count('gattserverdisconnected')).toBe(0);
  });

  it('WB-12 close is idempotent, removes listeners and stays quiet', async () => {
    const { bt, p, t } = setup();
    await t.open();
    const tx = p.tx;
    expect(bt.device.count('gattserverdisconnected')).toBe(1);
    expect(tx?.count('characteristicvaluechanged')).toBe(1);
    const fired = vi.fn();
    t.onDisconnect(fired);
    await t.close();
    await t.close();
    expect(p.log.filter((l) => l === 'stopNotifications')).toHaveLength(1);
    expect(p.log.filter((l) => l === 'disconnect')).toHaveLength(1);
    expect(bt.device.count('gattserverdisconnected')).toBe(0);
    expect(tx?.count('characteristicvaluechanged')).toBe(0);
    expect(fired).not.toHaveBeenCalled();
  });

  it('WB-12 close swallows a stopNotifications failure', async () => {
    const { p, t } = setup();
    await t.open();
    const tx = p.tx;
    if (tx === undefined) throw new Error('no tx');
    tx.stopNotifications = () => Promise.reject(new DOMException('gone', 'NetworkError'));
    await expect(t.close()).resolves.toBeUndefined();
    expect(p.connected).toBe(false);
  });

  it('WB-13 a failed write rejects the request with disconnected', async () => {
    const { p, t } = setup();
    await t.open();
    p.failNextWrite();
    expect((await errorOf(t.request('ping'))).code).toBe('disconnected');
    // The transport itself stays open: the next request works.
    expect(await settle(t.request('ping'))).toHaveProperty('uptimeMs');
  });

  it('WB-14 a value longer than 63 bytes is dropped and later frames still work', async () => {
    const { p, t } = setup();
    await t.open();
    const got: HidNotify[] = [];
    t.onNotify((n) => got.push(n));
    const [frame] = new FrameEncoder().encode({ v: 1, notify: true, op: 'metrics', data: {} });
    const oversized = new Uint8Array(HID_REPORT_BYTES + 1);
    oversized.set(frame ?? []);
    p.notifyRaw(oversized);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toHaveLength(0);
    expect(await settle(t.request('ping'))).toHaveProperty('uptimeMs');
  });

  it('WB-15 identity', async () => {
    const { t } = setup({ name: 'TG-9F00' });
    expect(t.kind).toBe('webble');
    expect(t.productName).toBeUndefined();
    await t.open();
    expect(t.productName).toBe('TG-9F00');
  });

  it('WB-16 a new instance reopens the same device; the old one stays silent', async () => {
    const { bt, p, t } = setup();
    await t.open();
    const oldFired = vi.fn();
    t.onDisconnect(oldFired);
    await t.close();

    const t2 = new WebBleTransport({ device: bt.device.api, keepaliveMs: 0 });
    const newFired = vi.fn();
    t2.onDisconnect(newFired);
    await t2.open();
    expect(bt.device.count('gattserverdisconnected')).toBe(1);
    expect(p.tx?.count('characteristicvaluechanged')).toBe(1);
    expect(await settle(t2.request('ping'))).toHaveProperty('uptimeMs');
    p.dropLink();
    expect(newFired).toHaveBeenCalledTimes(1);
    expect(oldFired).not.toHaveBeenCalled();
  });

  it('WB-17 availability', async () => {
    expect(await isWebBleAvailable()).toBe(false);
    vi.stubGlobal('navigator', { bluetooth: { getAvailability: () => Promise.resolve(false) } });
    expect(await isWebBleAvailable()).toBe(false);
    vi.stubGlobal('navigator', { bluetooth: { getAvailability: () => Promise.resolve(true) } });
    expect(await isWebBleAvailable()).toBe(true);
    vi.stubGlobal('navigator', { bluetooth: {} });
    expect(await isWebBleAvailable()).toBe(true);
    vi.stubGlobal('navigator', {
      bluetooth: { getAvailability: () => Promise.reject(new Error('denied')) },
    });
    expect(await isWebBleAvailable()).toBe(true);
  });

  it('WB-18 a 2047-byte reply arrives as 36 notifications and resolves', async () => {
    const { p, t } = setup();
    await t.open();
    p.autoReply = false;
    const pending = t.request('ping');
    await vi.advanceTimersByTimeAsync(1);
    const id = p.requests[0]?.id ?? -1;
    const envelope = (pad: string): string =>
      JSON.stringify({ v: 1, id, ok: true, result: { pad } });
    const pad = 'y'.repeat(2047 - envelope('').length);
    expect(envelope(pad)).toHaveLength(2047);
    let notifications = 0;
    p.tx?.addEventListener('characteristicvaluechanged', () => notifications++);
    p.sendObject({ v: 1, id, ok: true, result: { pad } });
    const result = (await settle(pending)) as unknown as { pad: string };
    expect(notifications).toBe(36);
    expect(result.pad).toHaveLength(pad.length);
  });

  it('WB-19 a partial reply is never delivered; the request times out normally', async () => {
    const { p, t } = setup();
    await t.open();
    p.autoReply = false;
    const pending = t.request('ping');
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    const id = p.requests[0]?.id ?? -1;
    const frames = new FrameEncoder().encode({
      v: 1,
      id,
      ok: true,
      result: { pad: 'z'.repeat(40) },
    });
    expect(frames).toHaveLength(2);
    const first = frames[0];
    p.notifyRaw(first?.subarray(0, 5 + (first[4] ?? 0)) ?? new Uint8Array(0));
    await vi.advanceTimersByTimeAsync(600);
    const e = await errorOf(pending);
    expect(e.code).toBe('timeout');
    // The link is still healthy afterwards.
    p.autoReply = true;
    expect(await settle(t.request('ping'))).toHaveProperty('uptimeMs');
  });

  it('WB-20 segmented mode: 20-byte values with a START header, replies reassemble', async () => {
    const { p, t } = setup({ mtu: 23, segmented: true });
    await settle(t.open());
    expect(p.infoReads).toBe(1);
    const big = await settle(t.request('ping', { t: 5, pad: FIVE_FRAGMENT_PAD } as never));
    expect(big.t).toBe(5);
    expect(p.rxWrites.length).toBeGreaterThan(5);
    expect(p.rxWrites.every((w) => w.length <= 20)).toBe(true);
    expect(p.rxWrites[0]?.[0]).toBe(0x80);
    // Only the first segment of each frame carries START.
    const frameStarts = p.rxWrites.filter((w) => ((w[0] ?? 0) & 0x80) !== 0).length;
    expect(frameStarts).toBe(5);
    const hello = await settle(t.request('hello'));
    expect(hello.link).toEqual({ kind: 'ble', mtu: 23 });
  });
});

describe('WebBleTransport extras', () => {
  it('fails open when Web Bluetooth is missing', async () => {
    const t = new WebBleTransport();
    const e = await errorOf(t.open());
    expect(e.code).toBe('notOpen');
    expect(e.message).toBe('Web Bluetooth is not available');
  });

  it('reports other chooser failures as notOpen with the browser message', async () => {
    const bluetooth = {
      requestDevice: () => Promise.reject(new DOMException('Bluetooth is off', 'NotAllowedError')),
    } as unknown as Bluetooth;
    const e = await errorOf(new WebBleTransport({ bluetooth }).open());
    expect(e).toMatchObject({ code: 'notOpen', message: 'Bluetooth is off' });
  });

  it('fails open when the service is missing and releases the link', async () => {
    const { bt, p, t } = setup();
    bt.device.gatt.getPrimaryService = () =>
      Promise.reject(new DOMException('No Services matching UUID found.', 'NotFoundError'));
    const e = await errorOf(t.open());
    expect(e.code).toBe('notOpen');
    expect(p.connected).toBe(false);
    expect(bt.device.count('gattserverdisconnected')).toBe(0);
  });

  it('rejects an unreadable INFO value with protocol', async () => {
    const { p, t } = setup();
    p.nextInfo = () => new DataView(new TextEncoder().encode('not json').buffer);
    expect((await errorOf(t.open())).code).toBe('protocol');
    p.nextInfo = () => new DataView(new TextEncoder().encode('{"p":1}').buffer);
    expect((await errorOf(t.open())).code).toBe('protocol');
  });

  it('tears down on a controlReleased notify', async () => {
    const { p, t } = setup();
    await t.open();
    const reasons: (string | undefined)[] = [];
    t.onDisconnect((r) => reasons.push(r));
    p.sendObject({ v: 1, notify: true, op: 'controlReleased', data: { to: 'usbHid' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons).toEqual(['Control taken over by usbHid']);
    expect(p.connected).toBe(false);
  });

  it('keeps the lease alive with a keepalive ping', async () => {
    const { p, t } = setup({}, { keepaliveMs: 3000 });
    await t.open();
    await vi.advanceTimersByTimeAsync(3100);
    expect(p.requests.map((r) => r.op)).toEqual(['ping']);
    await t.close();
  });

  it('segmented receive ignores a continuation without START and oversize frames', async () => {
    const { p, t } = setup({ mtu: 23, segmented: true });
    await t.open();
    const got: HidNotify[] = [];
    t.onNotify((n) => got.push(n));
    p.notifyRaw(new Uint8Array([0x00, 1, 2, 3])); // no START, empty accumulator
    p.notifyRaw(new Uint8Array(0)); // empty value
    p.notifyRaw(new Uint8Array([0x80, 0, 0, 1, 1, 58])); // START of a frame that never completes
    p.notifyRaw(new Uint8Array(70)); // continuation that overflows 63 bytes
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toHaveLength(0);
    expect(await settle(t.request('ping'))).toHaveProperty('uptimeMs');
  });

  it('a notification without a stored value is ignored', async () => {
    const { p, t } = setup();
    await t.open();
    const tx = p.tx;
    if (tx === undefined) throw new Error('no tx');
    tx.value = undefined;
    tx.dispatch('characteristicvaluechanged');
    expect(await settle(t.request('ping'))).toHaveProperty('uptimeMs');
  });

  it('WB-21 a device linkBusy reply rejects with DeviceError linkBusy', async () => {
    const { p, t } = setup();
    await t.open();
    p.autoReply = false;
    const pending = t.request('getState');
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    const id = p.requests[0]?.id ?? -1;
    p.sendObject({
      v: 1,
      id,
      ok: false,
      error: { code: 'linkBusy', message: 'control held by usbHid' },
    });
    const e = await errorOf(pending);
    expect(e.code).toBe('linkBusy');
    expect(e.message).toBe('control held by usbHid');
  });

  it('WB-22 write falls back to the other method, then to legacy writeValue', async () => {
    /** Shadows a prototype method with `undefined`, as an older browser lacks it. */
    const hide = (rx: object, ...names: string[]): void => {
      for (const n of names) Object.defineProperty(rx, n, { value: undefined });
    };
    // Configured method (withResponse) missing: the other one is used.
    const b = setup();
    b.bt.device.gatt.onConnect = (rx) => {
      hide(rx, 'writeValueWithResponse');
    };
    await b.t.open();
    await settle(b.t.request('ping'));
    expect(b.p.log).toContain('writeNoResponse');
    expect(b.p.log).not.toContain('write');

    // Both missing: legacy writeValue.
    const c = setup();
    c.bt.device.gatt.onConnect = (rx) => {
      hide(rx, 'writeValueWithResponse', 'writeValueWithoutResponse');
      Object.defineProperty(rx, 'writeValue', {
        value: (v: BufferSource) => FakeCharacteristic.prototype.writeValueWithResponse.call(rx, v),
      });
    };
    await c.t.open();
    await settle(c.t.request('ping'));
    expect(c.p.log).toContain('write');

    // No write method at all: linkUnsupported.
    const d = setup();
    d.bt.device.gatt.onConnect = (rx) => {
      hide(rx, 'writeValueWithResponse', 'writeValueWithoutResponse');
    };
    expect((await errorOf(d.t.open())).code).toBe('linkUnsupported');
  });

  it('WB-23 the chooser is retried without namePrefix after a non-NotFound rejection', async () => {
    const { bt, t } = setup();
    const real = bt.requestDevice.bind(bt);
    let calls = 0;
    bt.requestDevice = (o) =>
      ++calls === 1 ? Promise.reject(new TypeError('unsupported filter')) : real(o);
    await t.open();
    expect(calls).toBe(2);
    expect(bt.requestDeviceCalls).toEqual([
      { filters: [{ services: [BLE_SERVICE_UUID] }], optionalServices: [BLE_SERVICE_UUID] },
    ]);
  });

  it('WB-23 a second chooser failure propagates; a dismissed chooser is not retried', async () => {
    const { bt, t } = setup();
    bt.requestDevice = () => Promise.reject(new TypeError('still bad'));
    expect(await errorOf(t.open())).toMatchObject({ code: 'notOpen', message: 'still bad' });
    const x = setup();
    x.bt.chooserCancelled = true;
    await errorOf(x.t.open());
    expect(x.bt.requestDeviceCalls).toHaveLength(1);
  });
});
