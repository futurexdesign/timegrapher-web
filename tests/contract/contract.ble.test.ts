/**
 * Runs the transport contract suite over BLE (BLE_TRANSPORT_TESTS.md §7.1):
 * `WebBleTransport` against the fake GATT stack and the virtual device.
 */
import { describe, expect, it } from 'vitest';
import { DeviceError } from '@/transport/Transport';
import { createBleSimHarness } from './bleSimHarness';
import { runTransportContract } from './transportContract';

// CT-BLE-01: full contract at a typical negotiated MTU and 7.5 ms per write.
runTransportContract(() => createBleSimHarness({ mtu: 185 }));

// CT-BLE-02: the same suite at the smallest supported MTU (66).
runTransportContract(() => createBleSimHarness({ mtu: 66 }));

// CT-BLE-04: an old device (no txMax, 63-byte frames, no packed beats) still passes it.
runTransportContract(() => createBleSimHarness({ mtu: 185, modern: false }));

// CT-BLE-05: a new device at the widest MTU, so 255-byte frames are in use.
runTransportContract(() => createBleSimHarness({ mtu: 258 }));

describe('ble link behaviour under contract timing', () => {
  it('CT-BLE-03 dropping the link mid-getState rejects with disconnected and disposes cleanly', async () => {
    const h = createBleSimHarness();
    const t = await h.create();
    const reasons: (string | undefined)[] = [];
    t.onDisconnect((r) => reasons.push(r));
    const pending = t.request('getState');
    const outcome = pending.then(
      () => null,
      (e: unknown) => e,
    );
    await h.advance(3); // the first write is still in flight (7.5 ms latency)
    h.dropLink();
    const e = await outcome;
    expect(e).toBeInstanceOf(DeviceError);
    expect((e as DeviceError).code).toBe('disconnected');
    expect(reasons).toEqual(['Device disconnected']);
    await expect(h.dispose()).resolves.toBeUndefined();
  });
});
