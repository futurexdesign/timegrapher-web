/** Firmware-parity tests for VirtualDevice: busy rules, aliases, paging, notify policy. */
import { describe, expect, it } from 'vitest';
import { DeviceError } from '@/transport/Transport';
import { ManualClock } from './clock';
import { VirtualDevice } from './VirtualDevice';
import { HID_JSON_MAX, REPLY_ENVELOPE_BYTES } from './wire';

function dev(opts: ConstructorParameters<typeof VirtualDevice>[0] = {}): VirtualDevice {
  const clock = new ManualClock(1000);
  return new VirtualDevice({ clock: clock.now, seed: 3, ...opts });
}

function err(fn: () => unknown): DeviceError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DeviceError) return e;
  }
  throw new Error('expected DeviceError');
}

describe('setTimebase busy rules', () => {
  it('ppm-only succeeds while streaming', () => {
    const d = dev({ usbStreaming: true });
    expect(d.handle('setTimebase', { ppm: 3.5 }).calPpm).toBe(3.5);
  });

  it('a changed logDeltaPpm is refused while streaming, and nothing is applied', () => {
    const d = dev({ usbStreaming: true });
    const e = err(() => d.handle('setTimebase', { ppm: 4, logDeltaPpm: 1 }));
    expect(e.code).toBe('busy');
    expect(e.message).toBe('close the audio stream before saving');
    expect(d.handle('getTimebase', {}).calPpm).toBe(0);
  });

  it('an unchanged logDeltaPpm is not busy', () => {
    const d = dev({ usbStreaming: true });
    const cur = d.handle('getTimebase', {}).logDeltaPpm;
    expect(d.handle('setTimebase', { ppm: 2, logDeltaPpm: cur }).calPpm).toBe(2);
  });

  it('validates before reporting busy', () => {
    const d = dev({ usbStreaming: true });
    expect(err(() => d.handle('setTimebase', { logDeltaPpm: 99 })).code).toBe('badParam');
  });

  it('accepts source none / case-insensitive names; ppm 0 manual stores none', () => {
    const d = dev();
    expect(d.handle('setTimebase', { ppm: 5, source: 'NONE' as 'manual' }).calSource).toBe('none');
    expect(d.handle('setTimebase', { ppm: 5, source: 'NTP' as 'ntp' }).calSource).toBe('ntp');
    expect(d.handle('setTimebase', { ppm: 0, source: 'manual' }).calSource).toBe('none');
    expect(err(() => d.handle('setTimebase', { ppm: 1, source: 'pps' as 'ntp' })).code).toBe(
      'badParam',
    );
  });
});

describe('setDevice', () => {
  it('the current mode is OK even while streaming', () => {
    const d = dev({ usbStreaming: true });
    const cur = d.status().mode;
    expect(d.handle('setDevice', { mode: cur }).mode).toBe(cur);
  });

  it('a different mode while streaming is busy', () => {
    const d = dev({ usbStreaming: true });
    const other = d.status().mode === 'usbMic' ? 'standalone' : 'usbMic';
    expect(err(() => d.handle('setDevice', { mode: other })).code).toBe('busy');
  });

  it.each([
    ['sa', 'standalone'],
    ['STANDALONE', 'standalone'],
    ['usb', 'usbMic'],
    ['USB_MIC', 'usbMic'],
    ['usbmic', 'usbMic'],
  ])('alias %s selects %s', (alias, mode) => {
    const d = dev();
    expect(d.handle('setDevice', { mode: alias as 'usbMic' }).mode).toBe(mode);
  });
});

describe('ping and source text', () => {
  it('echoes an int64 t exactly and treats out-of-range as missing', () => {
    const d = dev();
    expect(d.handle('ping', { t: 1_700_000_000_123 }).t).toBe(1_700_000_000_123);
    expect(d.handle('ping', { t: 1e19 }).t).toBe(0);
    expect(d.handle('ping', {}).t).toBe(0);
  });

  it('bad source message', () => {
    const d = dev();
    expect(err(() => d.handle('setTimebase', { ppm: 1, source: 'gps' as 'ntp' })).message).toBe(
      'source must be none, manual or ntp',
    );
  });
});

describe('getEvents fitting', () => {
  it('returns a newest-first prefix within 2048 bytes, never tooLarge', () => {
    const clock = new ManualClock(1000);
    const d = new VirtualDevice({ clock: clock.now, seed: 3 });
    d.handle('start', {});
    clock.advance(20_000);
    const r = d.handle('getEvents', { limit: 32 });
    const six = (_k: string, v: unknown): unknown =>
      typeof v === 'number' ? Number(v.toPrecision(6)) : v;
    expect(JSON.stringify(r, six).length + REPLY_ENVELOPE_BYTES).toBeLessThanOrEqual(HID_JSON_MAX);
    expect(r.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('messages', () => {
  it('clearTimebaseLog busy text and unknownOp text', () => {
    const d = dev({ usbStreaming: true });
    expect(err(() => d.handle('clearTimebaseLog', {})).message).toBe(
      'close the audio stream before saving',
    );
    const e = err(() => d.handle('nope' as 'ping', {}));
    expect(e.code).toBe('unknownOp');
    expect(e.message).toBe('nope');
  });
});

describe('getTimebaseLog paging', () => {
  it('pages by encoded size within 2048 bytes and covers every entry once', () => {
    const d = dev();
    for (let i = 0; i < 24; i++) {
      d.log.append({
        dateUnix: 1_700_000_000 + i,
        ppm: 1.2345 + i,
        source: 'manual',
        durationS: 3600,
        reason: 'save',
      });
    }
    const seen: number[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = d.handle('getTimebaseLog', { offset });
      const size = JSON.stringify(page).length + REPLY_ENVELOPE_BYTES;
      expect(size).toBeLessThanOrEqual(HID_JSON_MAX);
      expect(page.entries.length).toBeGreaterThan(0);
      for (const e of page.entries) seen.push(e.dateUnix);
      offset += page.entries.length;
      pages++;
      if (offset >= page.total) break;
    }
    expect(seen).toHaveLength(24);
    expect(pages).toBe(2);
    expect(d.handle('getTimebaseLog', { offset: 0 })).toEqual(
      d.handle('getTimebaseLog', { offset: 0 }),
    );
  });
});

describe('notify policy', () => {
  it('error notify carries only the latest fault', () => {
    const d = dev();
    d.handle('subscribe', { errors: true });
    d.injectError('gain', 'overload');
    d.injectError('limiter', 'underrun');
    const n = d.pollNotify();
    expect(n).toMatchObject({ op: 'error', data: { block: 'limiter', reason: 'underrun' } });
    expect(d.pollNotify()).toBeNull();
  });
});

describe('BLE build option', () => {
  it('a default device has no caps.ble and no getLink.ble', () => {
    const d = dev();
    expect('ble' in d.handle('hello', {}).caps).toBe(false);
    expect(d.handle('getLink', {}).ble).toBeUndefined();
  });

  it('a device reached over BLE has caps.ble and a connected getLink.ble at linkMtu', () => {
    const d = dev({ linkKind: 'ble', linkMtu: 247 });
    expect(d.handle('hello', {}).caps.ble).toBe(true);
    expect(d.handle('getLink', {}).ble).toMatchObject({
      enabled: true,
      connected: true,
      mtu: 247,
      connIntervalUs: 30000,
      core: 0,
    });
  });

  it('a BLE build reached over USB reports the radio as off', () => {
    const d = dev({ ble: true });
    expect(d.handle('getLink', {}).ble).toMatchObject({ enabled: false, connected: false });
  });

  it('the board option sets the hello board name', () => {
    expect(dev({ board: 'Pico2W' }).handle('hello', {}).board).toBe('Pico2W (virtual)');
    expect(dev().handle('hello', {}).board).toBe('Pico2 (virtual)');
    expect(dev({ ble: true }).handle('hello', {}).board).toBe('Pico2W (virtual)');
  });

  it('a BLE link without a BLE build throws RangeError', () => {
    expect(() => dev({ linkKind: 'ble', ble: false })).toThrow(RangeError);
  });
});
