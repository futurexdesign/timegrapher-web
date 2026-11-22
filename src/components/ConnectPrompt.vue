<script setup lang="ts">
/**
 * Empty state shown by views while no device is connected. Offers the same
 * connect options as the app-bar menu: WebHID (USB), Web Bluetooth and the
 * virtual device. The platform only adapts the guidance (BLE_TRANSPORT_PLAN.md
 * §6.4): Bluefy-like browsers (Web Bluetooth without WebHID) drop the WebHID
 * button, and iOS browsers with neither API get a hint to open the page in a
 * Web Bluetooth browser. No option is ever blocked because of the user agent.
 */
import { useConnectionStore } from '@/stores/connection';
import { useSnackbarStore } from '@/stores/snackbar';
import { isIos, readPlatform } from '@/utils/platform';

defineProps<{
  /** Name of the view, shown in the explanatory text. */
  title: string;
}>();

const connection = useConnectionStore();
const snackbar = useSnackbarStore();

const platform = readPlatform();
const hasHid = connection.webHidAvailable;
/** iPhone/iPad browser with neither API: nothing here can reach the stand. */
const showIosGuidance = isIos(platform) && !platform.hasBluetooth && !hasHid;
/** WebHID button and hint: hidden where only Web Bluetooth exists (Bluefy, Android Chrome). */
const showWebHid = !showIosGuidance && (hasHid || !platform.hasBluetooth);

/** Copies the page address so it can be pasted into a Web Bluetooth browser. */
async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    snackbar.show('Link copied', 'success');
  } catch {
    snackbar.show('Could not copy the link; copy it from the address bar', 'warning');
  }
}
</script>

<template>
  <v-empty-state
    icon="mdi-usb-port"
    :headline="`${title}: connect a device`"
    :text="
      showWebHid
        ? 'Connect a timegrapher stand over USB or Bluetooth, or try the virtual device.'
        : 'Connect a timegrapher stand over Bluetooth, or try the virtual device.'
    "
  >
    <template v-if="showIosGuidance" #text>
      <v-alert
        type="info"
        variant="tonal"
        role="alert"
        aria-live="polite"
        class="text-left"
        data-testid="ios-guidance"
      >
        iPhone and iPad browsers cannot talk to the stand. Open this page in a Web Bluetooth browser
        such as Bluefy to connect over Bluetooth.
        <template #append>
          <v-btn
            size="small"
            variant="text"
            prepend-icon="mdi-content-copy"
            data-testid="copy-link"
            @click="copyLink"
          >
            Copy link
          </v-btn>
        </template>
      </v-alert>
    </template>
    <template #actions>
      <v-tooltip
        v-if="showWebHid"
        :disabled="connection.webHidAvailable"
        text="WebHID needs Chrome or Edge on HTTPS or localhost"
      >
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-usb"
              :disabled="!connection.webHidAvailable || connection.status !== 'disconnected'"
              @click="connection.connect('webhid')"
            >
              Real device (WebHID)
            </v-btn>
          </span>
        </template>
      </v-tooltip>
      <v-tooltip
        v-if="!showIosGuidance"
        :disabled="connection.webBleAvailable"
        text="Web Bluetooth needs Chrome or Edge, or Bluefy on iPhone and iPad, with Bluetooth on"
      >
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-bluetooth"
              data-testid="connect-ble"
              :disabled="!connection.webBleAvailable || connection.status !== 'disconnected'"
              @click="connection.connect('webble')"
            >
              Real device (Bluetooth)
            </v-btn>
          </span>
        </template>
      </v-tooltip>
      <v-btn
        prepend-icon="mdi-test-tube"
        variant="tonal"
        :disabled="connection.status !== 'disconnected'"
        @click="connection.connect('virtual')"
      >
        Virtual device
      </v-btn>
    </template>
  </v-empty-state>
</template>
