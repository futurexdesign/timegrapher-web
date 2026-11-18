<script setup lang="ts">
/**
 * App-bar controls: connection status chip (with device board / firmware),
 * connect menu (real WebHID device or virtual device), disconnect button and
 * the light / dark / system theme toggle.
 */
import { computed } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useThemeStore, type ThemePreference } from '@/stores/theme';

const connection = useConnectionStore();
const themeStore = useThemeStore();

const chip = computed(() => {
  switch (connection.status) {
    case 'connected':
      return {
        color: 'success',
        icon: 'mdi-usb',
        text: `${connection.kind === 'virtual' ? 'Virtual' : 'Connected'} · ${connection.deviceLabel}`,
      };
    case 'connecting':
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
        :disabled="connection.status === 'connecting'"
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
      <v-list-item
        prepend-icon="mdi-test-tube"
        title="Virtual device"
        @click="connection.connect('virtual')"
      />
    </v-list>
  </v-menu>
  <v-btn v-else prepend-icon="mdi-power-plug-off" @click="connection.disconnect()">
    Disconnect
  </v-btn>

  <v-btn
    :icon="themeIcons[themeStore.preference]"
    :title="`Theme: ${themeStore.preference}`"
    @click="cycleTheme"
  />
</template>
