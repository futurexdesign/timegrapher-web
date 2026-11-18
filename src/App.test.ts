import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import App from './App.vue';
import { routes } from './router';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

describe('App shell', () => {
  it('renders navigation and the disconnected empty state', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/');
    await router.isReady();
    const wrapper = mount(App, {
      global: { plugins: [createPinia(), router, createVuetify({ components, directives })] },
      attachTo: document.body,
    });
    await vi.dynamicImportSettled();
    await wrapper.vm.$nextTick();
    const text = document.body.textContent;
    expect(text).toContain('Disconnected');
    expect(text).toContain('Time Grapher');
    expect(text).toContain('Timebase');
    wrapper.unmount();
  });
});
