/**
 * Link-independent half of a framed JSON transport (plan §3.2, §4.7, §6.2).
 *
 * {@link FramedTransport} owns everything that does not depend on how bytes
 * reach the device: the single in-flight request queue, request ids, timeouts,
 * late-reply handling, notify dispatch, framing, teardown, the idle keepalive
 * and the `controlReleased` takeover handling. A subclass (WebHID, Web
 * Bluetooth, a test double) supplies only "open the link", "close the link",
 * "write one frame", and feeds received data back through {@link
 * FramedTransport.onFrame} and {@link FramedTransport.onLinkLost}.
 *
 * Device behaviour that shapes the design: the device handles one request at a
 * time and silently drops a second request that arrives while one is pending,
 * so the next request is only sent after the previous one resolved, failed or
 * timed out. Requests that encode to more than 2030 bytes are dropped by the
 * device and are rejected here with a `protocol` error. Replies are matched by
 * `id`; notifications (no `id`) are dispatched at any time; late replies to
 * timed-out requests are ignored.
 */
import { HID_PROTOCOL_VERSION } from '@/protocol/constants';
import { FrameEncoder, FrameReassembler, FrameTooLargeError } from '@/protocol/framer';
import { isNotify, isResponse, normaliseErrorBody } from '@/protocol/messages';
import type {
  HidControlReleasedNotify,
  HidNotify,
  OpName,
  RequestOf,
  ResultOf,
} from '@/protocol/types';
import {
  DeviceError,
  type DisconnectListener,
  type NotifyListener,
  type Transport,
  type TransportKind,
} from './Transport';

/** Default per-request timeout (ms), as in the reference page. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 4000;

/**
 * Default idle time (ms) after which a keepalive `ping` is sent. Must stay well
 * below the firmware's 10 s ownership lease (§4.7).
 */
export const DEFAULT_KEEPALIVE_MS = 3000;

/** Reply timeout (ms) for the keepalive `ping`. */
export const KEEPALIVE_TIMEOUT_MS = 2000;

/**
 * Narrows an inbound message to the synced {@link HidControlReleasedNotify}
 * (§4.6, §4.7). The types are erased at runtime, so the guard checks the
 * fields itself. It accepts any string in `data.to`, as before the type sync,
 * so an unknown link kind from a newer firmware still tears the link down.
 * @param v Parsed JSON.
 */
function isControlReleased(v: unknown): v is HidControlReleasedNotify {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as { notify?: unknown; op?: unknown; data?: unknown };
  if (m.notify !== true || m.op !== 'controlReleased') return false;
  if (typeof m.data !== 'object' || m.data === null) return false;
  return typeof (m.data as { to?: unknown }).to === 'string';
}

/** Construction options shared by all {@link FramedTransport} subclasses. */
export interface FramedTransportOptions {
  /** Default request timeout in ms (default {@link DEFAULT_REQUEST_TIMEOUT_MS}). */
  defaultTimeoutMs?: number;
  /**
   * Idle time in ms before a keepalive `ping` is sent (default
   * {@link DEFAULT_KEEPALIVE_MS}). `0` disables the keepalive.
   */
  keepaliveMs?: number;
}

/** One request waiting for, or holding, the single in-flight slot. */
interface QueuedRequest {
  /** Request id echoed by the device in its reply. */
  readonly id: number;
  /** Operation name, used in error messages. */
  readonly op: string;
  /** Encoded frames, written in order by {@link FramedTransport.sendFrame}. */
  readonly frames: Uint8Array<ArrayBuffer>[];
  /** Reply timeout in ms, counted from the moment the request becomes in flight. */
  readonly timeoutMs: number;
  /** Settles the caller's promise with the reply `result`. */
  readonly resolve: (v: unknown) => void;
  /** Settles the caller's promise with an error. */
  readonly reject: (e: unknown) => void;
  /** Timeout timer: armed when the request becomes in flight, not when it is queued. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Abstract request/notify transport over a frame-oriented link.
 *
 * Lifecycle: the owner calls {@link open}, then {@link request} and
 * {@link onNotify}; {@link close} ends it. The link is lost either by the
 * subclass calling {@link onLinkLost} or by a `controlReleased` notify.
 *
 * Threading contract: {@link onFrame} and {@link onLinkLost} may be called
 * from event handlers at any time, including during {@link sendFrame}.
 */
export abstract class FramedTransport implements Transport {
  abstract readonly kind: TransportKind;

  /** Default request timeout in ms. */
  protected readonly defaultTimeoutMs: number;
  private readonly keepaliveMs: number;
  private readonly encoder = new FrameEncoder();
  private readonly reassembler = new FrameReassembler();
  private readonly notifyListeners = new Set<NotifyListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly queue: QueuedRequest[] = [];
  private inFlight: QueuedRequest | null = null;
  private nextId = 1;
  private isOpen = false;
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;

  /** @param options See {@link FramedTransportOptions}. */
  protected constructor(options: FramedTransportOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  }

  /**
   * Subclass hook: establishes the link (device chooser, connect, subscribe).
   * Called by {@link open} only while the transport is closed. After it
   * resolves, the subclass must deliver received data via {@link onFrame} and
   * report loss via {@link onLinkLost}. Throw a {@link DeviceError} to fail
   * `open()`; the transport then stays closed.
   */
  protected abstract openLink(): Promise<void>;

  /**
   * Subclass hook: releases the link (remove listeners, close or disconnect).
   * Called after the transport has been torn down by {@link close},
   * {@link onLinkLost} or a `controlReleased` notify. Must be idempotent and
   * must tolerate a link that is already gone. Errors are swallowed.
   */
  protected abstract closeLink(): Promise<void>;

  /**
   * Subclass hook: writes one encoded frame to the link. Called sequentially
   * for the frames of the in-flight request. A rejection fails that request
   * with `disconnected` (a {@link DeviceError} is passed through unchanged).
   * @param frame One frame produced by the shared encoder.
   */
  protected abstract sendFrame(frame: Uint8Array<ArrayBuffer>): Promise<void>;

  /**
   * Subclass hook: runs after the link is up and requests can be sent, before
   * {@link open} resolves. Use it for a link-level handshake that needs the
   * request path (for example BLE's `hello {frameMax}`). The default does
   * nothing. A rejection fails `open()`: the link is released and the transport
   * stays closed.
   */
  protected async afterOpen(): Promise<void> {
    /* no handshake by default */
  }

  /**
   * Opens the link via {@link openLink}, runs {@link afterOpen} and arms the
   * keepalive. Idempotent while open.
   */
  async open(): Promise<void> {
    if (this.isOpen) return;
    await this.openLink();
    this.reassembler.reset();
    this.isOpen = true;
    try {
      await this.afterOpen();
    } catch (e) {
      if (this.stillOpen()) this.teardown(new DeviceError('disconnected', 'Open failed'), false);
      await this.safeCloseLink();
      throw e;
    }
    // A link loss during the handshake already tore everything down.
    if (!this.stillOpen()) throw new DeviceError('disconnected', 'Link lost while opening');
    this.armKeepalive();
  }

  /**
   * Closes the transport: rejects all pending requests with `disconnected`,
   * releases the link via {@link closeLink} and does NOT fire disconnect
   * listeners (the caller initiated it). Idempotent.
   */
  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.teardown(new DeviceError('disconnected', 'Transport closed'), false);
    await this.safeCloseLink();
  }

  /**
   * Queues one request; it is sent when all earlier requests have settled.
   * @param op Operation name.
   * @param body Fields to add beside `v`/`id`/`op`.
   * @param timeoutMs Reply timeout (default: the constructor's `defaultTimeoutMs`).
   * @throws {DeviceError} `notOpen`, `protocol` (too large), `timeout`,
   *   `disconnected`, or the device's error code.
   */
  request<O extends OpName>(
    op: O,
    body?: RequestOf<O>,
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<ResultOf<O>> {
    if (!this.isOpen) return Promise.reject(new DeviceError('notOpen', 'Device not open', op));
    const id = this.nextId++;
    let frames: Uint8Array<ArrayBuffer>[];
    try {
      frames = this.encoder.encode({ v: HID_PROTOCOL_VERSION, id, op, ...body });
    } catch (e) {
      const msg = e instanceof FrameTooLargeError ? e.message : 'Cannot encode request';
      return Promise.reject(new DeviceError('protocol', msg, op));
    }
    this.armKeepalive();
    return new Promise<ResultOf<O>>((resolve, reject) => {
      this.queue.push({
        id,
        op,
        frames,
        timeoutMs,
        resolve: (v) => {
          resolve(v as ResultOf<O>);
        },
        reject,
        timer: undefined,
      });
      void this.pump();
    });
  }

  /** Subscribes to notifications. @returns Unsubscribe function. */
  onNotify(cb: NotifyListener): () => void {
    this.notifyListeners.add(cb);
    return () => this.notifyListeners.delete(cb);
  }

  /**
   * Subscribes to link-loss events (including a `controlReleased` takeover).
   * Not fired by {@link close}. @returns Unsubscribe function.
   */
  onDisconnect(cb: DisconnectListener): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  /**
   * For subclasses: feeds one received link frame (one HID report or one GATT
   * value) to the reassembler and dispatches the completed message, if any.
   * Ignored while the transport is closed.
   * @param data Raw frame bytes as delivered by the link.
   */
  protected onFrame(data: DataView | Uint8Array): void {
    if (!this.isOpen) return;
    const res = this.reassembler.push(data);
    if (res.kind !== 'message') return;
    const msg: unknown = res.message;
    if (isControlReleased(msg)) {
      this.onLinkLost(`Control taken over by ${msg.data.to}`);
    } else if (isNotify(msg)) {
      this.dispatchNotify(msg);
    } else if (isResponse(msg)) {
      const req = this.inFlight;
      if (req?.id !== msg.id) return; // late or unknown reply
      if (msg.ok) this.finish(req, msg.result, true);
      else {
        const e = normaliseErrorBody(msg.error);
        this.finish(req, new DeviceError(e.code, e.message, req.op));
      }
    }
  }

  /**
   * For subclasses: reports that the link is gone (unplug, GATT disconnect).
   * Rejects all pending requests with `disconnected`, fires the disconnect
   * listeners once with `reason`, then releases the link via {@link closeLink}.
   * Ignored when already closed, so repeated reports fire listeners once.
   * @param reason Human-readable reason passed to the listeners.
   */
  protected onLinkLost(reason: string): void {
    if (!this.isOpen) return;
    this.teardown(new DeviceError('disconnected', reason), true);
    void this.safeCloseLink();
  }

  /** @returns {@link isOpen} read afresh (TypeScript cannot see changes made during an `await`). */
  private stillOpen(): boolean {
    return this.isOpen;
  }

  /** Runs {@link closeLink}, swallowing errors (the link may already be gone). */
  private async safeCloseLink(): Promise<void> {
    try {
      await this.closeLink();
    } catch {
      /* already gone */
    }
  }

  /**
   * (Re)starts the idle clock; {@link sendKeepalive} fires after `keepaliveMs`
   * without a request. The clock restarts when a request is queued (not when
   * it completes). A ping that falls due while a request is outstanding is
   * deferred by one full interval. This is safe against the 10 s ownership
   * lease: the outstanding request itself refreshes the lease, and the worst
   * case gap is the request timeout (4 s default) plus one interval (3 s),
   * about 7 s.
   */
  private armKeepalive(): void {
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    if (this.keepaliveMs <= 0 || !this.isOpen) return;
    this.keepaliveTimer = setTimeout(() => {
      this.sendKeepalive();
    }, this.keepaliveMs);
  }

  /**
   * Sends the keepalive `ping` (§6.2) unless a request is already outstanding.
   * The ping is an ordinary request, so it re-arms the idle clock. Failures
   * are logged and otherwise ignored: a dead link is reported by the link.
   */
  private sendKeepalive(): void {
    this.keepaliveTimer = undefined;
    if (!this.isOpen) return;
    if (this.inFlight !== null || this.queue.length > 0) {
      this.armKeepalive();
      return;
    }
    this.request('ping', undefined, KEEPALIVE_TIMEOUT_MS).catch((e: unknown) => {
      console.warn('keepalive ping failed', e);
    });
  }

  /** Sends the next queued request when nothing is in flight. */
  private async pump(): Promise<void> {
    if (this.inFlight !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.inFlight = next;
    next.timer = setTimeout(() => {
      this.finish(next, new DeviceError('timeout', `Timeout waiting for ${next.op}`, next.op));
    }, next.timeoutMs);
    try {
      for (const frame of next.frames) await this.sendFrame(frame);
    } catch (e) {
      this.finish(
        next,
        e instanceof DeviceError
          ? e
          : new DeviceError(
              'disconnected',
              e instanceof Error ? e.message : 'sendFrame failed',
              next.op,
            ),
      );
    }
  }

  /** Settles the in-flight request (if it is still `req`) and sends the next. */
  private finish(req: QueuedRequest, outcome: unknown, ok = false): void {
    if (this.inFlight !== req) return;
    clearTimeout(req.timer);
    this.inFlight = null;
    if (ok) req.resolve(outcome);
    else req.reject(outcome);
    void this.pump();
  }

  /**
   * Calls every notify listener with `n`. Listeners are isolated: one that
   * throws is logged and does not stop the others.
   */
  private dispatchNotify(n: HidNotify): void {
    for (const cb of [...this.notifyListeners]) {
      try {
        cb(n);
      } catch (e) {
        console.error('notify listener failed', e);
      }
    }
  }

  /** Stops the keepalive, fails all requests, optionally notifies disconnect listeners. */
  private teardown(error: DeviceError, notify: boolean): void {
    this.isOpen = false;
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    const pending = [...(this.inFlight ? [this.inFlight] : []), ...this.queue];
    this.queue.length = 0;
    this.inFlight = null;
    for (const r of pending) {
      clearTimeout(r.timer);
      r.reject(new DeviceError(error.code, error.message, r.op));
    }
    this.reassembler.reset();
    if (notify) {
      for (const cb of [...this.disconnectListeners]) cb(error.message);
    }
  }
}
