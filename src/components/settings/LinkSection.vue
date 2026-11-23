<script setup lang="ts">
/**
 * Link section: how this app is connected (from `hello.link`), who holds
 * control, the USB HID state and, on Bluetooth builds, the BLE radio status
 * and counters (`getLink`). Polled at 1 Hz only while this component is
 * mounted (the panel is expanded) and the browser tab is visible.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useDiagnosticsStore } from '@/stores/diagnostics';

const connection = useConnectionStore();
const diagnostics = useDiagnosticsStore();

const l = computed(() => diagnostics.link);
const ble = computed(() => diagnostics.link?.ble ?? null);
const helloLink = computed(() => connection.hello?.link ?? null);

/** Human names for the HCI disconnect reasons a BLE link usually ends with. */
const DISCONNECT_REASONS: Readonly<Record<number, string>> = {
  0x08: 'supervision timeout',
  0x13: 'closed by the central',
  0x16: 'closed by the stand',
  0x22: 'LMP response timeout',
  0x3b: 'unacceptable connection parameters',
  0x3d: 'MIC failure',
  0x3e: 'failed to establish',
};

/** Labels for `connParamStep` (BLE_TRANSPORT_PLAN.md §14.4). */
const CONN_PARAM_STEPS: readonly string[] = [
  'not requested yet',
  'asked for 15 ms',
  'asked for 15–30 ms (15 ms rejected)',
  'gave up (both rejected)',
];

/**
 * @param reason HCI disconnect reason code.
 * @returns `"none"`, or the hex code with a name when known.
 */
function reasonText(reason: number): string {
  if (reason === 0) return 'none';
  const hex = `0x${reason.toString(16).padStart(2, '0')}`;
  const name = DISCONNECT_REASONS[reason];
  return name ? `${hex} (${name})` : hex;
}

const ownerText = computed(() => {
  const c = l.value?.control;
  if (!c) return '';
  if (c.owner === null) return 'nobody';
  return c.self ? `${c.owner} (this app)` : `${c.owner} (another app)`;
});

const stats = computed(() => {
  const b = ble.value;
  if (!b) return [];
  return [
    { label: 'RX frames', value: b.rxFrames },
    { label: 'TX frames', value: b.txFrames },
    { label: 'RX dropped', value: b.rxDropped, warn: b.rxDropped > 0 },
    { label: 'RX invalid', value: b.rxInvalid, warn: b.rxInvalid > 0 },
    { label: 'TX retries', value: b.txRetries },
    { label: 'Disconnects', value: b.disconnects },
  ];
});

let polling = false;

function start(): void {
  if (polling) return;
  polling = true;
  diagnostics.startLinkPolling();
}
function stop(): void {
  if (!polling) return;
  polling = false;
  diagnostics.stopLinkPolling();
}
function onVisibility(): void {
  if (document.hidden) stop();
  else start();
}
onMounted(() => {
  if (!document.hidden) start();
  document.addEventListener('visibilitychange', onVisibility);
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  stop();
});
</script>

<template>
  <div data-testid="link">
    <v-row dense>
      <v-col cols="6" sm="3">
        <div class="text-caption text-medium-emphasis">This connection</div>
        <div class="text-body-1" data-testid="link-kind">
          {{ helloLink?.kind === 'ble' ? 'Bluetooth' : 'USB HID' }}
        </div>
      </v-col>
      <v-col v-if="helloLink?.frameMax" cols="6" sm="3">
        <div class="text-caption text-medium-emphasis">Frame size (to app)</div>
        <div class="text-body-1">{{ helloLink.frameMax }} B</div>
      </v-col>
      <v-col cols="6" sm="3">
        <div class="text-caption text-medium-emphasis">Control held by</div>
        <div class="text-body-1" data-testid="link-owner">{{ ownerText || '…' }}</div>
      </v-col>
      <v-col cols="6" sm="3">
        <div class="text-caption text-medium-emphasis">USB HID</div>
        <div class="text-body-1">
          {{ l ? (l.usbHid.mounted ? 'mounted' : 'not mounted') : '…' }}
        </div>
      </v-col>
    </v-row>

    <template v-if="ble">
      <v-divider class="my-3" />
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <span class="text-subtitle-2">Bluetooth</span>
        <v-chip size="small" label :color="ble.enabled ? 'success' : undefined">
          {{ ble.enabled ? 'on' : 'off' }}
        </v-chip>
        <v-chip
          v-if="ble.connected"
          size="small"
          label
          color="primary"
          prepend-icon="mdi-bluetooth-connect"
        >
          connected
        </v-chip>
        <v-chip v-else-if="ble.advertising" size="small" label prepend-icon="mdi-bluetooth">
          advertising
        </v-chip>
        <span class="text-caption text-medium-emphasis" data-testid="link-ble-name">
          {{ ble.name }} · {{ ble.address }} · radio on core {{ ble.core }}
        </span>
      </div>
      <v-row dense>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">ATT MTU</div>
          <div class="text-body-1">{{ ble.mtu }}</div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">Connection interval</div>
          <div class="text-body-1" data-testid="link-interval">
            {{ ble.connIntervalUs ? `${(ble.connIntervalUs / 1000).toFixed(2)} ms` : '—' }}
          </div>
        </v-col>
        <v-col v-if="ble.connParamStep !== undefined" cols="12" sm="6">
          <div class="text-caption text-medium-emphasis">Interval request</div>
          <div class="text-body-1">
            {{ CONN_PARAM_STEPS[ble.connParamStep] ?? ble.connParamStep }}
            <span v-if="ble.connParamRejects" class="text-warning">
              · {{ ble.connParamRejects }} rejected
            </span>
          </div>
        </v-col>
        <v-col v-for="s in stats" :key="s.label" cols="4" sm="2">
          <div class="text-caption text-medium-emphasis">{{ s.label }}</div>
          <div class="text-body-1" :class="{ 'text-warning': s.warn }">{{ s.value }}</div>
        </v-col>
        <v-col cols="12" sm="6">
          <div class="text-caption text-medium-emphasis">Last disconnect</div>
          <div class="text-body-1" data-testid="link-reason">
            {{ reasonText(ble.lastDisconnectReason) }}
          </div>
        </v-col>
        <v-col v-if="ble.core1StackFree !== undefined" cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">Core 1 stack free</div>
          <div class="text-body-1" :class="{ 'text-warning': ble.core1StackFree < 2048 }">
            {{ ble.core1StackFree }} B
          </div>
        </v-col>
      </v-row>
    </template>
    <div v-else-if="l" class="text-caption text-medium-emphasis mt-2">
      This build has no Bluetooth.
    </div>
  </div>
</template>
