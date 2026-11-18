/**
 * WebHID implementation of {@link Transport}.
 *
 * The device handles one request at a time and silently DROPS a second request
 * that arrives while one is pending (no reply at all); `busy` only means a flash
 * write was refused (e.g. while a USB audio stream is open). So requests go
 * through a single in-flight queue: the next request is only sent after the
 * previous one resolved, failed or timed out. Requests longer than 2030 bytes
 * (35 fragments) are dropped silently by the device, so they are rejected here
 * with a `protocol` error. Replies are matched by
 * `id`; notifications (no `id`) are dispatched to listeners at any time. Late
 * replies to timed-out requests are ignored.
 *
 * The constructor accepts an already-chosen `HIDDevice` and/or an `HID`
 * provider so the queue can be unit-tested with fakes.
 */
import { HID_DEVICE_FILTER, HID_PROTOCOL_VERSION, HID_REPORT_ID } from '@/protocol/constants';
import { FrameEncoder, FrameReassembler, FrameTooLargeError } from '@/protocol/framer';
import { isNotify, isResponse, normaliseErrorBody } from '@/protocol/messages';
import type { HidNotify, OpName, RequestOf, ResultOf } from '@/protocol/types';
import {
  DeviceError,
  type DisconnectListener,
  type NotifyListener,
  type Transport,
} from './Transport';

/** Default per-request timeout (ms), as in the reference page. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 4000;

/** Construction options for {@link WebHidTransport}. */
export interface WebHidTransportOptions {
  /** Pre-chosen device; skips `requestDevice` in `open()`. */
  device?: HIDDevice;
  /** HID provider (default `navigator.hid`). */
  hid?: HID;
  /** Default request timeout in ms. */
  defaultTimeoutMs?: number;
}

interface QueuedRequest {
  id: number;
  op: string;
  frames: Uint8Array<ArrayBuffer>[];
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * @returns `true` when the browser exposes WebHID (Chromium, secure context).
 */
export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/** Transport over a real device using WebHID. */
export class WebHidTransport implements Transport {
  readonly kind = 'webhid' as const;

  private device: HIDDevice | null;
  private readonly hid: HID | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly encoder = new FrameEncoder();
  private readonly reassembler = new FrameReassembler();
  private readonly notifyListeners = new Set<NotifyListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly queue: QueuedRequest[] = [];
  private inFlight: QueuedRequest | null = null;
  private nextId = 1;
  private isOpen = false;
  private weOpenedDevice = false;

  /** @param options See {@link WebHidTransportOptions}. */
  constructor(options: WebHidTransportOptions = {}) {
    this.device = options.device ?? null;
    this.hid = options.hid ?? (isWebHidSupported() ? navigator.hid : undefined);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Name of the opened device (`HIDDevice.productName`), if any. */
  get productName(): string | undefined {
    return this.device?.productName;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    if (this.device === null) {
      if (this.hid === undefined) throw new DeviceError('notOpen', 'WebHID is not available');
      const devices = await this.hid.requestDevice({ filters: [{ ...HID_DEVICE_FILTER }] });
      const chosen = devices[0];
      if (chosen === undefined) throw new DeviceError('notOpen', 'No device selected');
      this.device = chosen;
    }
    const device = this.device;
    if (!device.opened) {
      await device.open();
      this.weOpenedDevice = true;
    }
    device.addEventListener('inputreport', this.onInputReport);
    this.hid?.addEventListener('disconnect', this.onHidDisconnect);
    this.reassembler.reset();
    this.isOpen = true;
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.teardown(new DeviceError('disconnected', 'Transport closed'));
    const device = this.device;
    if (device !== null && this.weOpenedDevice && device.opened) {
      try {
        await device.close();
      } catch {
        /* already gone */
      }
    }
  }

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

  onNotify(cb: NotifyListener): () => void {
    this.notifyListeners.add(cb);
    return () => this.notifyListeners.delete(cb);
  }

  onDisconnect(cb: DisconnectListener): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
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
      const device = this.device;
      if (device === null) throw new DeviceError('notOpen', 'Device not open', next.op);
      for (const frame of next.frames) await device.sendReport(HID_REPORT_ID, frame);
    } catch (e) {
      this.finish(
        next,
        e instanceof DeviceError
          ? e
          : new DeviceError(
              'disconnected',
              e instanceof Error ? e.message : 'sendReport failed',
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

  private readonly onInputReport = (ev: HIDInputReportEvent): void => {
    if (ev.reportId !== HID_REPORT_ID) return;
    const res = this.reassembler.push(ev.data);
    if (res.kind !== 'message') return;
    const msg = res.message;
    if (isNotify(msg)) {
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
  };

  private dispatchNotify(n: HidNotify): void {
    for (const cb of [...this.notifyListeners]) {
      try {
        cb(n);
      } catch (e) {
        console.error('notify listener failed', e);
      }
    }
  }

  private readonly onHidDisconnect = (ev: Event): void => {
    const dev = (ev as Event & { device?: unknown }).device;
    if (dev === this.device)
      this.teardown(new DeviceError('disconnected', 'Device disconnected'), true);
  };

  /** Releases listeners, fails all requests, optionally notifies disconnect listeners. */
  private teardown(error: DeviceError, notify = false): void {
    this.isOpen = false;
    this.device?.removeEventListener('inputreport', this.onInputReport);
    this.hid?.removeEventListener('disconnect', this.onHidDisconnect);
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
