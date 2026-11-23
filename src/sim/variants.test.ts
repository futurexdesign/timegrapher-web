/** Tests of the virtual board variants: hello identity, `caps.ble` and `getLink.ble`. */
import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';
import { VirtualDevice } from './VirtualDevice';
import { createVirtualTransport, DEFAULT_VIRTUAL_VARIANT, VIRTUAL_VARIANTS } from './index';

/** Builds a device from a variant's options. */
function deviceFor(id: string): VirtualDevice {
  const variant = VIRTUAL_VARIANTS.find((v) => v.id === id);
  if (!variant) throw new Error(`unknown variant ${id}`);
  return new VirtualDevice({ clock: new ManualClock(1000).now, ...variant.options });
}

describe('virtual variants', () => {
  it('the default variant is the USB-only Pico 2', () => {
    expect(DEFAULT_VIRTUAL_VARIANT).toBe('pico2-pcm1808');
    expect(VIRTUAL_VARIANTS.map((v) => v.id)).toContain(DEFAULT_VIRTUAL_VARIANT);
  });

  it('Pico 2 reports its board and has no BLE', () => {
    const d = deviceFor('pico2-pcm1808');
    const hello = d.handle('hello', {});
    expect(hello.board).toBe('Pico2 (virtual)');
    expect(hello.caps.ble).toBeUndefined();
    expect('ble' in hello.caps).toBe(false);
    expect(d.handle('getLink', {}).ble).toBeUndefined();
  });

  it('Pico 2 W reports its board, caps.ble and a getLink.ble block that is off over USB', () => {
    const d = deviceFor('pico2w-pcm1808');
    const hello = d.handle('hello', {});
    expect(hello.board).toBe('Pico2W (virtual)');
    expect(hello.caps.ble).toBe(true);
    const ble = d.handle('getLink', {}).ble;
    expect(ble).toMatchObject({ enabled: false, connected: false, mtu: 23, connIntervalUs: 0 });
    expect(ble?.name).toBe('TG-SIM0');
  });

  it('createVirtualTransport applies the variant beneath explicit options', async () => {
    const t = createVirtualTransport({
      variant: 'pico2w-pcm1808',
      register: false,
      ignorePersisted: true,
    });
    await t.open();
    const hello = await t.request('hello');
    expect(hello.board).toBe('Pico2W (virtual)');
    expect(hello.caps.ble).toBe(true);
    await t.close();
    const override = createVirtualTransport({
      variant: 'pico2w-pcm1808',
      board: 'Custom',
      register: false,
      ignorePersisted: true,
    });
    await override.open();
    expect((await override.request('hello')).board).toBe('Custom (virtual)');
    await override.close();
  });
});
