/** Mount tests of the app-bar connect menu (UI-05). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import AppBarConnection from './AppBarConnection.vue';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

vi.stubGlobal('visualViewport', {
  width: 1024,
  height: 768,
  scale: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
});

let wrapper: VueWrapper | null = null;

/** Mounts the bar, opens the connect menu and returns the Bluetooth item. */
async function bluetoothItem(): Promise<HTMLElement | undefined> {
  wrapper = mount(AppBarConnection, {
    global: { plugins: [createVuetify({ components, directives })] },
    attachTo: document.body,
  });
  await flushPromises();
  await wrapper.find('button').trigger('click');
  await flushPromises();
  return [...document.body.querySelectorAll<HTMLElement>('.v-list-item')].find((el) =>
    el.textContent.includes('Real device (Bluetooth)'),
  );
}

describe('AppBarConnection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    Reflect.deleteProperty(navigator, 'bluetooth');
    document.body.innerHTML = '';
  });

  it('UI-05 the menu has a Bluetooth item that is disabled without the API', async () => {
    const item = await bluetoothItem();
    expect(item).toBeDefined();
    expect(item?.classList.contains('v-list-item--disabled')).toBe(true);
  });

  it('UI-05 the Bluetooth item is enabled when Web Bluetooth is available', async () => {
    Object.defineProperty(navigator, 'bluetooth', {
      value: { getAvailability: () => Promise.resolve(true), addEventListener: vi.fn() },
      configurable: true,
    });
    const item = await bluetoothItem();
    expect(item).toBeDefined();
    expect(item?.classList.contains('v-list-item--disabled')).toBe(false);
  });
});
