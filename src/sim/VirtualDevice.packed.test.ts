/**
 * Tests for the VirtualDevice parts added for BLE throughput (BLE_TRANSPORT_PLAN.md
 * §14, W6): packed beats, `hello.frameMax` and the connection-parameter fields.
 */
import { describe, expect, it } from 'vitest';
import { decodeBeatsPacked } from '@/protocol/beatsPacked';
import type { DspBeat, HidNotify } from '@/protocol/types';
import { ManualClock } from './clock';
import { VirtualDevice, type VirtualDeviceOptions } from './VirtualDevice';

/** A started device with a manual clock. */
interface Rig {
  readonly d: VirtualDevice;
  /** Runs `seconds` of signal time in 250 ms steps and returns every notify polled on the way. */
  run(seconds: number): HidNotify[];
}

/** Builds a started mechanical device. */
function rig(opts: VirtualDeviceOptions = {}): Rig {
  const clock = new ManualClock(1000);
  const d = new VirtualDevice({ clock: clock.now, seed: 5, signalScaleMax: 50, ...opts });
  d.handle('start', {});
  return {
    d,
    run(seconds) {
      const out: HidNotify[] = [];
      for (let i = 0; i < seconds * 4; i++) {
        clock.advance(250);
        d.advance();
        for (let n = d.pollNotify(); n !== null; n = d.pollNotify()) out.push(n);
      }
      return out;
    },
  };
}

describe('packed beats', () => {
  it('PK-20 advertises caps.beatsPacked = 1 and echoes the flag; an old device does neither', () => {
    const { d } = rig();
    expect(d.handle('hello', {}).caps.beatsPacked).toBe(1);
    expect(d.handle('subscribe', { beatsPacked: true })).toMatchObject({ beatsPacked: true });
    const old = rig({ beatsPacked: false }).d;
    expect(old.handle('hello', {}).caps.beatsPacked).toBeUndefined();
    const echo = old.handle('subscribe', { beatsPacked: true, beats: true });
    expect(echo).not.toHaveProperty('beatsPacked');
    expect(echo.beats).toBe(true);
  });

  it('PK-21 beatsPacked sends packed notifies and no beats, even when beats is set too', () => {
    const r = rig();
    r.d.handle('subscribe', { beats: true, beatsPacked: true });
    const got = r.run(20);
    expect(got.filter((n) => n.op === 'beats')).toHaveLength(0);
    const packed = got.flatMap((n) => (n.op === 'beatsPacked' ? [n.data.p] : []));
    expect(packed.length).toBeGreaterThan(2);
    const beats = packed.flatMap((p) => decodeBeatsPacked(p, 48000));
    expect(beats.length).toBeGreaterThan(20);
    for (let i = 1; i < beats.length; i++) {
      expect((beats[i] as DspBeat).seq).toBe((beats[i - 1] as DspBeat).seq + 1);
    }
  });

  it('PK-22 the packed stream carries the same beats as the JSON stream', () => {
    const a = rig();
    a.d.handle('subscribe', { beats: true });
    const json = a.run(15).flatMap((n) => (n.op === 'beats' ? n.data.beats : []));
    const b = rig();
    b.d.handle('subscribe', { beatsPacked: true });
    const packed = b
      .run(15)
      .flatMap((n) => (n.op === 'beatsPacked' ? decodeBeatsPacked(n.data.p, 48000) : []));
    expect(packed.length).toBe(json.length);
    packed.forEach((p, i) => {
      const j = json[i] as DspBeat;
      expect(p.seq).toBe(j.seq);
      expect(p.sampleIndex).toBe(j.sampleIndex);
      expect(p.k).toBe(j.k);
      expect(p.status).toBe(j.status);
      expect(p.tS).toBeCloseTo(j.tS, 4);
      expect(p.uUs).toBeCloseTo(j.uUs, 1);
    });
  });

  it('PK-23 getBeats {packed: true} returns {p} with the newest beat last', () => {
    const r = rig();
    r.run(15);
    const plain = r.d.handle('getBeats', { max: 8 });
    const packed = r.d.handle('getBeats', { max: 8, packed: true });
    expect(packed).toHaveProperty('p');
    const beats = decodeBeatsPacked((packed as { p: string }).p, 48000);
    const newest = (plain as { beats: DspBeat[] }).beats;
    expect(beats.at(-1)?.seq).toBe(newest[0]?.seq);
    expect(beats.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < beats.length; i++) {
      expect((beats[i] as DspBeat).seq).toBeGreaterThan((beats[i - 1] as DspBeat).seq);
    }
  });

  it('PK-24 getBeats packed on an empty ring gives an empty text; an old device ignores the flag', () => {
    const empty = rig().d.handle('getBeats', { packed: true });
    expect(empty).toEqual({ p: '' });
    const r = rig({ beatsPacked: false });
    r.run(15);
    expect(r.d.handle('getBeats', { max: 2, packed: true })).toHaveProperty('beats');
  });
});

describe('hello.frameMax and getLink on BLE (W6)', () => {
  it('LF-W20 reports link.frameMax and applies min(frameMax, 255, mtu - 3), never below 63', () => {
    const d = rig({ linkKind: 'ble', linkMtu: 247 }).d;
    expect(d.handle('hello', {}).link).toEqual({ kind: 'ble', mtu: 247, frameMax: 63 });
    expect(d.handle('hello', { frameMax: 255 }).link?.frameMax).toBe(244);
    expect(d.handle('hello', {}).link?.frameMax).toBe(244);
    expect(d.txFrameBytes).toBe(244);
    expect(d.handle('hello', { frameMax: 100 }).link?.frameMax).toBe(100);
    expect(d.handle('hello', { frameMax: 10 }).link?.frameMax).toBe(63);
    expect(d.handle('hello', { frameMax: 1000 }).link?.frameMax).toBe(244);
    d.resetTxFrame();
    expect(d.txFrameBytes).toBe(63);
  });

  it('LF-W21 a wide MTU allows 255', () => {
    const d = rig({ linkKind: 'ble', linkMtu: 517 }).d;
    expect(d.handle('hello', { frameMax: 255 }).link?.frameMax).toBe(255);
  });

  it('LF-W22 an old BLE device and a USB device ignore frameMax and report none', () => {
    const old = rig({ linkKind: 'ble', largeFrames: false }).d;
    expect(old.handle('hello', { frameMax: 255 }).link).toEqual({ kind: 'ble', mtu: 185 });
    expect(old.acceptsFrameMax).toBe(false);
    const usb = rig().d;
    expect(usb.handle('hello', { frameMax: 255 }).link).toEqual({ kind: 'usbHid' });
    expect(usb.txFrameBytes).toBe(63);
  });

  it('LF-W23 getLink.ble reports the connection-parameter progress', () => {
    const ble = rig({ linkKind: 'ble' }).d.handle('getLink', {}).ble;
    expect(ble).toMatchObject({ connParamStep: 1, connParamRejects: 0, connIntervalUs: 15000 });
    const usb = rig({ ble: true }).d.handle('getLink', {}).ble;
    expect(usb).toMatchObject({ connParamStep: 0, connParamRejects: 0, connIntervalUs: 0 });
  });
});
