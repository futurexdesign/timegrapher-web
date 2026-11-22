/**
 * Fake Web Bluetooth stack for tests (BLE_TRANSPORT_PLAN.md §6.1, W2).
 *
 * Provides {@link FakeBluetooth}, {@link FakeBluetoothDevice},
 * {@link FakeGattServer} and {@link FakeCharacteristic}, which stand in for
 * `navigator.bluetooth` and its GATT objects, and {@link FakePeripheral}, the
 * device side behind them. The peripheral wraps a `VirtualDevice`: it
 * reassembles RX writes with the app's `FrameReassembler`, executes the
 * request, and sends the reply (and `pollNotify()` output) back as
 * **unpadded** notification values built with `FrameEncoder`, like the
 * firmware does (§4.3).
 *
 * The fake reproduces the Chrome behaviours the transport depends on:
 *
 * - one GATT operation in flight per connection: a second concurrent read,
 *   write or (un)subscribe throws `NetworkError: GATT operation already in
 *   progress.` and is counted in {@link FakePeripheral.overlapErrors};
 * - notifications reach the page only after `startNotifications()`;
 * - `gatt.disconnect()` also fires `gattserverdisconnected`;
 * - a configurable MTU (reflected in INFO and `hello.link.mtu`), per-write
 *   latency, a "drop link" switch and "fail next write".
 *
 * Test support only: nothing in the app imports this module. The cast from
 * the fakes to the DOM types is confined to {@link FakeBluetooth.api} and
 * {@link FakeBluetoothDevice.api}.
 */
import { HID_REPORT_BYTES } from '@/protocol/constants';
import { FrameEncoder, FrameReassembler, FrameTooLargeError } from '@/protocol/framer';
import type { HidErrorCode, HidHelloResult } from '@/protocol/types';
import { VirtualDevice, type VirtualDeviceOptions } from '@/sim/VirtualDevice';
import { BLE_INFO_UUID, BLE_RX_UUID, BLE_SERVICE_UUID, BLE_TX_UUID } from '@/protocol/constants';
import { DeviceError } from './Transport';

/** Largest reply the device sends (§4.3: 2048-byte message cap). */
const REPLY_CAP_BYTES = 2048;
/** Segment header bit 7: first segment of a frame (§4.5). */
const SEG_START = 0x80;
/** Header bytes before the payload of one frame. */
const FRAME_HEADER_BYTES = 5;

/** Options of {@link FakePeripheral}. */
export interface FakePeripheralOptions {
  /** Device behind the fake. Default: a new `VirtualDevice` reporting a BLE link. */
  device?: VirtualDevice;
  /** Options for the default device (ignored when `device` is given). */
  deviceOptions?: VirtualDeviceOptions;
  /** Negotiated ATT MTU reported by INFO (default 185). */
  mtu?: number;
  /** Segmented mode, INFO `seg:1` (§4.5; default false). */
  segmented?: boolean;
  /** Duration of every read, write and (un)subscribe in ms (default 0). */
  writeLatencyMs?: number;
  /** Spacing between the notifications of one reply in ms (default 0). */
  notifyIntervalMs?: number;
  /** Notify poll period in ms while a subscription is active; 0 disables polling (default 10). */
  pollMs?: number;
  /** Advertised name (default `TG-1A2B`). */
  name?: string;
}

/** Minimal listener registry with counting, standing in for `EventTarget`. */
class Emitter {
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>();

  /** Registers `cb` for `type` (a repeated registration is ignored, like `EventTarget`). */
  addEventListener(type: string, cb: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  /** Removes `cb` for `type`. */
  removeEventListener(type: string, cb: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  /** Calls every listener of `type` with a new event. */
  dispatch(type: string): void {
    const ev = new Event(type);
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev);
  }

  /** @returns The number of listeners currently registered for `type`. */
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/**
 * JSON replacer that rounds numbers to 6 significant digits, like the
 * firmware's `%.6g` output. The simulator sizes list replies with the same
 * rule, so without it the reply would exceed the 2048-byte cap.
 */
function sixSig(_key: string, v: unknown): unknown {
  return typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(6)) : v;
}

/** @returns A `NetworkError`, the DOM exception Chrome uses for GATT failures. */
function networkError(message: string): DOMException {
  return new DOMException(message, 'NetworkError');
}

/** The device side: GATT database content, request execution, logs and fault switches. */
export class FakePeripheral {
  /** Device executing the requests. */
  readonly device: VirtualDevice;
  /** Advertised name. */
  readonly name: string;
  /** ATT MTU reported by INFO and `hello.link.mtu`. */
  mtu: number;
  /** Segmented mode flag reported by INFO. */
  segmented: boolean;
  /** Duration of every GATT operation (ms). */
  writeLatencyMs: number;
  /** Spacing between the notifications of one reply (ms). */
  notifyIntervalMs: number;
  /** When `false`, requests are recorded but not answered. */
  autoReply = true;
  /**
   * MTU values returned by successive INFO reads, consumed in order; once
   * empty, reads return {@link FakePeripheral.mtu}.
   */
  infoMtuScript: number[] = [];

  /** Ordered log of GATT-level events (`connect`, `getPrimaryService`, `read:info`, ...). */
  readonly log: string[] = [];
  /** Copies of every value written to RX, in order. */
  readonly rxWrites: Uint8Array[] = [];
  /** Parsed requests received from the host, in order. */
  readonly requests: { id: number; op: string }[] = [];
  /** Number of INFO reads. */
  infoReads = 0;
  /** Number of second-concurrent-operation errors thrown (should stay 0). */
  overlapErrors = 0;
  /** RX values dropped as invalid (longer than 63 bytes). */
  rxDropped = 0;

  private readonly pollMs: number;
  private readonly encoder = new FrameEncoder();
  private reassembler = new FrameReassembler();
  private segBuf = new Uint8Array(0);
  private failNext: string | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private server: FakeGattServer | null = null;

  /** @param options See {@link FakePeripheralOptions}. */
  constructor(options: FakePeripheralOptions = {}) {
    this.mtu = options.mtu ?? 185;
    this.device =
      options.device ??
      new VirtualDevice({ ...options.deviceOptions, linkKind: 'ble', linkMtu: this.mtu });
    this.name = options.name ?? 'TG-1A2B';
    this.segmented = options.segmented ?? false;
    this.writeLatencyMs = options.writeLatencyMs ?? 0;
    this.notifyIntervalMs = options.notifyIntervalMs ?? 0;
    this.pollMs = options.pollMs ?? 10;
  }

  /** Makes the next RX write reject with a DOM exception named `name` (default `NetworkError`). */
  failNextWrite(name = 'NetworkError'): void {
    this.failNext = name;
  }

  /** Drops the link as if the device went out of range: fires `gattserverdisconnected`. */
  dropLink(): void {
    this.log.push('drop');
    this.server?.linkDown(true);
  }

  /** @returns `true` while a host is connected. */
  get connected(): boolean {
    return this.server?.connected === true;
  }

  /** @returns The connection's TX characteristic, once a host connected. */
  get tx(): FakeCharacteristic | undefined {
    return this.server?.characteristic(BLE_TX_UUID);
  }

  /**
   * Sends one object to the host as notifications (a pushed notify or a reply).
   * @param obj JSON-serialisable message.
   */
  sendObject(obj: unknown): void {
    let frames: Uint8Array[];
    const wire: unknown = JSON.parse(JSON.stringify(obj, sixSig));
    try {
      frames = this.encoder.encode(wire, REPLY_CAP_BYTES);
    } catch (e) {
      if (!(e instanceof FrameTooLargeError)) throw e;
      const id = (obj as { id?: unknown }).id;
      frames = this.encoder.encode(
        {
          v: 1,
          id,
          ok: false,
          error: { code: 'tooLarge', message: 'reply too large' },
        },
        REPLY_CAP_BYTES,
      );
    }
    frames.forEach((f, i) => {
      // Unpadded, like the firmware (§4.3).
      this.notifyFrame(f.subarray(0, FRAME_HEADER_BYTES + (f[4] ?? 0)), i);
    });
  }

  /**
   * Sends one raw value as a notification (for invalid or partial data). Dropped
   * unless the host subscribed.
   * @param bytes The ATT value.
   * @param delayMs Delay before delivery (default 0).
   */
  notifyRaw(bytes: Uint8Array, delayMs = 0): void {
    setTimeout(() => {
      this.deliver(bytes);
    }, delayMs);
  }

  // --- called by the GATT server fake ---------------------------------------------

  /** @internal Attaches the connection object. */
  attach(server: FakeGattServer): void {
    this.server = server;
  }

  /** @internal Builds the next INFO value (§4.1). */
  nextInfo(): DataView<ArrayBuffer> {
    this.infoReads++;
    const mtu = this.infoMtuScript.shift() ?? this.mtu;
    const json = JSON.stringify({
      p: 1,
      mtu,
      fmax: Math.min(63, mtu - 3),
      seg: this.segmented ? 1 : 0,
    });
    const bytes = new TextEncoder().encode(json);
    return new DataView(bytes.buffer);
  }

  /**
   * @internal Receives one RX write. Throws the armed failure instead of
   * delivering, if any.
   */
  receive(value: Uint8Array): void {
    if (this.failNext !== null) {
      const name = this.failNext;
      this.failNext = null;
      throw new DOMException('GATT write failed', name);
    }
    this.rxWrites.push(value.slice());
    if (value.length > HID_REPORT_BYTES) {
      this.rxDropped++;
      return;
    }
    const frame = this.segmented ? this.acceptSegment(value) : value;
    if (frame === null) return;
    const res = this.reassembler.push(frame);
    if (res.kind === 'message') this.execute(res.message);
  }

  /** @internal Called when the notification subscription changes. */
  notifyingChanged(on: boolean): void {
    if (this.poller !== null) clearInterval(this.poller);
    this.poller = null;
    if (!on || this.pollMs <= 0) return;
    this.poller = setInterval(() => {
      if (!this.device.wantsPolling) return;
      const n = this.device.pollNotify();
      if (n !== null) this.sendObject(n);
    }, this.pollMs);
  }

  /** @internal Resets the peripheral's per-connection state after a link loss. */
  linkLost(): void {
    this.notifyingChanged(false);
    this.reassembler = new FrameReassembler();
    this.segBuf = new Uint8Array(0);
    // The firmware clears the handler's subscriptions when the link goes down (§4.4).
    try {
      this.device.handle('subscribe', { metricsHz: 0, beatHz: 0, timingHz: 0, quartzHz: 0 });
    } catch {
      /* nothing to clear */
    }
  }

  // --- internals -------------------------------------------------------------------

  /** Segmented receive (§4.5): returns the completed frame, or `null`. */
  private acceptSegment(seg: Uint8Array): Uint8Array | null {
    if (seg.length === 0) return null;
    const start = ((seg[0] ?? 0) & SEG_START) !== 0;
    if (!start && this.segBuf.length === 0) return null;
    const prev = start ? new Uint8Array(0) : this.segBuf;
    const buf = new Uint8Array(prev.length + seg.length - 1);
    buf.set(prev, 0);
    buf.set(seg.subarray(1), prev.length);
    if (buf.length >= FRAME_HEADER_BYTES && buf.length >= FRAME_HEADER_BYTES + (buf[4] ?? 0)) {
      this.segBuf = new Uint8Array(0);
      return buf;
    }
    this.segBuf = buf;
    return null;
  }

  /** Runs one reassembled request and sends the reply. */
  private execute(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const { id, op } = msg as { id?: unknown; op?: unknown };
    if (typeof id !== 'number' || typeof op !== 'string') return;
    const body: Record<string, unknown> = { ...msg };
    delete body.v;
    delete body.id;
    delete body.op;
    this.requests.push({ id, op });
    if (!this.autoReply) return;
    try {
      // The op name comes from the wire, so the typed overloads cannot be used.
      const handle = this.device.handle.bind(this.device) as (o: string, b: object) => unknown;
      const result = handle(op, body);
      if (op === 'hello') this.patchHello(result as HidHelloResult);
      this.sendObject({ v: 1, id, ok: true, result });
    } catch (e) {
      const code: HidErrorCode = e instanceof DeviceError ? (e.code as HidErrorCode) : 'internal';
      const message = e instanceof Error ? e.message : String(e);
      this.sendObject({ v: 1, id, ok: false, error: { code, message } });
    }
  }

  /** Makes `hello.link.mtu` follow the (possibly changed) fake MTU. */
  private patchHello(hello: HidHelloResult): void {
    if (hello.link?.kind === 'ble') hello.link.mtu = this.mtu;
  }

  /** Splits one frame into segments in segmented mode and schedules delivery. */
  private notifyFrame(frame: Uint8Array, index: number): void {
    const at = index * this.notifyIntervalMs;
    if (!this.segmented) {
      this.notifyRaw(frame, at);
      return;
    }
    const per = Math.max(1, this.mtu - 4);
    for (let off = 0; off < frame.length; off += per) {
      const chunk = frame.subarray(off, off + per);
      const seg = new Uint8Array(1 + chunk.length);
      seg[0] = off === 0 ? SEG_START : 0;
      seg.set(chunk, 1);
      this.notifyRaw(seg, at);
    }
  }

  /** Delivers one value to the host if it is connected and subscribed. */
  private deliver(bytes: Uint8Array): void {
    const server = this.server;
    const tx = server?.characteristic(BLE_TX_UUID);
    if (server?.connected !== true || tx?.notifying !== true) return;
    tx.setValue(bytes);
  }
}

/** Fake GATT characteristic of the Timegrapher Control service. */
export class FakeCharacteristic extends Emitter {
  /** Last value read or notified. */
  value: DataView<ArrayBuffer> | undefined;
  /** `true` between `startNotifications()` and `stopNotifications()`. */
  notifying = false;

  /**
   * @param uuid Characteristic UUID.
   * @param server Owning connection.
   * @param peripheral Device side.
   */
  constructor(
    readonly uuid: string,
    private readonly server: FakeGattServer,
    private readonly peripheral: FakePeripheral,
  ) {
    super();
  }

  /** Reads INFO (the only readable characteristic). */
  async readValue(): Promise<DataView<ArrayBuffer>> {
    return this.server.operation('read:info', () => {
      if (this.uuid !== BLE_INFO_UUID) throw networkError('Read not permitted.');
      const v = this.peripheral.nextInfo();
      this.value = v;
      return v;
    });
  }

  /** Writes one value to RX with a response. */
  async writeValueWithResponse(value: BufferSource): Promise<void> {
    await this.write('write', value);
  }

  /** Writes one value to RX without a response. */
  async writeValueWithoutResponse(value: BufferSource): Promise<void> {
    await this.write('writeNoResponse', value);
  }

  /** Enables notifications on TX. */
  async startNotifications(): Promise<this> {
    await this.server.operation('startNotifications', () => {
      this.notifying = true;
      this.peripheral.notifyingChanged(true);
    });
    return this;
  }

  /** Disables notifications on TX. */
  async stopNotifications(): Promise<this> {
    await this.server.operation('stopNotifications', () => {
      this.notifying = false;
      this.peripheral.notifyingChanged(false);
    });
    return this;
  }

  /** @internal Delivers a notification value and fires `characteristicvaluechanged`. */
  setValue(bytes: Uint8Array): void {
    this.value = new DataView(bytes.slice().buffer);
    this.dispatch('characteristicvaluechanged');
  }

  private async write(kind: string, value: BufferSource): Promise<void> {
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    await this.server.operation(kind, () => {
      if (this.uuid !== BLE_RX_UUID) throw networkError('Write not permitted.');
      this.peripheral.receive(bytes);
    });
  }
}

/** Fake primary service holding RX, TX and INFO. */
class FakeService {
  constructor(private readonly server: FakeGattServer) {}

  /** Finds a characteristic by UUID. @throws NotFoundError for an unknown UUID. */
  getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
    this.server.log(`getCharacteristic:${uuid}`);
    const c = this.server.characteristic(uuid);
    return c === undefined
      ? Promise.reject(new DOMException('No characteristics found.', 'NotFoundError'))
      : Promise.resolve(c);
  }
}

/** Fake GATT server (one connection) with Chrome's single-operation-in-flight rule. */
export class FakeGattServer {
  /** `true` after `connect()` and before a disconnect or drop. */
  connected = false;
  /**
   * Test hook, called with the RX characteristic of every new connection, to
   * hide or replace its write methods (older browsers lack some of them).
   */
  onConnect: ((rx: FakeCharacteristic) => void) | undefined;

  private busy = false;
  private chars = new Map<string, FakeCharacteristic>();
  private readonly waiters = new Set<() => void>();

  /**
   * @param device Owning device (receives `gattserverdisconnected`).
   * @param peripheral Device side.
   */
  constructor(
    private readonly device: FakeBluetoothDevice,
    private readonly peripheral: FakePeripheral,
  ) {
    peripheral.attach(this);
  }

  /** Connects and creates fresh characteristics, as a new GATT session does. */
  connect(): Promise<this> {
    this.log('connect');
    this.connected = true;
    this.busy = false;
    this.chars = new Map(
      [BLE_RX_UUID, BLE_TX_UUID, BLE_INFO_UUID].map((u) => [
        u,
        new FakeCharacteristic(u, this, this.peripheral),
      ]),
    );
    const rx = this.chars.get(BLE_RX_UUID);
    if (rx !== undefined) this.onConnect?.(rx);
    return Promise.resolve(this);
  }

  /** Disconnects. Like Chrome, this also fires `gattserverdisconnected`. */
  disconnect(): void {
    this.log('disconnect');
    this.linkDown(true);
  }

  /** Finds the Timegrapher Control service. @throws NotFoundError for another UUID. */
  getPrimaryService(uuid: string): Promise<FakeService> {
    this.log('getPrimaryService');
    if (!this.connected) return Promise.reject(networkError('GATT Server is disconnected.'));
    return uuid === BLE_SERVICE_UUID
      ? Promise.resolve(new FakeService(this))
      : Promise.reject(new DOMException('No Services matching UUID found.', 'NotFoundError'));
  }

  /** @returns The current value of `connected`. */
  private get isUp(): boolean {
    return this.connected;
  }

  /** @returns The characteristic of the current connection, if any. */
  characteristic(uuid: string): FakeCharacteristic | undefined {
    return this.chars.get(uuid);
  }

  /** @internal Appends to the peripheral's event log. */
  log(entry: string): void {
    this.peripheral.log.push(entry);
  }

  /**
   * @internal Runs one GATT operation: rejects on overlap (`NetworkError`),
   * waits the configured latency, then runs `action`. A link loss during the
   * wait rejects it.
   */
  async operation<T>(name: string, action: () => T): Promise<T> {
    if (!this.connected) throw networkError('GATT Server is disconnected.');
    if (this.busy) {
      this.peripheral.overlapErrors++;
      throw networkError('GATT operation already in progress.');
    }
    this.busy = true;
    this.log(name);
    try {
      if (this.peripheral.writeLatencyMs > 0) await this.wait(this.peripheral.writeLatencyMs);
      // `connected` may have changed while waiting (a getter defeats TS narrowing).
      if (!this.isUp) throw networkError('GATT Server is disconnected.');
      return action();
    } finally {
      this.busy = false;
    }
  }

  /** @internal Marks the link down, aborts waiting operations and fires the event. */
  linkDown(fire: boolean): void {
    if (!this.connected) return;
    this.connected = false;
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
    for (const c of this.chars.values()) c.notifying = false;
    this.peripheral.linkLost();
    if (fire) this.device.dispatch('gattserverdisconnected');
  }

  /** Waits `ms`; a link loss rejects the wait at once. */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(abort);
        resolve();
      }, ms);
      const abort = (): void => {
        clearTimeout(timer);
        reject(networkError('GATT Server is disconnected.'));
      };
      this.waiters.add(abort);
    });
  }
}

/** Fake `BluetoothDevice`. */
export class FakeBluetoothDevice extends Emitter {
  /** Advertised name. */
  readonly name: string;
  /** Connection object. */
  readonly gatt: FakeGattServer;

  /** @param peripheral Device side. */
  constructor(readonly peripheral: FakePeripheral) {
    super();
    this.name = peripheral.name;
    this.gatt = new FakeGattServer(this, peripheral);
  }

  /**
   * @returns This fake typed as the DOM `BluetoothDevice`. The fake implements
   *   the subset the transport uses; the cast is the single trust point.
   */
  get api(): BluetoothDevice {
    return this as unknown as BluetoothDevice;
  }
}

/** Fake `navigator.bluetooth`. */
export class FakeBluetooth {
  /** The device the chooser returns. */
  readonly device: FakeBluetoothDevice;
  /** Options of every `requestDevice` call. */
  readonly requestDeviceCalls: RequestDeviceOptions[] = [];
  /** When `true`, the chooser is dismissed (`NotFoundError`). */
  chooserCancelled = false;
  /** Result of `getAvailability()`. */
  available = true;

  /** @param peripheral Device side (default: a new {@link FakePeripheral}). */
  constructor(peripheral: FakePeripheral = new FakePeripheral()) {
    this.device = new FakeBluetoothDevice(peripheral);
  }

  /** @returns The device side. */
  get peripheral(): FakePeripheral {
    return this.device.peripheral;
  }

  /** Records the options and returns the device, or rejects when cancelled. */
  requestDevice(options: RequestDeviceOptions): Promise<FakeBluetoothDevice> {
    this.requestDeviceCalls.push(options);
    return this.chooserCancelled
      ? Promise.reject(
          new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'),
        )
      : Promise.resolve(this.device);
  }

  /** @returns The configured availability. */
  getAvailability(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  /** @returns This fake typed as the DOM `Bluetooth` (see {@link FakeBluetoothDevice.api}). */
  get api(): Bluetooth {
    return this as unknown as Bluetooth;
  }
}
