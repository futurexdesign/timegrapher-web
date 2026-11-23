/**
 * Encoder for the packed beat block (BLE_TRANSPORT_PLAN.md §14.2, format 1).
 *
 * Device-side counterpart of `src/protocol/beatsPacked.ts`, used by the
 * simulator and by the round-trip tests; the app itself only decodes. The
 * layout is documented in the decoder. Like the firmware, the encoder ends a
 * block when the grid or the nominal period changes or when a delta does not
 * fit its field, so a decoder never needs grid logic inside a block.
 */
import { BEATS_PACKED_FORMAT } from '@/protocol/constants';
import { PACKED_BEAT_BYTES, PACKED_HEADER_BYTES, PACKED_MAX_BEATS } from '@/protocol/beatsPacked';
import type { DspBeat } from '@/protocol/types';

/** Result of {@link packBeats}. */
export interface PackedBatch {
  /** Base64 text of the block (`data.p` of the notify). */
  readonly p: string;
  /** Number of beats from the start of the input that the block holds (>= 1). */
  readonly count: number;
}

/** Clamps `v` to `[lo, hi]` and rounds to an integer. */
function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/**
 * Tells whether `next` can follow `prev` inside one block.
 * @param first First beat of the block (grid and nominal period must match).
 * @param prev Previous beat of the block.
 * @param next Candidate beat.
 */
function fits(first: DspBeat, prev: DspBeat, next: DspBeat): boolean {
  if (
    next.gridId !== first.gridId ||
    Math.fround(next.nominalUs) !== Math.fround(first.nominalUs)
  ) {
    return false;
  }
  const dSeq = next.seq - prev.seq;
  const dSample = BigInt(next.sampleIndex) - BigInt(prev.sampleIndex);
  const dK = next.k - prev.k;
  return (
    dSeq >= 0 && dSeq <= 255 && dSample >= 0n && dSample < 1n << 32n && dK >= -32768 && dK <= 32767
  );
}

/**
 * Packs a leading run of `beats` into one block.
 * @param beats Beats in seq order, oldest first; at least one.
 * @param sourceHz Sample rate of the analysis source, for the fractional sample.
 * @param maxBeats Largest block, 1..32 (default 32).
 * @returns The block and how many beats it holds; pass the rest again for the next block.
 * @throws {RangeError} when `beats` is empty or `maxBeats` is outside 1..32.
 */
export function packBeats(
  beats: readonly DspBeat[],
  sourceHz: number,
  maxBeats: number = PACKED_MAX_BEATS,
): PackedBatch {
  const first = beats[0];
  if (first === undefined) throw new RangeError('packBeats: no beats');
  if (!Number.isInteger(maxBeats) || maxBeats < 1 || maxBeats > PACKED_MAX_BEATS) {
    throw new RangeError(`packBeats: maxBeats ${maxBeats} outside 1..${PACKED_MAX_BEATS}`);
  }
  let count = 1;
  while (count < maxBeats && count < beats.length) {
    const prev = beats[count - 1];
    const next = beats[count];
    if (prev === undefined || next === undefined || !fits(first, prev, next)) break;
    count++;
  }

  const bytes = new Uint8Array(PACKED_HEADER_BYTES + count * PACKED_BEAT_BYTES);
  const v = new DataView(bytes.buffer);
  v.setUint8(0, BEATS_PACKED_FORMAT);
  v.setUint8(1, count);
  v.setUint32(2, first.seq, true);
  v.setUint32(6, first.gridId, true);
  v.setFloat32(10, first.nominalUs, true);
  v.setBigUint64(14, BigInt(first.sampleIndex), true);
  v.setInt32(22, first.k, true);
  let prev = first;
  for (let i = 0; i < count; i++) {
    const b = beats[i] ?? first;
    const o = PACKED_HEADER_BYTES + i * PACKED_BEAT_BYTES;
    const sample = BigInt(b.sampleIndex);
    const status = b.status === 'accepted' ? 0 : b.status === 'started' ? 1 : 2;
    v.setUint8(o, b.seq - prev.seq);
    v.setUint8(o + 1, b.parity | (b.amplitudeValid ? 2 : 0) | (status << 2));
    v.setUint32(o + 2, Number(sample - BigInt(prev.sampleIndex)), true);
    v.setUint8(o + 6, clampInt((b.tS * sourceHz - Number(sample)) * 256, 0, 255));
    v.setInt16(o + 7, b.k - prev.k, true);
    v.setInt32(o + 9, clampInt(b.uUs * 10, -2147483648, 2147483647), true);
    v.setUint16(o + 13, b.amplitudeValid ? clampInt(b.amplitudeDeg * 100, 0, 65535) : 0, true);
    v.setUint16(o + 15, clampInt(b.liftMs * 1000, 0, 65535), true);
    prev = b;
  }
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return { p: btoa(bin), count };
}
