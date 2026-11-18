/**
 * {@link Transport} implementation backed by a {@link VirtualDevice}.
 *
 * Behaves like the WebHID transport from the caller's side: one request in
 * flight at a time (others queue), a configurable reply latency, a per-request
 * timeout, `DeviceError` for device errors, notifies delivered through
 * `onNotify` while a subscription is active, and `onDisconnect` when a
 * scenario drops the link.
 *
 * Timers come from an injectable {@link Scheduler} (default: the global
 * timers, resolved at call time so fake timers work), the time source from the
 * device's injectable clock.
 */
import type { HidNotify, OpName, RequestOf, ResultOf } from '@/protocol/types';
import {
  DeviceError,
  isDeviceError,
  type DisconnectListener,
  type NotifyListener,
  type Transport,
} from '@/transport/Transport';
import {
  createSimulatorControl,
  defaultBuild,
  getPersistedSettings,
  registerSimulatorControl,
  releaseSimulatorControl,
  settingsToOptions,
  type SimulatorControl,
} from './scenarios';
import { VirtualDevice, type VirtualDeviceOptions } from './VirtualDevice';

/** Timer functions used by the transport. */
export interface Scheduler {
  /** Like `setTimeout`; returns a handle for {@link Scheduler.clearTimeout}. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancels a timeout. */
  clearTimeout(handle: unknown): void;
  /** Like `setInterval`. */
  setInterval(fn: () => void, ms: number): unknown;
  /** Cancels an interval. */
  clearInterval(handle: unknown): void;
}

/** Default scheduler: the global timers, looked up on each call. */
export const globalScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => {
    globalThis.clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => {
    globalThis.clearInterval(h as ReturnType<typeof setInterval>);
  },
};

/** Options for {@link VirtualTransport}. */
export interface VirtualTransportOptions extends VirtualDeviceOptions {
  /** Reply latency per request (ms, default 5). */
  latencyMs?: number;
  /** Notify poll interval while subscribed (ms, default 10). */
  pollMs?: number;
  /** Default request timeout (ms, default 4000). */
  defaultTimeoutMs?: number;
  /** Timer implementation. */
  scheduler?: Scheduler;
  /** Use this device instead of creating one. */
  device?: VirtualDevice;
  /** Register as the active simulator (default true). */
  register?: boolean;
  /** Ignore the remembered simulator settings (default false). */
  ignorePersisted?: boolean;
}

interface Pending {
  op: OpName;
  body: object;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  replyTimer: unknown;
  timeoutTimer: unknown;
}

/** Virtual-device transport. */
export class VirtualTransport implements Transport {
  readonly kind = 'virtual' as const;
  /** The simulated device. */
  readonly device: VirtualDevice;
  /** Control API for this device. */
  readonly control: SimulatorControl;

  private readonly sched: Scheduler;
  private readonly pollMs: number;
  private readonly defaultTimeoutMs: number;
  private latencyMs: number;
  private opened = false;
  private queue: Pending[] = [];
  private inflight: Pending | null = null;
  private poller: unknown = null;
  private readonly notifyListeners = new Set<NotifyListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly register: boolean;

  /** @param options Transport / device options. */
  constructor(options: VirtualTransportOptions = {}) {
    const persisted = options.ignorePersisted === true ? undefined : getPersistedSettings();
    const merged: VirtualDeviceOptions = {
      ...(persisted ? settingsToOptions(persisted) : {}),
      ...options,
    };
    this.device = options.device ?? new VirtualDevice(merged);
    this.sched = options.scheduler ?? globalScheduler;
    this.pollMs = options.pollMs ?? 10;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 4000;
    this.latencyMs = options.latencyMs ?? persisted?.latencyMs ?? 5;
    this.register = options.register ?? true;
    const build = {
      ...defaultBuild(),
      quartz: this.device.caps.quartz,
      gps: this.device.caps.gps === true,
      pps: this.device.caps.pps === true,
    };
    this.control = createSimulatorControl(
      this.device,
      {
        disconnect: (reason) => {
          this.drop(reason);
        },
        getLatencyMs: () => this.latencyMs,
        setLatencyMs: (ms) => {
          this.latencyMs = ms;
        },
        isOpen: () => this.opened,
      },
      build,
    );
    if (this.register) registerSimulatorControl(this.control);
  }

  /** Opens the link (immediate). */
  open(): Promise<void> {
    this.opened = true;
    if (this.register) registerSimulatorControl(this.control);
    this.updatePolling();
    return Promise.resolve();
  }

  /** Closes the link; outstanding requests fail with `disconnected`. Idempotent. */
  close(): Promise<void> {
    if (this.opened) this.shutdown('Transport closed');
    if (this.register) releaseSimulatorControl(this.control);
    return Promise.resolve();
  }

  /**
   * Sends a request (queued behind any in flight).
   * @param op Operation.
   * @param body Request fields.
   * @param timeoutMs Reply timeout.
   */
  request<O extends OpName>(op: O, body?: RequestOf<O>, timeoutMs?: number): Promise<ResultOf<O>> {
    if (!this.opened) {
      return Promise.reject(new DeviceError('notOpen', 'Virtual device is not open', op));
    }
    return new Promise<ResultOf<O>>((resolve, reject) => {
      this.queue.push({
        op,
        body: body ?? {},
        timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
        resolve: resolve as (v: unknown) => void,
        reject,
        replyTimer: null,
        timeoutTimer: null,
      });
      this.pump();
    });
  }

  /** @inheritDoc */
  onNotify(cb: NotifyListener): () => void {
    this.notifyListeners.add(cb);
    return () => {
      this.notifyListeners.delete(cb);
    };
  }

  /** @inheritDoc */
  onDisconnect(cb: DisconnectListener): () => void {
    this.disconnectListeners.add(cb);
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  private pump(): void {
    if (this.inflight !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.inflight = next;
    next.replyTimer = this.sched.setTimeout(() => {
      this.execute(next);
    }, this.latencyMs);
    next.timeoutTimer = this.sched.setTimeout(() => {
      this.timeout(next);
    }, next.timeoutMs);
  }

  private finish(p: Pending): void {
    this.sched.clearTimeout(p.replyTimer);
    this.sched.clearTimeout(p.timeoutTimer);
    if (this.inflight === p) this.inflight = null;
  }

  private execute(p: Pending): void {
    if (this.inflight !== p) return;
    this.finish(p);
    try {
      const result = this.device.handle(p.op, p.body);
      p.resolve(result);
    } catch (e) {
      p.reject(
        isDeviceError(e)
          ? e
          : new DeviceError('internal', e instanceof Error ? e.message : String(e), p.op),
      );
    }
    this.updatePolling();
    this.pump();
  }

  private timeout(p: Pending): void {
    if (this.inflight !== p) return;
    this.finish(p);
    p.reject(new DeviceError('timeout', `No reply to ${p.op} within ${p.timeoutMs} ms`, p.op));
    this.pump();
  }

  private updatePolling(): void {
    const want = this.opened && this.device.wantsPolling;
    if (want && this.poller === null) {
      this.poller = this.sched.setInterval(() => {
        this.poll();
      }, this.pollMs);
    } else if (!want && this.poller !== null) {
      this.sched.clearInterval(this.poller);
      this.poller = null;
    }
  }

  private poll(): void {
    if (!this.opened) return;
    const n: HidNotify | null = this.device.pollNotify();
    if (n) for (const l of [...this.notifyListeners]) l(n);
  }

  /** Fails everything outstanding and stops polling. */
  private shutdown(reason: string): void {
    this.opened = false;
    if (this.poller !== null) {
      this.sched.clearInterval(this.poller);
      this.poller = null;
    }
    const pending = [...(this.inflight ? [this.inflight] : []), ...this.queue];
    if (this.inflight) this.finish(this.inflight);
    this.queue = [];
    for (const p of pending) p.reject(new DeviceError('disconnected', reason, p.op));
  }

  /** Scenario-triggered disconnect (fires `onDisconnect`). */
  private drop(reason?: string): void {
    if (!this.opened) return;
    this.shutdown(reason ?? 'Virtual device disconnected');
    if (this.register) releaseSimulatorControl(this.control);
    for (const l of [...this.disconnectListeners]) l(reason);
  }
}
