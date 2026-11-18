/**
 * Runtime protocol constants (HID_CONTROL_PLANE.md §2, §3).
 *
 * The generated `timegrapher_hid.d.ts` only declares these as ambient
 * constants (no runtime value), so the values are repeated here. A unit test
 * in `framer.test.ts` guards the numbers against the spec.
 */

/** Vendor usage page of the control collection (§2). */
export const HID_USAGE_PAGE = 0xffa0;
/** Usage of the control collection (§2). */
export const HID_USAGE = 0x0001;
/** Report ID of both the input and output reports. */
export const HID_REPORT_ID = 0x01;

/** Bytes in a WebHID report buffer, excluding the report ID (§3.2). */
export const HID_REPORT_BYTES = 63;
/** Frame header bytes: flags, msgSeq, fragIndex, fragCount, payloadLen. */
export const HID_FRAME_HEADER_BYTES = 5;
/** Maximum UTF-8 payload bytes in one report. */
export const HID_FRAME_MAX_CHUNK = 58;
/** Flag bit0: more fragments follow. */
export const HID_FRAME_FLAG_MORE = 0x01;
/** Flag bit1: advisory notify hint (ignored by this host). */
export const HID_FRAME_FLAG_NOTIFY_HINT = 0x02;
/** Maximum reassembled JSON payload in bytes. */
export const HID_MAX_JSON_BYTES = 2048;
/**
 * Maximum JSON bytes of a REQUEST. The device drops longer requests silently
 * (at most 35 fragments of 58 bytes); replies still use {@link HID_MAX_JSON_BYTES}.
 */
export const HID_MAX_REQUEST_BYTES = 2030;
/** Largest legal `fragCount` of a reply. */
export const HID_MAX_FRAGMENTS = Math.ceil(HID_MAX_JSON_BYTES / HID_FRAME_MAX_CHUNK);
/** Reassembly timeout from the first fragment (ms, §3.1). */
export const HID_REASSEMBLY_TIMEOUT_MS = 500;
/** Protocol version put in every request (`v`). */
export const HID_PROTOCOL_VERSION = 1;

/** `navigator.hid.requestDevice` filter (§2.1). */
export const HID_DEVICE_FILTER = { usagePage: HID_USAGE_PAGE, usage: HID_USAGE } as const;
