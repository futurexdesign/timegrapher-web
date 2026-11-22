/**
 * WebHID implementation of {@link Transport}.
 *
 * The request queue, framing, timeouts, notify dispatch and keepalive live in
 * {@link FramedTransport}; this class supplies only the WebHID link: choosing
 * and opening the `HIDDevice`, writing output reports, and mapping
 * `inputreport` / `disconnect` events onto the base class hooks.
 *
 * The constructor accepts an already-chosen `HIDDevice` and/or an `HID`
 * provider so the transport can be unit-tested with fakes.
 */
import { HID_DEVICE_FILTER, HID_REPORT_ID } from '@/protocol/constants';
import { DeviceError } from './Transport';
import { FramedTransport, type FramedTransportOptions } from './FramedTransport';

export { DEFAULT_REQUEST_TIMEOUT_MS } from './FramedTransport';

/** Construction options for {@link WebHidTransport}. */
export interface WebHidTransportOptions extends FramedTransportOptions {
  /** Pre-chosen device; skips `requestDevice` in `open()`. */
  device?: HIDDevice;
  /** HID provider (default `navigator.hid`). */
  hid?: HID;
}

/**
 * @returns `true` when the browser exposes WebHID (Chromium, secure context).
 */
export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/** Transport over a real device using WebHID. */
export class WebHidTransport extends FramedTransport {
  readonly kind = 'webhid' as const;

  private device: HIDDevice | null;
  private readonly hid: HID | undefined;
  private weOpenedDevice = false;

  /** @param options See {@link WebHidTransportOptions}. */
  constructor(options: WebHidTransportOptions = {}) {
    super(options);
    this.device = options.device ?? null;
    this.hid = options.hid ?? (isWebHidSupported() ? navigator.hid : undefined);
  }

  /** Name of the opened device (`HIDDevice.productName`), if any. */
  get productName(): string | undefined {
    return this.device?.productName;
  }

  /** Chooses (if needed) and opens the device, then subscribes to input reports and unplug events. */
  protected async openLink(): Promise<void> {
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
  }

  /** Removes the listeners and closes the device if this transport opened it. */
  protected async closeLink(): Promise<void> {
    this.device?.removeEventListener('inputreport', this.onInputReport);
    this.hid?.removeEventListener('disconnect', this.onHidDisconnect);
    const device = this.device;
    if (device !== null && this.weOpenedDevice && device.opened) await device.close();
  }

  /** Writes one frame as an output report with the protocol's report id. */
  protected async sendFrame(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const device = this.device;
    if (device === null) throw new DeviceError('notOpen', 'Device not open');
    await device.sendReport(HID_REPORT_ID, frame);
  }

  /** Passes input reports with the protocol's report id to {@link FramedTransport.onFrame}. */
  private readonly onInputReport = (ev: HIDInputReportEvent): void => {
    if (ev.reportId !== HID_REPORT_ID) return;
    this.onFrame(ev.data);
  };

  /** Calls {@link FramedTransport.onLinkLost} when the unplugged HID device is this transport's device. */
  private readonly onHidDisconnect = (ev: Event): void => {
    const dev = (ev as Event & { device?: unknown }).device;
    if (dev === this.device) this.onLinkLost('Device disconnected');
  };
}
