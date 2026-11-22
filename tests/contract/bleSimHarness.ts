/**
 * BLE implementation of {@link ContractHarness} (BLE_TRANSPORT_TESTS.md §7.1).
 *
 * Runs the real {@link WebBleTransport} against the fake GATT stack
 * (`FakeBluetooth`), whose peripheral side wraps a `VirtualDevice`. Time is
 * driven by fake timers, like the simulator harness. Requests therefore travel
 * the full path: JSON, frame encoder, unpadded ATT writes with latency, device
 * reassembly, the reply as notifications, host reassembly.
 */
import { vi } from 'vitest';
import { FakeBluetooth, FakePeripheral } from '@/transport/fakeBluetooth';
import { WebBleTransport } from '@/transport/WebBleTransport';
import type { Transport } from '@/transport/Transport';
import type { ContractHarness } from './harness';
import { SIM_EXPECTED } from './simHarness';

/** Options of {@link createBleSimHarness}. */
export interface BleSimOptions {
  /** ATT MTU of the fake link (default 185). */
  mtu?: number;
  /** Duration of every GATT write in ms (default 7.5, a typical connection interval). */
  writeLatencyMs?: number;
}

/** A {@link ContractHarness} that can also cut the BLE link. */
export interface BleSimHarness extends ContractHarness {
  /** Drops the link from the device side (fires `gattserverdisconnected`). */
  dropLink(): void;
  /** The fake stack behind the transport (after `create()`). */
  readonly bluetooth: FakeBluetooth | null;
}

/**
 * @param options MTU and write latency.
 * @returns A harness running `WebBleTransport` over the fake GATT stack.
 */
export function createBleSimHarness(options: BleSimOptions = {}): BleSimHarness {
  const mtu = options.mtu ?? 185;
  let transport: Transport | null = null;
  let bluetooth: FakeBluetooth | null = null;
  const peripheral = (): FakePeripheral => {
    if (bluetooth === null) throw new Error('harness not created');
    return bluetooth.peripheral;
  };
  const h: BleSimHarness = {
    name: `ble-sim mtu ${mtu}`,
    expected: SIM_EXPECTED,
    get bluetooth() {
      return bluetooth;
    },
    async create() {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'performance',
          'Date',
        ],
      });
      bluetooth = new FakeBluetooth(
        new FakePeripheral({
          mtu,
          writeLatencyMs: options.writeLatencyMs ?? 7.5,
          deviceOptions: {
            seed: 42,
            mechanical: {
              vph: 28800,
              rateSDay: SIM_EXPECTED.rateSDay,
              beatErrorMs: SIM_EXPECTED.beatErrorMs,
              jitterUs: 20,
              rateWanderSDay: 0,
              amplitudeJitterDeg: 2,
            },
            timebase: { crystalPpm: SIM_EXPECTED.calPpm, driftPpm: 0, walkPpmPerSqrtS: 0 },
            gpsParams: { fixAfterS: 20 },
            signalScaleMax: 50,
          },
        }),
      );
      transport = new WebBleTransport({ bluetooth: bluetooth.api });
      await h.run(transport.open());
      return transport;
    },
    async run<T>(p: Promise<T>): Promise<T> {
      const flag = { settled: false };
      const wrapped = p.finally(() => {
        flag.settled = true;
      });
      wrapped.catch(() => undefined);
      for (let i = 0; i < 400 && !flag.settled; i++) await vi.advanceTimersByTimeAsync(5);
      return p;
    },
    async advance(ms) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    async dispose() {
      // close() awaits stopNotifications, which takes the fake write latency.
      const closing = transport?.close();
      await vi.advanceTimersByTimeAsync(100);
      await closing;
      transport = null;
      bluetooth = null;
      vi.useRealTimers();
    },
    dropLink() {
      peripheral().dropLink();
    },
    attach(kind) {
      peripheral().device.attached = kind;
    },
    setUsbStreaming(on) {
      peripheral().device.setUsbStreaming(on);
    },
    accelerate(x) {
      const d = peripheral().device;
      d.advance();
      d.timeScale = Math.min(1e6, Math.max(0.01, x));
    },
    setFlashBusy(on) {
      const d = peripheral().device;
      d.faults.flashBusy = on;
      d.syncFaults();
    },
  };
  return h;
}
