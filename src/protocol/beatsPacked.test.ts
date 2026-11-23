/**
 * Tests for the packed beat decoder (BLE_TRANSPORT_PLAN.md §14.2; BLE_TRANSPORT_TESTS.md BP-*).
 * The encoder under test is the simulator's; the hand-built vector is independent of it.
 */
import { describe, expect, it } from 'vitest';
import { packBeats } from '@/sim/beatsPackedEncoder';
import {
  BeatsPackedError,
  DEFAULT_SOURCE_HZ,
  PACKED_BEAT_BYTES,
  PACKED_HEADER_BYTES,
  beatsOfResult,
  decodeBeatsPacked,
} from './beatsPacked';
import type { DspBeat } from './types';

/** Builds a beat with values that survive the format's quantisation exactly. */
function beat(i: number, over: Partial<DspBeat> = {}): DspBeat {
  const sample = 1_000_000 + i * 24000;
  return {
    seq: 100 + i,
    gridId: 7,
    sampleIndex: String(sample),
    tS: (sample + 64 / 256) / 48000,
    k: i,
    parity: (i & 1) as 0 | 1,
    uUs: (i - 4) * 12.5,
    nominalUs: 125000,
    amplitudeDeg: 270 + i,
    amplitudeValid: true,
    liftMs: 2.5 + i / 1000,
    status: i === 0 ? 'started' : 'accepted',
    ...over,
  };
}

/** Raw bytes of base64 text. */
function bytesOf(text: string): number[] {
  return Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Base64 of raw bytes. */
function b64(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('decodeBeatsPacked', () => {
  it('PK-01 round-trips a batch through the test encoder', () => {
    const beats = Array.from({ length: 8 }, (_, i) => beat(i));
    const { p, count } = packBeats(beats, 48000);
    expect(count).toBe(8);
    const out = decodeBeatsPacked(p, 48000);
    expect(out).toHaveLength(8);
    out.forEach((b, i) => {
      const e = beats[i] as DspBeat;
      expect(b.seq).toBe(e.seq);
      expect(b.gridId).toBe(e.gridId);
      expect(b.sampleIndex).toBe(e.sampleIndex);
      expect(b.tS).toBeCloseTo(e.tS, 12);
      expect(b.k).toBe(e.k);
      expect(b.parity).toBe(e.parity);
      expect(b.uUs).toBeCloseTo(e.uUs, 9);
      expect(b.nominalUs).toBe(e.nominalUs);
      expect(b.amplitudeDeg).toBeCloseTo(e.amplitudeDeg, 9);
      expect(b.amplitudeValid).toBe(true);
      expect(b.liftMs).toBeCloseTo(e.liftMs, 9);
      expect(b.status).toBe(e.status);
    });
  });

  it('PK-02 8 beats are 162 bytes and 216 base64 characters', () => {
    const { p } = packBeats(
      Array.from({ length: 8 }, (_, i) => beat(i)),
      48000,
    );
    expect(PACKED_HEADER_BYTES + 8 * PACKED_BEAT_BYTES).toBe(162);
    expect(p).toHaveLength(216);
  });

  it('PK-03 decodes a hand-built vector', () => {
    // Header: fmt 1, n 2, seq0 1000, grid 3, nominal 125000 us, sample0 2^32 + 5, k0 -2.
    const header = [
      1, 2, 0xe8, 0x03, 0, 0, 3, 0, 0, 0, 0x00, 0x24, 0xf4, 0x47, 5, 0, 0, 0, 1, 0, 0, 0, 0xfe,
      0xff, 0xff, 0xff,
    ];
    // Beat 0: dSeq 0, parity 0, valid, started; dSample 0; frac 128; dK 0; u -15 (-1.5 us);
    //         amp 27050 (270.5 deg); lift 2400 us.
    const b0 = [0, 0b0110, 0, 0, 0, 0, 128, 0, 0, 0xf1, 0xff, 0xff, 0xff, 0xaa, 0x69, 0x60, 0x09];
    // Beat 1: dSeq 2, parity 1, amplitude invalid, rejected; dSample 24000; frac 0; dK 2;
    //         u 1234 (123.4 us); amp 0; lift 65535 (saturated).
    const b1 = [2, 0b1001, 0xc0, 0x5d, 0, 0, 0, 2, 0, 0xd2, 0x04, 0, 0, 0, 0, 0xff, 0xff];
    const out = decodeBeatsPacked(b64([...header, ...b0, ...b1]), 48000);
    expect(out).toEqual([
      {
        seq: 1000,
        gridId: 3,
        sampleIndex: String(2 ** 32 + 5),
        tS: (2 ** 32 + 5 + 0.5) / 48000,
        k: -2,
        parity: 0,
        uUs: -1.5,
        nominalUs: 125000,
        amplitudeDeg: 270.5,
        amplitudeValid: true,
        liftMs: 2.4,
        status: 'started',
      },
      {
        seq: 1002,
        gridId: 3,
        sampleIndex: String(2 ** 32 + 5 + 24000),
        tS: (2 ** 32 + 5 + 24000) / 48000,
        k: 0,
        parity: 1,
        uUs: 123.4,
        nominalUs: 125000,
        amplitudeDeg: 0,
        amplitudeValid: false,
        liftMs: 65.535,
        status: 'rejected',
      },
    ]);
  });

  it('PK-04 uses the given source rate and defaults to 48 kHz', () => {
    const { p } = packBeats([beat(0)], 48000);
    const at48 = decodeBeatsPacked(p)[0] as DspBeat;
    const at44 = decodeBeatsPacked(p, 44100)[0] as DspBeat;
    expect(DEFAULT_SOURCE_HZ).toBe(48000);
    expect(at48.tS).toBeCloseTo((1_000_000 + 0.25) / 48000, 12);
    expect(at44.tS).toBeCloseTo((1_000_000 + 0.25) / 44100, 12);
  });

  it('PK-05 rejects an unknown format with a clear error', () => {
    const bytes = bytesOf(packBeats([beat(0)], 48000).p);
    bytes[0] = 2;
    expect(() => decodeBeatsPacked(b64(bytes))).toThrow(BeatsPackedError);
    expect(() => decodeBeatsPacked(b64(bytes))).toThrow(/unsupported format 2/);
  });

  it('PK-06 rejects bad counts, lengths, status codes and base64', () => {
    const good = bytesOf(packBeats([beat(0), beat(1)], 48000).p);
    expect(() => decodeBeatsPacked(b64(good.slice(0, 40)))).toThrow(/expected 60/);
    expect(() => decodeBeatsPacked(b64([1, 0, ...good.slice(2)]))).toThrow(/beat count 0/);
    expect(() => decodeBeatsPacked(b64([1, 33, ...good.slice(2)]))).toThrow(/beat count 33/);
    const reserved = [...good];
    reserved[PACKED_HEADER_BYTES + 1] = 0b1100;
    expect(() => decodeBeatsPacked(b64(reserved))).toThrow(/reserved status/);
    expect(() => decodeBeatsPacked('!!!!')).toThrow(/invalid base64/);
    expect(() => decodeBeatsPacked('AAA')).toThrow(/invalid base64/);
    expect(() => decodeBeatsPacked('')).toThrow(BeatsPackedError);
  });
});

describe('packBeats', () => {
  it('ends a block at a grid change, a nominal change and an oversized delta', () => {
    const a = [beat(0), beat(1), beat(2, { gridId: 8 })];
    expect(packBeats(a, 48000).count).toBe(2);
    const b = [beat(0), beat(1, { nominalUs: 100000 })];
    expect(packBeats(b, 48000).count).toBe(1);
    const c = [beat(0), beat(1, { seq: 100 + 256 })];
    expect(packBeats(c, 48000).count).toBe(1);
    const d = [beat(0), beat(1, { k: 40000 })];
    expect(packBeats(d, 48000).count).toBe(1);
    const e = [beat(0), beat(1, { sampleIndex: String(1_000_000 + 2 ** 32) })];
    expect(packBeats(e, 48000).count).toBe(1);
  });

  it('caps a block at maxBeats and rejects bad arguments', () => {
    const many = Array.from({ length: 40 }, (_, i) => beat(i));
    expect(packBeats(many, 48000).count).toBe(32);
    expect(packBeats(many, 48000, 8).count).toBe(8);
    expect(() => packBeats([], 48000)).toThrow(RangeError);
    expect(() => packBeats(many, 48000, 33)).toThrow(RangeError);
  });

  it('saturates amplitude and lift and zeroes an invalid amplitude', () => {
    const out = decodeBeatsPacked(
      packBeats(
        [beat(0, { amplitudeDeg: 9999, liftMs: 99 }), beat(1, { amplitudeValid: false })],
        48000,
      ).p,
    );
    expect(out[0]?.amplitudeDeg).toBe(655.35);
    expect(out[0]?.liftMs).toBe(65.535);
    expect(out[1]?.amplitudeDeg).toBe(0);
    expect(out[1]?.amplitudeValid).toBe(false);
  });
});

describe('beatsOfResult', () => {
  it('PK-07 passes an unpacked result through and decodes a packed one', () => {
    const beats = [beat(0), beat(1)];
    expect(beatsOfResult({ beats })).toBe(beats);
    expect(beatsOfResult({ p: packBeats(beats, 48000).p }, 48000)).toHaveLength(2);
    expect(beatsOfResult({ p: '' })).toEqual([]);
  });
});
