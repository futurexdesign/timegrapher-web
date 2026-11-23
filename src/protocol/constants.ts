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

/** BLE control service UUID (BLE_CONTROL_PLANE.md §4.1). Lowercase, as Web Bluetooth requires. */
export const BLE_SERVICE_UUID = 'c137e7c0-92b4-4d9e-87e0-9ba757169016';
/** RX characteristic (host to device): one frame per ATT write. */
export const BLE_RX_UUID = 'c137e7c1-92b4-4d9e-87e0-9ba757169016';
/** TX characteristic (device to host): one frame per notification. */
export const BLE_TX_UUID = 'c137e7c2-92b4-4d9e-87e0-9ba757169016';
/** INFO characteristic: UTF-8 JSON link description (`p`, `mtu`, `fmax`, `seg`). */
export const BLE_INFO_UUID = 'c137e7c3-92b4-4d9e-87e0-9ba757169016';
/** Advertised local-name prefix (`TG-XXXX`), used as a scan filter alternative (§4.2). */
export const BLE_NAME_PREFIX = 'TG-';
/** Smallest ATT MTU that carries a full 63-byte frame (63 + 3 bytes ATT header = 66). */
export const BLE_MIN_MTU = 66;

/**
 * Largest `payloadLen` the reassembler accepts (BLE_TRANSPORT_PLAN.md §14.3):
 * a 255-byte BLE frame minus the 5-byte header. HID reports stay at 63 bytes,
 * so the buffer length still bounds them to {@link HID_FRAME_MAX_CHUNK}.
 */
export const FRAME_MAX_PAYLOAD = 250;
/** Largest frame (header plus payload) a BLE device sends after `hello.frameMax` (§14.3). */
export const BLE_FRAME_MAX = 255;
/** Packed beat format version this app decodes (`caps.beatsPacked`, §14.2). */
export const BEATS_PACKED_FORMAT = 1;
