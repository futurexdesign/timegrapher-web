/**
 * HID report framing (HID_CONTROL_PLANE.md §3). Pure functions and small
 * classes with no WebHID dependency, so they are unit-testable in isolation.
 *
 * Wire layout of one WebHID report buffer (63 bytes, report ID excluded):
 * `[flags, msgSeq, fragIndex, fragCount, payloadLen, ...utf8 chunk]`.
 *
 * - {@link FrameEncoder} splits one JSON object into reports.
 * - {@link FrameReassembler} collects reports back into one JSON object,
 *   keyed by `msgSeq`; a new `msgSeq` abandons an incomplete prior message.
 *   Fragments may arrive in any order; duplicates are ignored; incomplete
 *   messages expire {@link HID_REASSEMBLY_TIMEOUT_MS} after the first fragment.
 */
import {
  HID_FRAME_FLAG_MORE,
  HID_FRAME_HEADER_BYTES,
  FRAME_MAX_PAYLOAD,
  HID_FRAME_MAX_CHUNK,
  HID_MAX_FRAGMENTS,
  HID_MAX_REQUEST_BYTES,
  HID_REASSEMBLY_TIMEOUT_MS,
} from './constants';

/** Thrown by {@link FrameEncoder.encode} when a request exceeds the request cap (2030 bytes). */
export class FrameTooLargeError extends Error {
  /** Size of the offending payload in bytes. */
  readonly bytes: number;
  /** The limit that was exceeded. */
  readonly limit: number;
  constructor(bytes: number, limit: number = HID_MAX_REQUEST_BYTES) {
    super(
      `Request of ${bytes} bytes exceeds the ${limit}-byte limit; the device would drop it silently`,
    );
    this.limit = limit;
    this.name = 'FrameTooLargeError';
    this.bytes = bytes;
  }
}

/**
 * Splits objects into HID report buffers. Owns the host's outbound `msgSeq`
 * counter (8-bit, wraps).
 */
export class FrameEncoder {
  private seq = 0;

  /**
   * Serialises `obj` to JSON and fragments it.
   * @param obj Any JSON-serialisable value (a request envelope).
   * @returns One buffer per fragment (63 bytes by default), zero padded, ready for
   *   `device.sendReport(HID_REPORT_ID, buffer)`.
   * @param maxBytes Size cap of the UTF-8 JSON (default {@link HID_MAX_REQUEST_BYTES}:
   *   the device silently drops longer requests, so they are refused here).
   * @param chunkBytes Payload bytes per frame (default {@link HID_FRAME_MAX_CHUNK}, 58).
   *   The host always sends 58; larger values model a BLE device that applied
   *   `hello.frameMax` (§14.3) and produce frames of `5 + chunkBytes` bytes.
   * @throws {FrameTooLargeError} when the UTF-8 JSON exceeds `maxBytes`.
   * @throws {RangeError} when `chunkBytes` is outside 1..{@link FRAME_MAX_PAYLOAD}.
   */
  encode(
    obj: unknown,
    maxBytes: number = HID_MAX_REQUEST_BYTES,
    chunkBytes: number = HID_FRAME_MAX_CHUNK,
  ): Uint8Array<ArrayBuffer>[] {
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > FRAME_MAX_PAYLOAD) {
      throw new RangeError(`chunkBytes ${chunkBytes} outside 1..${FRAME_MAX_PAYLOAD}`);
    }
    const text = new TextEncoder().encode(JSON.stringify(obj));
    if (text.length > maxBytes) throw new FrameTooLargeError(text.length, maxBytes);
    const fragCount = Math.max(1, Math.ceil(text.length / chunkBytes));
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    const reports: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < fragCount; i++) {
      const chunk = text.subarray(i * chunkBytes, (i + 1) * chunkBytes);
      const buf = new Uint8Array(HID_FRAME_HEADER_BYTES + chunkBytes);
      buf[0] = i + 1 < fragCount ? HID_FRAME_FLAG_MORE : 0;
      buf[1] = seq;
      buf[2] = i;
      buf[3] = fragCount;
      buf[4] = chunk.length;
      buf.set(chunk, HID_FRAME_HEADER_BYTES);
      reports.push(buf);
    }
    return reports;
  }
}

/** Result of feeding one report to {@link FrameReassembler.push}. */
export type PushResult =
  | { readonly kind: 'message'; readonly message: unknown }
  | { readonly kind: 'pending' }
  | { readonly kind: 'dropped'; readonly reason: DropReason };

/** Why a report or message was discarded. */
export type DropReason =
  | 'short' // fewer than 5 header bytes
  | 'badHeader' // fragCount 0 / too large, payloadLen > 250 or beyond the buffer
  | 'badIndex' // fragIndex >= fragCount
  | 'duplicate' // fragment already received
  | 'badJson'; // reassembled bytes are not valid JSON

interface Partial_ {
  seq: number;
  count: number;
  parts: (Uint8Array | undefined)[];
  got: number;
  startedMs: number;
}

/** Reassembles inbound reports into JSON values. */
export class FrameReassembler {
  private rx: Partial_ | null = null;
  private readonly now: () => number;

  /**
   * @param now Monotonic clock in milliseconds (injectable for tests).
   */
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Discards any incomplete message. */
  reset(): void {
    this.rx = null;
  }

  /**
   * Feeds one input report (buffer WITHOUT the report ID, §3.2).
   * @param data The `DataView` from `inputreport`, or raw bytes.
   * @returns `message` with the parsed JSON once the last fragment arrived,
   *   `pending` while waiting for more, or `dropped` with a reason.
   */
  push(data: DataView | Uint8Array): PushResult {
    const u8 =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (u8.length < HID_FRAME_HEADER_BYTES) return { kind: 'dropped', reason: 'short' };
    const seq = u8[1] ?? 0;
    const fragIndex = u8[2] ?? 0;
    const fragCount = u8[3] ?? 0;
    const payloadLen = u8[4] ?? 0;
    if (
      fragCount < 1 ||
      fragCount > HID_MAX_FRAGMENTS ||
      payloadLen > FRAME_MAX_PAYLOAD ||
      HID_FRAME_HEADER_BYTES + payloadLen > u8.length
    ) {
      return { kind: 'dropped', reason: 'badHeader' };
    }
    if (fragIndex >= fragCount) return { kind: 'dropped', reason: 'badIndex' };

    const t = this.now();
    let rx = this.rx;
    if (
      rx === null ||
      rx.seq !== seq ||
      rx.count !== fragCount ||
      t - rx.startedMs > HID_REASSEMBLY_TIMEOUT_MS
    ) {
      rx = {
        seq,
        count: fragCount,
        parts: new Array<Uint8Array | undefined>(fragCount),
        got: 0,
        startedMs: t,
      };
      this.rx = rx;
    }
    if (rx.parts[fragIndex] !== undefined) return { kind: 'dropped', reason: 'duplicate' };
    // Copy: the DataView's backing store may be reused by the platform.
    rx.parts[fragIndex] = u8.slice(HID_FRAME_HEADER_BYTES, HID_FRAME_HEADER_BYTES + payloadLen);
    rx.got++;
    if (rx.got !== rx.count) return { kind: 'pending' };

    this.rx = null;
    let total = 0;
    for (const p of rx.parts) total += p?.byteLength ?? 0;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of rx.parts) {
      if (p === undefined) continue;
      out.set(p, offset);
      offset += p.byteLength;
    }
    try {
      return { kind: 'message', message: JSON.parse(new TextDecoder().decode(out)) as unknown };
    } catch {
      return { kind: 'dropped', reason: 'badJson' };
    }
  }
}
