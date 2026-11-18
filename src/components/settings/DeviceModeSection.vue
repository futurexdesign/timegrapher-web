<script setup lang="ts">
/**
 * Device mode section: choose between "USB microphone" and "Standalone
 * timegrapher" (`setDevice`, persisted to flash). The choice is disabled with
 * an explanation while the USB audio stream is open (the device refuses a
 * flash write then). Shows saved / unsaved, running and the stream state.
 * Rendered only when `caps.deviceMode` exists.
 */
import { computed } from 'vue';
import type { DeviceMode } from '@/protocol/types';
import { useDeviceStore } from '@/stores/device';

const device = useDeviceStore();

const locked = computed(() => device.usbStreaming || device.busy);
const stream = computed(() => device.status?.streamState ?? 'unknown');
const model = computed(() => device.mode);

/**
 * Applies a newly selected mode.
 * @param m Selected mode.
 */
async function choose(m: DeviceMode | null): Promise<void> {
  if (m === null || m === device.mode) return;
  await device.setMode(m);
}
</script>

<template>
  <div data-testid="device-mode">
    <v-alert v-if="device.usbStreaming" type="info" variant="tonal" density="compact" class="mb-3">
      The USB audio stream is open, so the mode cannot be changed (it is saved to flash). Close the
      recording in the PC program first.
    </v-alert>
    <v-radio-group
      :model-value="model"
      :disabled="locked"
      hide-details
      @update:model-value="choose"
    >
      <v-radio value="usbMic" density="compact">
        <template #label>
          <div>
            <div class="font-weight-medium">USB microphone</div>
            <div class="text-caption text-medium-emphasis">
              For PC timegrapher software. Capture runs while the PC records, and timing still runs.
            </div>
          </div>
        </template>
      </v-radio>
      <v-radio value="standalone" class="mt-2" density="compact">
        <template #label>
          <div>
            <div class="font-weight-medium">Standalone timegrapher</div>
            <div class="text-caption text-medium-emphasis">
              The device times on its own, from the OLED or this app. The USB audio feed is silent
              and capture starts at boot.
            </div>
          </div>
        </template>
      </v-radio>
    </v-radio-group>
    <div class="d-flex flex-wrap ga-2 mt-3">
      <v-chip
        size="small"
        :color="device.status?.saved ? 'success' : 'warning'"
        :prepend-icon="device.status?.saved ? 'mdi-content-save-check' : 'mdi-content-save-alert'"
      >
        {{ device.status?.saved ? 'Saved' : 'Unsaved' }}
      </v-chip>
      <v-chip
        size="small"
        :color="device.running ? 'success' : undefined"
        prepend-icon="mdi-record-circle-outline"
      >
        {{ device.running ? 'Running' : 'Stopped' }}
      </v-chip>
      <v-chip size="small" prepend-icon="mdi-usb">Stream: {{ stream }}</v-chip>
    </div>
  </div>
</template>
