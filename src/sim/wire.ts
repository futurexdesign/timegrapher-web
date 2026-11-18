/**
 * Simulator-side wire-size helpers: the firmware caps every JSON message at
 * 2048 bytes (`kMaxJson`) and fills list replies with as many entries as fit.
 */

/** Maximum encoded size of one device message (bytes). */
export const HID_JSON_MAX = 2048;

/**
 * Bytes reserved for the reply envelope `{"v":1,"id":N,"ok":true,"result":` plus
 * its closing `}`: the request id is modelled as up to six digits so paging is
 * deterministic (the firmware's id width varies with the request).
 */
export const REPLY_ENVELOPE_BYTES = '{"v":1,"id":000000,"ok":true,"result":}'.length;

/**
 * @param op Notify op name.
 * @returns Bytes of the notify envelope `{"v":1,"notify":true,"op":"<op>","data":` plus `}`.
 */
export function notifyEnvelopeBytes(op: string): number {
  return `{"v":1,"notify":true,"op":"${op}","data":}`.length;
}

/**
 * JSON.stringify replacer approximating the firmware's `%.6g` number format,
 * so size estimates are not inflated by double precision noise.
 * @param _k Key (unused).
 * @param v Value.
 * @returns The value, numbers rounded to 6 significant digits.
 */
function sixSig(_k: string, v: unknown): unknown {
  return typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(6)) : v;
}

/**
 * Counts how many leading items fit a byte budget when comma-joined.
 * @param items Candidate items, in emission order.
 * @param budget Bytes available for the joined items.
 * @returns The number of items that fit (at least 0).
 */
export function fitCount(items: readonly unknown[], budget: number): number {
  let used = 0;
  let n = 0;
  for (const it of items) {
    const need = JSON.stringify(it, sixSig).length + (n > 0 ? 1 : 0);
    if (used + need > budget) break;
    used += need;
    n++;
  }
  return n;
}
