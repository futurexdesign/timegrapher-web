/**
 * Web Bluetooth implementation of {@link Transport} (BLE_TRANSPORT_PLAN.md
 * §4 and §6.2).
 *
 * The request queue, framing, timeouts, notify dispatch, keepalive and
 * `controlReleased` handling live in {@link FramedTransport}. This class
 * supplies the GATT link only:
 *
 * - `open()` shows the chooser (unless a device is given), connects, finds the
 *   RX / TX / INFO characteristics, checks the negotiated MTU and subscribes
 *   to TX notifications. Notifications are enabled before the first RX write
 *   (§4.3).
 * - Frames are written one GATT operation at a time. {@link FramedTransport}
 *   awaits {@link WebBleTransport.sendFrame} for each frame and queues
 *   requests, so Chrome's "GATT operation already in progress" error cannot
 *   occur from this class. This relies on {@link FramedTransport} sending the
 *   keepalive `ping` through the same queue as every other request.
 * - One frame per ATT value in both directions. The segmented mode of §4.5
 *   (INFO `seg:1`) is supported as a fallback.
 * - Large TX frames (§14.3): when INFO has `txMax`, {@link WebBleTransport.afterOpen}
 *   sends `hello {frameMax: 255}` before `open()` resolves and notification
 *   values up to that size are accepted. Frames the host writes stay at 63
 *   bytes (the device's RX limit). Without `txMax` the limit stays 63.
 *
 * The constructor accepts a `Bluetooth` provider and/or a chosen device so the
 * transport can be tested with the fakes in `fakeBluetooth.ts`.
 */
import {
  BLE_FRAME_MAX,
  BLE_INFO_UUID,
  BLE_MIN_MTU,
  BLE_NAME_PREFIX,
  BLE_RX_UUID,
  BLE_SERVICE_UUID,
  BLE_TX_UUID,
  HID_FRAME_HEADER_BYTES,
  HID_REPORT_BYTES,
} from '@/protocol/constants';
import { DeviceError } from './Transport';
import { FramedTransport, type FramedTransportOptions } from './FramedTransport';

/** Default wait (ms) between INFO re-reads while the MTU is still 23 (§6.2). */
export const DEFAULT_MTU_WAIT_MS = 300;

/** Number of INFO re-reads after the first read (§6.2). */
const MTU_RETRIES = 3;

/** Segment header bit 7: first segment of a frame (§4.5). */
const SEG_START = 0x80;

/** How RX frames are written: with an ATT response (default) or without (§4.3). */
export type BleWriteMode = 'withResponse' | 'withoutResponse';

/** Construction options for {@link WebBleTransport}. */
export interface WebBleTransportOptions extends FramedTransportOptions {
  /** Bluetooth provider (default `navigator.bluetooth`). */
  bluetooth?: Bluetooth;
  /** Pre-chosen device; skips `requestDevice` in `open()`. */
  device?: BluetoothDevice;
  /** RX write method (default `'withResponse'`). */
  writeMode?: BleWriteMode;
  /** Wait between INFO re-reads in ms (default {@link DEFAULT_MTU_WAIT_MS}). */
  mtuWaitMs?: number;
}

/** Parsed INFO characteristic (§4.1). Only the fields the host needs. */
interface LinkInfo {
  /** ATT MTU currently negotiated (23 until the exchange completes). */
  readonly mtu: number;
  /** `true` when the device uses segmented mode (§4.5). */
  readonly segmented: boolean;
  /** Largest `hello.frameMax` the device accepts (§14.3); `0` when INFO has no `txMax`. */
  readonly txMax: number;
}

/**
 * @returns `true` when the browser exposes Web Bluetooth (Chromium, Bluefy,
 *   secure context).
 */
export function isWebBleSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/**
 * Asks the browser whether a Bluetooth radio is usable. Browsers that lack
 * `getAvailability()` (or whose call fails) are treated as available: the
 * chooser then reports the real problem. Without Web Bluetooth the answer is
 * `false`.
 * @returns `true` when the radio is, or may be, available.
 */
export async function isWebBleAvailable(): Promise<boolean> {
  if (!isWebBleSupported()) return false;
  const bt = navigator.bluetooth as Partial<Bluetooth>;
  if (typeof bt.getAvailability !== 'function') return true;
  try {
    return await bt.getAvailability();
  } catch {
    return true;
  }
}

/**
 * Waits `ms` milliseconds (global timers, looked up at call time so fake
 * timers work).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Transport over a real device using Web Bluetooth (GATT). */
export class WebBleTransport extends FramedTransport {
  readonly kind = 'webble' as const;

  private device: BluetoothDevice | null;
  private readonly bluetooth: Bluetooth | undefined;
  private readonly writeMode: BleWriteMode;
  private readonly mtuWaitMs: number;

  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private notifying = false;
  /** Write method chosen once per `open()` by {@link pickWriter} (R-4 fallback). */
  private writer: ((value: Uint8Array<ArrayBuffer>) => Promise<void>) | null = null;
  /** Largest data bytes per ATT write in segmented mode (`mtu - 4`); 0 outside it. */
  private segmentBytes = 0;
  /**
   * Largest notification frame accepted, bytes: 63 until INFO shows `txMax`,
   * then {@link BLE_FRAME_MAX} (set before the `hello` that opts in).
   */
  private frameMax = HID_REPORT_BYTES;
  /** Accumulator for the frame being rebuilt from segments (segmented mode only). */
  private segBuf = new Uint8Array(0);

  /** @param options See {@link WebBleTransportOptions}. */
  constructor(options: WebBleTransportOptions = {}) {
    super(options);
    this.device = options.device ?? null;
    this.bluetooth = options.bluetooth ?? (isWebBleSupported() ? navigator.bluetooth : undefined);
    this.writeMode = options.writeMode ?? 'withResponse';
    this.mtuWaitMs = options.mtuWaitMs ?? DEFAULT_MTU_WAIT_MS;
  }

  /** Name of the chosen device (`BluetoothDevice.name`, e.g. `TG-1A2B`), if any. */
  get productName(): string | undefined {
    return this.device?.name;
  }

  /**
   * Chooses (if needed) and connects the device, validates the link and
   * starts notifications. On any failure the GATT connection is released and
   * the listeners are removed, so a later `open()` starts clean.
   */
  protected async openLink(): Promise<void> {
    const device = this.device ?? (await this.chooseDevice());
    this.device = device;
    try {
      await this.connect(device);
    } catch (e) {
      await this.closeLink();
      throw e;
    }
  }

  /**
   * Opts in to large TX frames (§14.3) when INFO advertised `txMax`: one
   * `hello {frameMax}` through the normal request path. The device answers it
   * with the old frame size, so the reply needs no special handling; the result
   * is not used. A failure (timeout, device error) fails `open()`.
   */
  protected override async afterOpen(): Promise<void> {
    if (this.frameMax <= HID_REPORT_BYTES) return;
    await this.request('hello', { frameMax: this.frameMax });
  }

  /** Stops notifications, removes the listeners and disconnects. Idempotent. */
  protected async closeLink(): Promise<void> {
    const device = this.device;
    const tx = this.tx;
    const wasNotifying = this.notifying;
    this.tx = null;
    this.rx = null;
    this.writer = null;
    this.notifying = false;
    this.segBuf = new Uint8Array(0);
    this.frameMax = HID_REPORT_BYTES;
    if (tx !== null) {
      tx.removeEventListener('characteristicvaluechanged', this.onValueChanged);
      if (wasNotifying && device?.gatt?.connected === true) {
        try {
          await tx.stopNotifications();
        } catch {
          /* link already going away */
        }
      }
    }
    if (device !== null) {
      // Remove before disconnecting: Chrome fires the event for our own disconnect().
      device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      if (device.gatt?.connected === true) device.gatt.disconnect();
    }
  }

  /**
   * Writes one frame to RX and awaits the GATT operation.
   *
   * The shared encoder pads every frame to 63 bytes (the WebHID report size).
   * On BLE the ATT value must be exactly `5 + payloadLen` bytes (§4.3), so the
   * padding is cut here: it would waste airtime and, at the minimum MTU of 66,
   * is the only reason a short frame would not fit one notification.
   * In segmented mode (§4.5) the frame is split into `START`-flagged segments.
   */
  protected async sendFrame(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const rx = this.rx;
    if (rx === null) throw new DeviceError('notOpen', 'Device not open');
    const payloadLen = frame[4] ?? 0;
    const bytes = frame.subarray(0, HID_FRAME_HEADER_BYTES + payloadLen);
    if (this.segmentBytes === 0) {
      await this.write(bytes);
      return;
    }
    for (let off = 0; off < bytes.length; off += this.segmentBytes) {
      const chunk = bytes.subarray(off, off + this.segmentBytes);
      const seg = new Uint8Array(1 + chunk.length);
      seg[0] = off === 0 ? SEG_START : 0;
      seg.set(chunk, 1);
      await this.write(seg);
    }
  }

  /** Issues one GATT write with the method chosen at open. */
  private async write(value: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.writer === null) throw new DeviceError('notOpen', 'Device not open');
    await this.writer(value);
  }

  /**
   * Binds the write method once per `open()` (plan §11, R-4). Bluefy and older
   * Chromium may lack `writeValueWithResponse` / `writeValueWithoutResponse`:
   * the configured method is used when present, else the other one, else the
   * legacy `writeValue`.
   * @throws {DeviceError} `linkUnsupported` when the characteristic has no write method.
   */
  private pickWriter(
    rx: BluetoothRemoteGATTCharacteristic,
  ): (value: Uint8Array<ArrayBuffer>) => Promise<void> {
    const c = rx as Partial<BluetoothRemoteGATTCharacteristic>;
    const withResponse = c.writeValueWithResponse?.bind(rx);
    const withoutResponse = c.writeValueWithoutResponse?.bind(rx);
    const legacy = c.writeValue?.bind(rx);
    const picked =
      (this.writeMode === 'withoutResponse'
        ? (withoutResponse ?? withResponse)
        : (withResponse ?? withoutResponse)) ?? legacy;
    if (picked === undefined) {
      throw new DeviceError(
        'linkUnsupported',
        'This browser cannot write to the BLE characteristic',
      );
    }
    return picked;
  }

  /** Shows the chooser with the §4.2 filters. */
  private async chooseDevice(): Promise<BluetoothDevice> {
    if (this.bluetooth === undefined) {
      throw new DeviceError('notOpen', 'Web Bluetooth is not available');
    }
    const bluetooth = this.bluetooth;
    try {
      try {
        return await bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE_UUID] }, { namePrefix: BLE_NAME_PREFIX }],
          optionalServices: [BLE_SERVICE_UUID],
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'NotFoundError') throw e;
        // R-4: a browser may reject the `namePrefix` filter (e.g. TypeError).
        // Retry once with the service filter only. The retry can itself be
        // refused when the first call consumed the user activation; that error
        // then propagates.
        return await bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE_UUID] }],
          optionalServices: [BLE_SERVICE_UUID],
        });
      }
    } catch (e) {
      // NotFoundError is how Chrome reports a dismissed chooser. The connection
      // store keys its quiet cancel on this exact message.
      if (e instanceof Error && e.name === 'NotFoundError') {
        throw new DeviceError('notOpen', 'No device selected');
      }
      throw new DeviceError('notOpen', e instanceof Error ? e.message : 'Device chooser failed');
    }
  }

  /** Connects, resolves the characteristics, validates INFO and subscribes. */
  private async connect(device: BluetoothDevice): Promise<void> {
    const gatt = device.gatt;
    if (gatt === undefined) throw new DeviceError('notOpen', 'Device has no GATT server');
    try {
      await gatt.connect();
      const service = await gatt.getPrimaryService(BLE_SERVICE_UUID);
      const rx = await service.getCharacteristic(BLE_RX_UUID);
      const tx = await service.getCharacteristic(BLE_TX_UUID);
      const info = await service.getCharacteristic(BLE_INFO_UUID);
      const link = await this.readLinkInfo(info);
      this.segmentBytes = link.segmented ? Math.max(1, link.mtu - 4) : 0;
      this.frameMax = link.txMax > 0 ? Math.min(link.txMax, BLE_FRAME_MAX) : HID_REPORT_BYTES;
      this.writer = this.pickWriter(rx);
      this.rx = rx;
      this.tx = tx;
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      tx.addEventListener('characteristicvaluechanged', this.onValueChanged);
      // Notifications must be on before the first RX write (§4.3).
      await tx.startNotifications();
      this.notifying = true;
    } catch (e) {
      if (e instanceof DeviceError) throw e;
      throw new DeviceError('notOpen', e instanceof Error ? e.message : 'BLE connect failed');
    }
  }

  /**
   * Reads INFO and waits for a usable MTU: the first read can still show 23
   * while the MTU exchange runs. Segmented devices are accepted at any MTU.
   * @throws {DeviceError} `linkUnsupported` when the MTU stays below 66.
   */
  private async readLinkInfo(info: BluetoothRemoteGATTCharacteristic): Promise<LinkInfo> {
    let link = parseInfo(await info.readValue());
    for (let i = 0; i < MTU_RETRIES && link.mtu < BLE_MIN_MTU && !link.segmented; i++) {
      await delay(this.mtuWaitMs);
      link = parseInfo(await info.readValue());
    }
    if (link.mtu < BLE_MIN_MTU && !link.segmented) {
      throw new DeviceError(
        'linkUnsupported',
        `BLE link MTU ${link.mtu} is below ${BLE_MIN_MTU}; this browser/OS cannot run the control plane`,
      );
    }
    return link;
  }

  /** Hands one TX notification to the frame path (or the segment accumulator). */
  private readonly onValueChanged = (): void => {
    const value = this.tx?.value;
    if (value === undefined) return;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (this.segmentBytes === 0) {
      // A value longer than the negotiated frame is invalid (§4.3): drop it.
      if (bytes.length <= this.frameMax) this.onFrame(bytes);
      return;
    }
    this.onSegment(bytes);
  };

  /**
   * Segmented receive (§4.5): a START segment resets the accumulator; the frame
   * is complete once it holds `5 + payloadLen` bytes. A non-START segment with
   * an empty accumulator is dropped.
   */
  private onSegment(seg: Uint8Array): void {
    if (seg.length === 0) return;
    const start = ((seg[0] ?? 0) & SEG_START) !== 0;
    if (!start && this.segBuf.length === 0) return;
    const data = seg.subarray(1);
    const prev = start ? new Uint8Array(0) : this.segBuf;
    const buf = new Uint8Array(prev.length + data.length);
    buf.set(prev, 0);
    buf.set(data, prev.length);
    if (buf.length > this.frameMax) {
      this.segBuf = new Uint8Array(0);
      return;
    }
    if (
      buf.length >= HID_FRAME_HEADER_BYTES &&
      buf.length >= HID_FRAME_HEADER_BYTES + (buf[4] ?? 0)
    ) {
      this.segBuf = new Uint8Array(0);
      this.onFrame(buf);
    } else {
      this.segBuf = buf;
    }
  }

  /** Reports an unexpected GATT disconnect to the base class. */
  private readonly onGattDisconnected = (): void => {
    this.onLinkLost('Device disconnected');
  };
}

/**
 * Parses the INFO value (§4.1, UTF-8 JSON). Unknown keys are ignored.
 * @param value The characteristic value.
 * @throws {DeviceError} `protocol` when the value is not the expected JSON.
 */
function parseInfo(value: DataView): LinkInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    );
  } catch {
    throw new DeviceError('protocol', 'Invalid BLE INFO value');
  }
  const o = parsed as { mtu?: unknown; seg?: unknown; txMax?: unknown } | null;
  if (typeof o !== 'object' || o === null || typeof o.mtu !== 'number') {
    throw new DeviceError('protocol', 'Invalid BLE INFO value');
  }
  const txMax = typeof o.txMax === 'number' && Number.isInteger(o.txMax) ? o.txMax : 0;
  return { mtu: o.mtu, segmented: o.seg === 1, txMax };
}
