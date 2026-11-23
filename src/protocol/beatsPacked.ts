/**
 * Decoder for the packed beat block (BLE_TRANSPORT_PLAN.md §14.2, format 1).
 *
 * The device sends beats as one base64 string, `{"p": "..."}`, in the
 * `beatsPacked` notify and in a `getBeats` reply with `packed: true`. This
 * module turns that string into the same {@link DspBeat} objects the JSON
 * `beats` stream carries, so the stores and charts do not change.
 *
 * Block layout (all little-endian), the normative table is §14.2:
 *
 * - Header, 26 bytes: `fmt` u8 (1), `n` u8 (1..32), `seq0` u32, `gridId` u32,
 *   `nominalUs` f32, `sample0` u64, `k0` i32.
 * - Then `n` records of 17 bytes: `dSeq` u8, `flags` u8 (bit 0 parity, bit 1
 *   amplitudeValid, bits 2-3 status), `dSample` u32, `frac` u8, `dK` i16,
 *   `u` i32 (0.1 µs), `amp` u16 (0.01 degree), `lift` u16 (µs).
 *
 * `seq`, `sampleIndex` and `k` of a record are the previous beat's value plus
 * the delta; the first beat uses the header value. Every beat of a block
 * shares `gridId` and `nominalUs`. The encoder used by the simulator and the
 * tests is in `src/sim/beatsPackedEncoder.ts`.
 */
import { BEATS_PACKED_FORMAT } from './constants';
import type { DspBeat, DspBeatStatus, DspBeats, DspBeatsPacked } from './types';

/** Header size of format 1 in bytes. */
export const PACKED_HEADER_BYTES = 26;
/** Size of one beat record of format 1 in bytes. */
export const PACKED_BEAT_BYTES = 17;
/** Largest beat count of one block. */
export const PACKED_MAX_BEATS = 32;
/**
 * Sample rate assumed when the stream's rate is not known yet. The firmware's
 * analysis source runs at 48 kHz unless the host opened the audio stream at
 * 44.1 kHz; `getBeat.sourceHz` is the authority.
 */
export const DEFAULT_SOURCE_HZ = 48000;

/** Status codes in bits 2-3 of the `flags` byte. */
const STATUS_BY_CODE: readonly DspBeatStatus[] = ['accepted', 'started', 'rejected'];

/** Thrown for a block that is not valid format 1 (unknown version, bad size, bad base64). */
export class BeatsPackedError extends Error {
  /** @param message What is wrong with the block. */
  constructor(message: string) {
    super(message);
    this.name = 'BeatsPackedError';
  }
}

/**
 * Decodes standard base64 (RFC 4648 §4, `=` padded) to bytes.
 * @param text Base64 text.
 * @throws {BeatsPackedError} when `text` is not valid base64.
 */
function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new BeatsPackedError('Packed beats: invalid base64');
  }
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decodes one packed block into beats.
 * @param p The base64 string of a `beatsPacked` notify or packed `getBeats` result.
 * @param sourceHz Sample rate of the analysis source (`getBeat.sourceHz`), used for
 *   `tS = (sampleIndex + frac / 256) / sourceHz`. Default {@link DEFAULT_SOURCE_HZ}.
 * @returns The beats in block order (oldest first), with `uUs` in µs, `amplitudeDeg`
 *   in degrees (0 when invalid) and `liftMs` in ms.
 * @throws {BeatsPackedError} for invalid base64, an unknown `fmt`, a beat count
 *   outside 1..32, a length that does not match the count, or a reserved status code.
 */
export function decodeBeatsPacked(p: string, sourceHz: number = DEFAULT_SOURCE_HZ): DspBeat[] {
  const bytes = fromBase64(p);
  if (bytes.length < 2) throw new BeatsPackedError('Packed beats: block too short');
  const fmt = bytes[0] ?? 0;
  if (fmt !== BEATS_PACKED_FORMAT) {
    throw new BeatsPackedError(`Packed beats: unsupported format ${fmt}`);
  }
  const n = bytes[1] ?? 0;
  if (n < 1 || n > PACKED_MAX_BEATS) {
    throw new BeatsPackedError(`Packed beats: beat count ${n} outside 1..${PACKED_MAX_BEATS}`);
  }
  const expected = PACKED_HEADER_BYTES + n * PACKED_BEAT_BYTES;
  if (bytes.length !== expected) {
    throw new BeatsPackedError(
      `Packed beats: ${bytes.length} bytes for ${n} beats, expected ${expected}`,
    );
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let seq = v.getUint32(2, true);
  const gridId = v.getUint32(6, true);
  const nominalUs = v.getFloat32(10, true);
  let sample = v.getBigUint64(14, true);
  let k = v.getInt32(22, true);

  const beats: DspBeat[] = [];
  for (let i = 0; i < n; i++) {
    const o = PACKED_HEADER_BYTES + i * PACKED_BEAT_BYTES;
    const flags = v.getUint8(o + 1);
    const code = (flags >> 2) & 3;
    const status = STATUS_BY_CODE[code];
    if (status === undefined) {
      throw new BeatsPackedError(`Packed beats: reserved status code ${code}`);
    }
    seq += v.getUint8(o);
    sample += BigInt(v.getUint32(o + 2, true));
    k += v.getInt16(o + 7, true);
    const amplitudeValid = (flags & 2) !== 0;
    beats.push({
      seq,
      gridId,
      sampleIndex: sample.toString(),
      tS: (Number(sample) + v.getUint8(o + 6) / 256) / sourceHz,
      k,
      parity: (flags & 1) === 1 ? 1 : 0,
      uUs: v.getInt32(o + 9, true) / 10,
      nominalUs,
      amplitudeDeg: amplitudeValid ? v.getUint16(o + 13, true) / 100 : 0,
      amplitudeValid,
      liftMs: v.getUint16(o + 15, true) / 1000,
      status,
    });
  }
  return beats;
}

/**
 * Returns the beats of a `getBeats` result, packed or not.
 * @param result The reply: {@link DspBeats} (newest first) or {@link DspBeatsPacked} (newest last).
 * @param sourceHz Sample rate for the packed form (see {@link decodeBeatsPacked}).
 * @returns The beats in the order the device sent them. An empty packed text
 *   (no beats held) gives `[]`.
 * @throws {BeatsPackedError} for an invalid packed block.
 */
export function beatsOfResult(
  result: DspBeats | DspBeatsPacked,
  sourceHz: number = DEFAULT_SOURCE_HZ,
): DspBeat[] {
  if (!('p' in result)) return result.beats;
  return result.p === '' ? [] : decodeBeatsPacked(result.p, sourceHz);
}
