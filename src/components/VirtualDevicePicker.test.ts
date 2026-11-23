/** Mount tests of the virtual-board picker: list, default, remembered choice, actions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { useConnectionStore } from '@/stores/connection';
import VirtualDevicePicker from './VirtualDevicePicker.vue';

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

const STORAGE_KEY = 'timegrapher.virtualVariant';

let wrapper: VueWrapper | null = null;

/** Host that owns the `v-model` so the dialog closes itself as in the app. */
const Host = defineComponent({
  setup() {
    const open = ref(true);
    return () =>
      h(VirtualDevicePicker, {
        modelValue: open.value,
        'onUpdate:modelValue': (v: boolean) => {
          open.value = v;
        },
      });
  },
});

/** Mounts the picker open inside {@link Host} and returns the wrapper. */
async function mountPicker(): Promise<VueWrapper> {
  const w = mount(Host, {
    global: { plugins: [createVuetify({ components, directives })] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

/** Finds an element of the teleported dialog by test id. */
function byId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('VirtualDevicePicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('lists both variants with their descriptions', async () => {
    wrapper = await mountPicker();
    expect(byId('virtual-variant-pico2-pcm1808')?.textContent).toContain('Pico 2 · PCM1808');
    expect(byId('virtual-variant-pico2-pcm1808')?.textContent).toContain('USB only');
    expect(byId('virtual-variant-pico2w-pcm1808')?.textContent).toContain('Pico 2 W · PCM1808');
    expect(byId('virtual-variant-pico2w-pcm1808')?.textContent).toContain('USB + Bluetooth');
  });

  it('Connect uses the default variant and remembers it', async () => {
    const connect = vi.spyOn(useConnectionStore(), 'connect').mockResolvedValue();
    wrapper = await mountPicker();
    byId('virtual-confirm')?.click();
    expect(connect).toHaveBeenCalledWith('virtual', { virtualVariant: 'pico2-pcm1808' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('pico2-pcm1808');
  });

  it('selecting Pico 2 W connects with it, stores it and closes the dialog', async () => {
    const connect = vi.spyOn(useConnectionStore(), 'connect').mockResolvedValue();
    wrapper = await mountPicker();
    byId('virtual-variant-pico2w-pcm1808')?.click();
    await flushPromises();
    byId('virtual-confirm')?.click();
    await flushPromises();
    expect(connect).toHaveBeenCalledWith('virtual', { virtualVariant: 'pico2w-pcm1808' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('pico2w-pcm1808');
    expect(document.body.querySelector('.v-overlay--active')).toBeNull();
  });

  it('preselects the remembered variant and ignores an unknown stored value', async () => {
    localStorage.setItem(STORAGE_KEY, 'pico2w-pcm1808');
    const connect = vi.spyOn(useConnectionStore(), 'connect').mockResolvedValue();
    wrapper = await mountPicker();
    byId('virtual-confirm')?.click();
    expect(connect).toHaveBeenLastCalledWith('virtual', { virtualVariant: 'pico2w-pcm1808' });
    wrapper.unmount();
    localStorage.setItem(STORAGE_KEY, 'bogus');
    wrapper = await mountPicker();
    byId('virtual-confirm')?.click();
    expect(connect).toHaveBeenLastCalledWith('virtual', { virtualVariant: 'pico2-pcm1808' });
  });

  it('Cancel closes without connecting', async () => {
    const connect = vi.spyOn(useConnectionStore(), 'connect').mockResolvedValue();
    wrapper = await mountPicker();
    byId('virtual-cancel')?.click();
    await flushPromises();
    expect(connect).not.toHaveBeenCalled();
    expect(document.body.querySelector('.v-overlay--active')).toBeNull();
  });

  it('still connects when localStorage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const connect = vi.spyOn(useConnectionStore(), 'connect').mockResolvedValue();
    wrapper = await mountPicker();
    byId('virtual-confirm')?.click();
    expect(connect).toHaveBeenCalledWith('virtual', { virtualVariant: 'pico2-pcm1808' });
  });
});
