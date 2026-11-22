/** Mount tests of the takeover dialog (§6.3a wording and actions; OWN-02..04 UI side). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { useConnectionStore } from '@/stores/connection';
import TakeoverDialog from './TakeoverDialog.vue';

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

async function mountDialog(): Promise<VueWrapper> {
  const w = mount(TakeoverDialog, {
    global: { plugins: [createVuetify({ components, directives })] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

/** Text of the open dialog (Vuetify teleports it to the body). */
function dialogText(): string {
  return document.body.querySelector('[data-testid="takeover-dialog"]')?.textContent ?? '';
}

describe('TakeoverDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
  });

  it('is closed without a request', async () => {
    wrapper = await mountDialog();
    expect(dialogText()).toBe('');
  });

  it('names USB and offers Take over and Cancel', async () => {
    const store = useConnectionStore();
    store.takeoverRequest = { owner: 'usbHid', phase: 'connect' };
    wrapper = await mountDialog();
    expect(dialogText()).toContain(
      'This stand is being controlled over USB by another app. Take over?',
    );
    expect(document.body.querySelector('[data-testid="takeover-confirm"]')?.textContent).toContain(
      'Take over',
    );
    expect(document.body.querySelector('[data-testid="takeover-cancel"]')?.textContent).toContain(
      'Cancel',
    );
  });

  it('names Bluetooth for a BLE owner and stays generic for an unknown one', async () => {
    const store = useConnectionStore();
    store.takeoverRequest = { owner: 'ble', phase: 'busy' };
    wrapper = await mountDialog();
    expect(dialogText()).toContain('controlled over Bluetooth by another app');
    store.takeoverRequest = { owner: null, phase: 'busy' };
    await flushPromises();
    expect(dialogText()).toContain('This stand is being controlled by another app. Take over?');
  });

  it('the buttons call confirmTakeover and cancelTakeover', async () => {
    const store = useConnectionStore();
    const confirm = vi.spyOn(store, 'confirmTakeover').mockResolvedValue();
    const cancel = vi.spyOn(store, 'cancelTakeover').mockResolvedValue();
    store.takeoverRequest = { owner: 'usbHid', phase: 'connect' };
    wrapper = await mountDialog();
    document.body.querySelector<HTMLElement>('[data-testid="takeover-confirm"]')?.click();
    document.body.querySelector<HTMLElement>('[data-testid="takeover-cancel"]')?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
