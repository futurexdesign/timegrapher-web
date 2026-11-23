import { describe, expect, it } from 'vitest';
import {
  HID_FRAME_MAX_CHUNK,
  HID_MAX_FRAGMENTS,
  HID_MAX_JSON_BYTES,
  HID_MAX_REQUEST_BYTES,
  HID_REPORT_BYTES,
  FRAME_MAX_PAYLOAD,
} from './constants';
import { FrameEncoder, FrameReassembler, FrameTooLargeError } from './framer';

function roundTrip(obj: unknown): unknown {
  const enc = new FrameEncoder();
  const rx = new FrameReassembler();
  let out: unknown = undefined;
  for (const r of enc.encode(obj, HID_MAX_JSON_BYTES)) {
    const res = rx.push(r);
    if (res.kind === 'message') out = res.message;
  }
  return out;
}

describe('constants', () => {
  it('match the spec', () => {
    expect(HID_FRAME_MAX_CHUNK).toBe(58);
    expect(HID_MAX_JSON_BYTES).toBe(2048);
    expect(HID_REPORT_BYTES).toBe(63);
    expect(HID_MAX_FRAGMENTS).toBe(36);
  });
});

describe('FrameEncoder', () => {
  it('encodes a small message into one padded report', () => {
    const [r, ...rest] = new FrameEncoder().encode({ v: 1, id: 1, op: 'ping' });
    expect(rest).toHaveLength(0);
    expect(r?.length).toBe(63);
    expect(Array.from(r?.subarray(0, 4) ?? [])).toEqual([0, 0, 0, 1]);
  });

  it('sets the more flag on all but the last fragment and increments seq', () => {
    const enc = new FrameEncoder();
    const big = { s: 'x'.repeat(150) };
    const a = enc.encode(big);
    const b = enc.encode(big);
    expect(a.length).toBeGreaterThan(2);
    a.forEach((r, i) => {
      expect(r[0]).toBe(i + 1 < a.length ? 1 : 0);
      expect(r[2]).toBe(i);
      expect(r[3]).toBe(a.length);
      expect(r[1]).toBe(0);
    });
    expect(b[0]?.[1]).toBe(1);
  });

  it('wraps msgSeq at 256', () => {
    const enc = new FrameEncoder();
    for (let i = 0; i < 256; i++) enc.encode({});
    expect(enc.encode({})[0]?.[1]).toBe(0);
  });

  it('caps requests at 2030 bytes (35 fragments) but replies keep 2048 / 36', () => {
    expect(HID_MAX_REQUEST_BYTES).toBe(2030);
    const pad = (n: number): { s: string } => ({
      s: 'x'.repeat(n - JSON.stringify({ s: '' }).length),
    });
    const ok = new FrameEncoder().encode(pad(HID_MAX_REQUEST_BYTES));
    expect(ok).toHaveLength(35);
    expect(() => new FrameEncoder().encode(pad(HID_MAX_REQUEST_BYTES + 1))).toThrow(
      FrameTooLargeError,
    );
    expect(new FrameEncoder().encode(pad(HID_MAX_JSON_BYTES), HID_MAX_JSON_BYTES)).toHaveLength(
      HID_MAX_FRAGMENTS,
    );
  });

  it('rejects oversized JSON', () => {
    expect(() => new FrameEncoder().encode({ s: 'x'.repeat(HID_MAX_JSON_BYTES) })).toThrow(
      FrameTooLargeError,
    );
  });
});

describe('FrameReassembler', () => {
  it('round-trips single and multi-fragment messages, including UTF-8', () => {
    expect(roundTrip({ a: 1 })).toEqual({ a: 1 });
    const big = { text: 'µs ✓ '.repeat(200) };
    expect(roundTrip(big)).toEqual(big);
    const max = { s: 'y'.repeat(HID_MAX_JSON_BYTES - 8) };
    expect(roundTrip(max)).toEqual(max);
  });

  it('accepts fragments out of order', () => {
    const reports = new FrameEncoder().encode({ s: 'z'.repeat(200) });
    const rx = new FrameReassembler();
    const results = [...reports].reverse().map((r) => rx.push(r));
    expect(results.at(-1)).toEqual({ kind: 'message', message: { s: 'z'.repeat(200) } });
    expect(results[0]?.kind).toBe('pending');
  });

  it('accepts a DataView', () => {
    const [r] = new FrameEncoder().encode({ ok: true });
    const res = new FrameReassembler().push(new DataView(r!.buffer));
    expect(res).toEqual({ kind: 'message', message: { ok: true } });
  });

  it('ignores duplicate fragments', () => {
    const reports = new FrameEncoder().encode({ s: 'q'.repeat(100) });
    const rx = new FrameReassembler();
    rx.push(reports[0]!);
    expect(rx.push(reports[0]!)).toEqual({ kind: 'dropped', reason: 'duplicate' });
    expect(rx.push(reports[1]!).kind).toBe('message');
  });

  it('abandons an incomplete message when a new msgSeq arrives', () => {
    const enc = new FrameEncoder();
    const first = enc.encode({ s: 'a'.repeat(200) });
    const second = enc.encode({ n: 2 });
    const rx = new FrameReassembler();
    rx.push(first[0]!);
    expect(rx.push(second[0]!)).toEqual({ kind: 'message', message: { n: 2 } });
    // Late tail of the abandoned message starts a fresh, never-completing one.
    expect(rx.push(first[1]!).kind).toBe('pending');
  });

  it('expires incomplete messages after 500 ms', () => {
    let t = 0;
    const rx = new FrameReassembler(() => t);
    const reports = new FrameEncoder().encode({ s: 'a'.repeat(200) });
    rx.push(reports[0]!);
    t = 501;
    for (const r of reports.slice(1)) expect(rx.push(r).kind).toBe('pending');
  });

  it('drops garbage', () => {
    const rx = new FrameReassembler();
    expect(rx.push(new Uint8Array(3))).toEqual({ kind: 'dropped', reason: 'short' });
    const h = (b: number[]): Uint8Array =>
      Uint8Array.from([...b, ...new Array<number>(58).fill(0)]);
    expect(rx.push(h([0, 0, 0, 0, 0]))).toEqual({ kind: 'dropped', reason: 'badHeader' });
    expect(rx.push(h([0, 0, 0, 200, 0]))).toEqual({ kind: 'dropped', reason: 'badHeader' });
    expect(rx.push(h([0, 0, 0, 1, 59]))).toEqual({ kind: 'dropped', reason: 'badHeader' });
    expect(rx.push(h([0, 0, 2, 2, 0]))).toEqual({ kind: 'dropped', reason: 'badIndex' });
    const junk = Uint8Array.from([0, 0, 0, 1, 3, 0x7b, 0x7b, 0x7b]);
    expect(rx.push(junk)).toEqual({ kind: 'dropped', reason: 'badJson' });
  });

  it('reset discards partial state', () => {
    const reports = new FrameEncoder().encode({ s: 'a'.repeat(200) });
    const rx = new FrameReassembler();
    rx.push(reports[0]!);
    rx.reset();
    for (const r of reports.slice(1)) expect(rx.push(r).kind).toBe('pending');
  });
});

describe('large frames (W6, BLE_TRANSPORT_PLAN.md §14.3)', () => {
  it('LF-W1 the reassembler accepts a payloadLen of 250 and rejects 251', () => {
    expect(FRAME_MAX_PAYLOAD).toBe(250);
    const text = JSON.stringify({ v: 1, s: 'a'.repeat(236) });
    expect(text.length).toBe(250);
    const frame = new Uint8Array(255);
    frame.set([0, 0, 0, 1, 250]);
    frame.set(new TextEncoder().encode(text), 5);
    const res = new FrameReassembler().push(frame);
    expect(res.kind).toBe('message');
    const bad = new Uint8Array(256);
    bad.set([0, 0, 0, 1, 251]);
    expect(new FrameReassembler().push(bad)).toEqual({ kind: 'dropped', reason: 'badHeader' });
  });

  it('LF-W2 a payloadLen beyond the buffer is still dropped', () => {
    const frame = new Uint8Array(63);
    frame.set([0, 0, 0, 1, 100]);
    expect(new FrameReassembler().push(frame)).toEqual({ kind: 'dropped', reason: 'badHeader' });
  });

  it('LF-W3 the encoder splits at the requested chunk size and round-trips', () => {
    const obj = { v: 1, s: 'b'.repeat(700) };
    const enc = new FrameEncoder();
    const frames = enc.encode(obj, HID_MAX_JSON_BYTES, 250);
    expect(frames).toHaveLength(Math.ceil(JSON.stringify(obj).length / 250));
    expect(frames[0]?.length).toBe(255);
    const rx = new FrameReassembler();
    let out: unknown;
    for (const f of frames) {
      const r = rx.push(f);
      if (r.kind === 'message') out = r.message;
    }
    expect(out).toEqual(obj);
    expect(() => enc.encode(obj, HID_MAX_JSON_BYTES, 251)).toThrow(RangeError);
    expect(() => enc.encode(obj, HID_MAX_JSON_BYTES, 0)).toThrow(RangeError);
  });
});
