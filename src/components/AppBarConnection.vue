<script setup lang="ts">
/**
 * App-bar controls: connection status chip (with device board / firmware),
 * connect menu (WebHID, Web Bluetooth or virtual device, which opens a board
 * picker), disconnect button, the light / dark / system theme toggle and the
 * takeover dialog (mounted here because this component lives for the whole
 * session).
 */
import { computed, ref } from 'vue';
import TakeoverDialog from '@/components/TakeoverDialog.vue';
import VirtualDevicePicker from '@/components/VirtualDevicePicker.vue';
import { useConnectionStore } from '@/stores/connection';
import { useThemeStore, type ThemePreference } from '@/stores/theme';

const connection = useConnectionStore();
const themeStore = useThemeStore();

/** Visibility of the virtual-board picker. */
const pickerOpen = ref(false);

const chip = computed(() => {
  switch (connection.status) {
    case 'connected':
      return {
        color: 'success',
        icon: connection.kind === 'webble' ? 'mdi-bluetooth' : 'mdi-usb',
        text: `${connection.kind === 'virtual' ? 'Virtual' : 'Connected'} · ${connection.deviceLabel}`,
      };
    case 'connecting':
    case 'needsTakeover':
      return { color: 'warning', icon: 'mdi-progress-clock', text: 'Connecting…' };
    default:
      return { color: undefined, icon: 'mdi-usb-port', text: 'Disconnected' };
  }
});

const themeIcons: Record<ThemePreference, string> = {
  light: 'mdi-weather-sunny',
  dark: 'mdi-weather-night',
  system: 'mdi-theme-light-dark',
};
const themeOrder: ThemePreference[] = ['light', 'dark', 'system'];

/** Cycles light -> dark -> system (App.vue applies the resolved theme). */
function cycleTheme(): void {
  const next = themeOrder[(themeOrder.indexOf(themeStore.preference) + 1) % themeOrder.length];
  themeStore.setPreference(next ?? 'system');
}
</script>

<template>
  <v-chip :color="chip.color" :prepend-icon="chip.icon" class="mr-2" label size="small">
    {{ chip.text }}
  </v-chip>

  <v-menu v-if="!connection.isConnected">
    <template #activator="{ props: menu }">
      <v-btn
        v-bind="menu"
        prepend-icon="mdi-connection"
        :disabled="connection.status !== 'disconnected'"
        variant="tonal"
      >
        Connect
      </v-btn>
    </template>
    <v-list>
      <v-tooltip
        :disabled="connection.webHidAvailable"
        text="WebHID is unavailable: use Chrome or Edge over HTTPS or localhost"
        location="left"
      >
        <template #activator="{ props: tip }">
          <div v-bind="tip">
            <v-list-item
              prepend-icon="mdi-usb"
              title="Real device (WebHID)"
              :disabled="!connection.webHidAvailable"
              @click="connection.connect('webhid')"
            />
          </div>
        </template>
      </v-tooltip>
      <v-tooltip
        :disabled="connection.webBleAvailable"
        text="Web Bluetooth is unavailable: use Chrome or Edge (or Bluefy on iPhone and iPad) with Bluetooth on"
        location="left"
      >
        <template #activator="{ props: tip }">
          <div v-bind="tip">
            <v-list-item
              prepend-icon="mdi-bluetooth"
              title="Real device (Bluetooth)"
              :disabled="!connection.webBleAvailable"
              @click="connection.connect('webble')"
            />
          </div>
        </template>
      </v-tooltip>
      <v-list-item
        prepend-icon="mdi-test-tube"
        title="Virtual device"
        data-testid="connect-virtual"
        @click="pickerOpen = true"
      />
    </v-list>
  </v-menu>
  <v-btn v-else prepend-icon="mdi-power-plug-off" @click="connection.disconnect()">
    Disconnect
  </v-btn>

  <VirtualDevicePicker v-model="pickerOpen" />
  <TakeoverDialog />

  <v-btn
    :icon="themeIcons[themeStore.preference]"
    :title="`Theme: ${themeStore.preference}`"
    @click="cycleTheme"
  />
</template>
