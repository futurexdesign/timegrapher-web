<script setup lang="ts">
/**
 * Settings view: device mode, device info, performance, faults and events,
 * advanced (subscriptions + raw console), appearance and the developer
 * Simulator panel. Sections are expansion panels (lazy content, so polling
 * sections only poll while expanded). The Simulator panel shows for the
 * virtual device, or when "Show developer tools" is on (persisted in
 * localStorage). Shows the connect prompt until a device is connected.
 */
import { computed, ref, watch } from 'vue';
import ConnectPrompt from '@/components/ConnectPrompt.vue';
import AdvancedSection from '@/components/settings/AdvancedSection.vue';
import AppearanceSection from '@/components/settings/AppearanceSection.vue';
import DeviceInfoSection from '@/components/settings/DeviceInfoSection.vue';
import DeviceModeSection from '@/components/settings/DeviceModeSection.vue';
import FaultsEventsSection from '@/components/settings/FaultsEventsSection.vue';
import PerformanceSection from '@/components/settings/PerformanceSection.vue';
import SimulatorPanel from '@/components/settings/SimulatorPanel.vue';
import { useConnectionStore } from '@/stores/connection';

/** localStorage key of the developer-tools toggle. */
const DEV_TOOLS_KEY = 'timegrapher.devTools';

const connection = useConnectionStore();

function loadDev(): boolean {
  try {
    return localStorage.getItem(DEV_TOOLS_KEY) === 'true';
  } catch {
    return false;
  }
}
const devTools = ref(loadDev());
watch(devTools, (v) => {
  try {
    localStorage.setItem(DEV_TOOLS_KEY, String(v));
  } catch {
    /* storage unavailable */
  }
});

const showSimulator = computed(() => connection.kind === 'virtual' || devTools.value);
const open = ref<string[]>(['mode', 'info']);
</script>

<template>
  <v-container fluid>
    <ConnectPrompt v-if="!connection.isConnected" title="Settings" />
    <div v-else style="max-width: 960px">
      <h1 class="text-h5 mb-3">Settings</h1>
      <v-expansion-panels v-model="open" multiple>
        <v-expansion-panel v-if="connection.features.deviceMode" value="mode" title="Device mode">
          <v-expansion-panel-text><DeviceModeSection /></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel value="info" title="Device info">
          <v-expansion-panel-text><DeviceInfoSection /></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel value="performance" title="Performance">
          <v-expansion-panel-text><PerformanceSection /></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel value="faults" title="Faults &amp; events">
          <v-expansion-panel-text><FaultsEventsSection /></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel value="advanced" title="Advanced">
          <v-expansion-panel-text>
            <v-switch
              v-model="devTools"
              label="Show developer tools"
              density="compact"
              hide-details
              class="mb-2"
            />
            <AdvancedSection />
          </v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel value="appearance" title="Appearance">
          <v-expansion-panel-text><AppearanceSection /></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel v-if="showSimulator" value="simulator" title="Simulator">
          <v-expansion-panel-text><SimulatorPanel /></v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </div>
  </v-container>
</template>
