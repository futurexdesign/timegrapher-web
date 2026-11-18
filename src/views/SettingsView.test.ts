/** Mount tests of SettingsView against the real simulator transport. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { clearPersistedSettings } from '@/sim';
import { useConnectionStore } from '@/stores/connection';
import SettingsView from './SettingsView.vue';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

let wrapper: VueWrapper | null = null;

async function mountView(): Promise<VueWrapper> {
  const w = mount(SettingsView, {
    global: { plugins: [createVuetify({ components, directives })] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

describe('SettingsView', () => {
  beforeEach(() => {
    clearPersistedSettings();
    localStorage.removeItem('timegrapher.devTools');
    setActivePinia(createPinia());
  });
  afterEach(async () => {
    wrapper?.unmount();
    wrapper = null;
    await useConnectionStore().disconnect();
    document.body.innerHTML = '';
  });

  it('renders sections and the simulator panel for the virtual device', async () => {
    await useConnectionStore().connect('virtual');
    wrapper = await mountView();
    const text = document.body.textContent;
    for (const s of [
      'Device info',
      'Performance',
      'Faults',
      'Advanced',
      'Appearance',
      'Simulator',
    ]) {
      expect(text).toContain(s);
    }
    expect(text).toContain('Device mode');
  });

  it('shows the connect prompt when disconnected', async () => {
    wrapper = await mountView();
    expect(document.body.textContent).not.toContain('Appearance');
  });

  it('hides the simulator for non-virtual kinds unless developer tools are on', async () => {
    const c = useConnectionStore();
    await c.connect('virtual');
    wrapper = await mountView();
    expect(document.body.textContent).toContain('Simulator');
    // Emulate a hardware connection: kind changes, hello stays.
    c.kind = 'webhid';
    await flushPromises();
    expect(document.body.textContent).not.toContain('Simulator');
    localStorage.setItem('timegrapher.devTools', 'true');
    wrapper.unmount();
    wrapper = await mountView();
    expect(document.body.textContent).toContain('Simulator');
  });
});
