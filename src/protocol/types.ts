/**
 * Convenience re-exports of the protocol type declarations plus the generic
 * op helpers used by the transport layer.
 *
 * `timegrapher_hid.d.ts` is copied verbatim from the firmware repo by
 * `npm run sync-types` and must not be edited here. Import protocol types
 * from this module (`@/protocol/types`) rather than the generated file so the
 * generated file can be swapped without touching call sites.
 */
import type { HidNotifyDataMap, HidRequestBodyMap, HidResultMap } from './timegrapher_hid';

export type * from './timegrapher_hid';

/** Name of any request op that has a typed request body and result. */
export type OpName = keyof HidResultMap & keyof HidRequestBodyMap;
/** Request body (the fields besides `v`, `id`, `op`) for op `O`. */
export type RequestOf<O extends OpName> = HidRequestBodyMap[O];
/** Result payload for op `O`. */
export type ResultOf<O extends OpName> = HidResultMap[O];
/** Names of the unsolicited notify messages. */
export type NotifyOp = keyof HidNotifyDataMap;
