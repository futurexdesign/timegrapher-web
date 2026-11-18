<script setup lang="ts">
/**
 * Empty state shown by views while no device is connected. Offers the same
 * two connect options as the app-bar menu.
 */
import { useConnectionStore } from '@/stores/connection';

defineProps<{
  /** Name of the view, shown in the explanatory text. */
  title: string;
}>();

const connection = useConnectionStore();
</script>

<template>
  <v-empty-state
    icon="mdi-usb-port"
    :headline="`${title}: connect a device`"
    text="Connect a timegrapher stand over USB, or try the virtual device."
  >
    <template #actions>
      <v-tooltip
        :disabled="connection.webHidAvailable"
        text="WebHID needs Chrome or Edge on HTTPS or localhost"
      >
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-usb"
              :disabled="!connection.webHidAvailable || connection.status === 'connecting'"
              @click="connection.connect('webhid')"
            >
              Real device (WebHID)
            </v-btn>
          </span>
        </template>
      </v-tooltip>
      <v-btn
        prepend-icon="mdi-test-tube"
        variant="tonal"
        :disabled="connection.status === 'connecting'"
        @click="connection.connect('virtual')"
      >
        Virtual device
      </v-btn>
    </template>
  </v-empty-state>
</template>
