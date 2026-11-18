/** Unit tests for transport semantics: latency, queueing, timeouts, disconnect, notifies. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceError } from '@/transport/Transport';
import { ManualClock } from './clock';
import { VirtualDevice } from './VirtualDevice';
import { VirtualTransport } from './VirtualTransport';
import { getSimulatorControl } from './scenarios';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function make(opts: ConstructorParameters<typeof VirtualTransport>[0] = {}): {
  t: VirtualTransport;
  clock: ManualClock;
} {
  const clock = new ManualClock(1000);
  const device = new VirtualDevice({ clock: clock.now, seed: 5 });
  const t = new VirtualTransport({ device, ignorePersisted: true, latencyMs: 10, ...opts });
  return { t, clock };
}

describe('VirtualTransport', () => {
  it('rejects requests before open', async () => {
    const { t } = make();
    await expect(t.request('hello')).rejects.toMatchObject({ code: 'notOpen' });
  });

  it('replies after the configured latency, one at a time and in order', async () => {
    const { t } = make();
    await t.open();
    const order: string[] = [];
    const p1 = t.request('ping', { t: 1 }).then((r) => order.push(`ping${String(r.t)}`));
    const p2 = t.request('getDevice').then(() => order.push('dev'));
    await vi.advanceTimersByTimeAsync(9);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(order).toEqual(['ping1']);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['ping1', 'dev']);
  });

  it('turns device errors into DeviceError', async () => {
    const { t } = make();
    await t.open();
    const p = t.request('setDevice', { mode: 'x' as 'usbMic' });
    const assertion = expect(p).rejects.toBeInstanceOf(DeviceError);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('times out when the latency exceeds the timeout', async () => {
    const { t } = make({ latencyMs: 500 });
    await t.open();
    const p = t.request('hello', {}, 100);
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it('close fails outstanding requests with disconnected, without firing onDisconnect', async () => {
    const { t } = make();
    await t.open();
    const cb = vi.fn();
    t.onDisconnect(cb);
    const p = t.request('hello');
    const assertion = expect(p).rejects.toMatchObject({ code: 'disconnected' });
    await t.close();
    await assertion;
    expect(cb).not.toHaveBeenCalled();
    await t.close();
  });

  it('a scenario disconnect fires onDisconnect once and releases the control', async () => {
    const { t } = make();
    await t.open();
    const cb = vi.fn();
    t.onDisconnect(cb);
    expect(getSimulatorControl()).toBe(t.control);
    const p = t.request('hello');
    const assertion = expect(p).rejects.toMatchObject({ code: 'disconnected' });
    t.control.disconnect('cable pulled');
    await assertion;
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('cable pulled');
    expect(getSimulatorControl()).toBeUndefined();
  });

  it('fails the next N requests as injected', async () => {
    const { t } = make();
    await t.open();
    t.control.failNextRequests(2, { code: 'busy', message: 'nope' });
    for (let i = 0; i < 2; i++) {
      const p = t.request('getDevice');
      const a = expect(p).rejects.toMatchObject({ code: 'busy', message: 'nope' });
      await vi.advanceTimersByTimeAsync(11);
      await a;
    }
    const ok = t.request('getDevice');
    await vi.advanceTimersByTimeAsync(11);
    await expect(ok).resolves.toMatchObject({ mode: 'usbMic' });
  });

  it('delivers notifies only while subscribed and stops polling afterwards', async () => {
    const { t, clock } = make({ pollMs: 10 });
    await t.open();
    const got: string[] = [];
    t.onNotify((n) => got.push(n.op));
    const p = t.request('subscribe', { metricsHz: 20 });
    await vi.advanceTimersByTimeAsync(11);
    await p;
    for (let i = 0; i < 100; i++) {
      clock.advance(10);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(got.length).toBeGreaterThan(15);
    expect(new Set(got)).toEqual(new Set(['metrics']));
    const off = t.request('subscribe', { metricsHz: 0 });
    await vi.advanceTimersByTimeAsync(11);
    await off;
    got.length = 0;
    clock.advance(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toEqual([]);
  });
});

describe('SimulatorControl', () => {
  it('applies presets and reports the model truth', async () => {
    const { t } = make();
    await t.open();
    const c = t.control;
    c.applyPreset('worn');
    expect(c.getMechanical()).toMatchObject({ beatErrorMs: 3, amplitudeDeg: 195 });
    c.applyPreset('quartzMotor');
    expect(c.getAttached()).toBe('motor');
    expect(c.getSnapshot().quartzMode).toBe('motor');
    c.applyPreset('noGps');
    expect(c.getGps().antenna).toBe(false);
    c.applyPreset('gpsColdStart');
    expect(c.getGps()).toMatchObject({ antenna: true, fixAfterS: 120 });
    const seen = vi.fn();
    const off = c.subscribe(seen);
    c.setTimeScale(100);
    expect(seen).toHaveBeenCalledOnce();
    off();
    expect(c.getTimeScale()).toBe(100);
  });

  it('remembers physical settings across connections', async () => {
    const { t } = make();
    await t.open();
    t.control.setMechanical({ rateSDay: -9 });
    await t.close();
    const t2 = new VirtualTransport({});
    expect(t2.control.getMechanical().rateSDay).toBe(-9);
    await t2.close();
  });
});
