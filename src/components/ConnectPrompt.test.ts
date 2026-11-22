/** Mount tests of ConnectPrompt: BLE button and the iOS / Bluefy guidance (UI-01..04, UI-06). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { useConnectionStore } from '@/stores/connection';
import ConnectPrompt from './ConnectPrompt.vue';

const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

/** Navigator properties this file overrides, restored after each test. */
const OVERRIDDEN = [
  'bluetooth',
  'hid',
  'userAgent',
  'platform',
  'maxTouchPoints',
  'clipboard',
] as const;

/** Defines a navigator property for one test. */
function setNav(name: (typeof OVERRIDDEN)[number], value: unknown): void {
  Object.defineProperty(navigator, name, { value, configurable: true });
}

const bluetooth = { getAvailability: () => Promise.resolve(true), addEventListener: vi.fn() };

let wrapper: VueWrapper | null = null;

async function mountPrompt(): Promise<VueWrapper> {
  const w = mount(ConnectPrompt, {
    props: { title: 'Timegrapher' },
    global: { plugins: [createVuetify({ components, directives })] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

/** Visible button labels of the mounted prompt. */
function buttonTexts(w: VueWrapper): string[] {
  return w.findAll('button').map((b) => b.text());
}

describe('ConnectPrompt', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    for (const n of OVERRIDDEN) Reflect.deleteProperty(navigator, n);
  });

  it('UI-01 shows the Bluetooth button and connects over webble', async () => {
    setNav('bluetooth', bluetooth);
    setNav('hid', {});
    wrapper = await mountPrompt();
    const connect = vi.spyOn(useConnectionStore(), 'connect').mockResolvedValue();
    const btn = wrapper.find('[data-testid="connect-ble"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('Real device (Bluetooth)');
    await btn.trigger('click');
    expect(connect).toHaveBeenCalledWith('webble');
  });

  it('UI-02 iOS without Web Bluetooth or WebHID explains Bluefy and copies the link', async () => {
    setNav('userAgent', IPAD_UA);
    setNav('platform', 'MacIntel');
    setNav('maxTouchPoints', 5);
    const writeText = vi.fn(() => Promise.resolve());
    setNav('clipboard', { writeText });
    wrapper = await mountPrompt();
    const guidance = wrapper.find('[data-testid="ios-guidance"]');
    expect(guidance.text()).toContain('Bluefy');
    await wrapper.find('[data-testid="copy-link"]').trigger('click');
    expect(writeText).toHaveBeenCalledWith(location.href);
    expect(buttonTexts(wrapper).join('|')).not.toContain('WebHID');
    expect(wrapper.find('[data-testid="connect-ble"]').exists()).toBe(false);
  });

  it('UI-03 a Bluefy-like browser shows Bluetooth and Simulator, not WebHID', async () => {
    setNav('userAgent', IPAD_UA);
    setNav('platform', 'MacIntel');
    setNav('maxTouchPoints', 5);
    setNav('bluetooth', bluetooth);
    wrapper = await mountPrompt();
    const texts = buttonTexts(wrapper).join('|');
    expect(texts).toContain('Real device (Bluetooth)');
    expect(texts).toContain('Virtual device');
    expect(texts).not.toContain('WebHID');
    expect(wrapper.find('[data-testid="ios-guidance"]').exists()).toBe(false);
  });

  it('UI-04 desktop Chrome shows WebHID, Bluetooth and the simulator', async () => {
    setNav('bluetooth', bluetooth);
    setNav('hid', {});
    wrapper = await mountPrompt();
    const texts = buttonTexts(wrapper).join('|');
    expect(texts).toContain('Real device (WebHID)');
    expect(texts).toContain('Real device (Bluetooth)');
    expect(texts).toContain('Virtual device');
  });

  it('UI-06 the buttons have text names and the guidance is an alert region', async () => {
    setNav('userAgent', IPAD_UA);
    setNav('platform', 'MacIntel');
    setNav('maxTouchPoints', 5);
    wrapper = await mountPrompt();
    const alert = wrapper.find('[data-testid="ios-guidance"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.attributes('aria-live')).toBe('polite');
    for (const b of wrapper.findAll('button')) expect(b.text().length).toBeGreaterThan(0);
  });
});
