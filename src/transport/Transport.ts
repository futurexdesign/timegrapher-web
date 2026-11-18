/**
 * Transport abstraction between the app and a timegrapher device.
 *
 * Two implementations exist: `WebHidTransport` (real hardware over WebHID) and
 * a virtual device built by `src/sim`. Everything above this layer (stores,
 * views) talks only to {@link Transport}, so it never knows which is in use.
 */
import type { HidErrorCode, HidNotify, OpName, RequestOf, ResultOf } from '@/protocol/types';

/** Which implementation backs a {@link Transport}. */
export type TransportKind = 'webhid' | 'virtual';

/**
 * Client-side failure codes, in addition to the device's {@link HidErrorCode}s.
 * - `timeout`: no reply within the request timeout.
 * - `disconnected`: the device went away (or was closed) with the request outstanding.
 * - `notOpen`: request issued while the transport is not open.
 * - `protocol`: the request could not be encoded (e.g. over 2048 bytes).
 */
export type ClientErrorCode = 'timeout' | 'disconnected' | 'notOpen' | 'protocol';

/** Any code a {@link DeviceError} can carry. */
export type DeviceErrorCode = HidErrorCode | ClientErrorCode;

/** Error from a device error response (§4.3) or a client-side failure. */
export class DeviceError extends Error {
  /** Machine-readable code (device §4.5 codes or {@link ClientErrorCode}). */
  readonly code: DeviceErrorCode;
  /** The op that failed, when known. */
  readonly op: string | undefined;

  /**
   * @param code Error code.
   * @param message Human-readable message (from the device for device errors).
   * @param op The failing op.
   */
  constructor(code: DeviceErrorCode, message: string, op?: string) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    this.op = op;
  }
}

/**
 * Type guard for {@link DeviceError}.
 * @param e Any thrown value.
 */
export function isDeviceError(e: unknown): e is DeviceError {
  return e instanceof DeviceError;
}

/** Callback for unsolicited device notifications. */
export type NotifyListener = (notify: HidNotify) => void;
/** Callback fired once when the device disconnects or the link breaks. */
export type DisconnectListener = (reason?: string) => void;

/** A request/notify channel to one device. */
export interface Transport {
  /** Implementation kind. */
  readonly kind: TransportKind;
  /** Opens the link (for WebHID this shows the browser device chooser). */
  open(): Promise<void>;
  /** Closes the link and rejects outstanding requests. Idempotent. */
  close(): Promise<void>;
  /**
   * Sends one request and resolves with its typed `result`.
   * @param op Operation name.
   * @param body Fields to add beside `v`/`id`/`op`.
   * @param timeoutMs Reply timeout (default per implementation).
   * @throws {DeviceError} on device error replies, timeouts and disconnects.
   */
  request<O extends OpName>(op: O, body?: RequestOf<O>, timeoutMs?: number): Promise<ResultOf<O>>;
  /**
   * Subscribes to notifications.
   * @returns Unsubscribe function.
   */
  onNotify(cb: NotifyListener): () => void;
  /**
   * Subscribes to disconnect events.
   * @returns Unsubscribe function.
   */
  onDisconnect(cb: DisconnectListener): () => void;
}
