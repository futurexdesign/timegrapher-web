<script setup lang="ts">
/**
 * Header bar of the Time Grapher view: Mechanical | Quartz toggle (Quartz
 * hidden without `caps.quartz`), quartz sub-mode (Motor / LCD / Fork), the
 * prominent Start / Stop button, quartz Restart, capture-mode select (needs
 * `caps.deviceMode`) and status chips.
 *
 * Switching view while running moves the subscription claim: the old store
 * releases, the mode is patched (`patchState {quartz:{mode}}`; mechanical is
 * `'mechanical'`) and the new store claims.
 */
import { computed } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useDeviceStore } from '@/stores/device';
import { useMechanicalStore } from '@/stores/mechanical';
import { useQuartzStore } from '@/stores/quartz';
import type { DeviceMode } from '@/protocol/types';

import type { QuartzSubMode, TimegrapherKind } from './types';

const kind = defineModel<TimegrapherKind>('kind', { required: true });
const sub = defineModel<QuartzSubMode>('sub', { required: true });

const connection = useConnectionStore();
const device = useDeviceStore();
const mech = useMechanicalStore();
const quartz = useQuartzStore();

const hasQuartz = computed(() => connection.features.quartz);
const running = computed(() => device.running);

async function onKind(next: TimegrapherKind | undefined): Promise<void> {
  if (next === undefined || next === kind.value) return;
  const was = running.value;
  if (was) {
    if (kind.value === 'mechanical') await mech.release();
    else await quartz.release();
  }
  if (hasQuartz.value) {
    await quartz.setMode(next === 'mechanical' ? 'mechanical' : sub.value);
  }
  kind.value = next;
  if (was) {
    if (next === 'mechanical') await mech.claim();
    else await quartz.claim();
  }
}

async function onSub(next: QuartzSubMode | undefined): Promise<void> {
  if (next === undefined) return;
  sub.value = next;
  if (kind.value === 'quartz') await quartz.setMode(next);
}

async function onStart(): Promise<void> {
  if (kind.value === 'quartz') {
    if (quartz.mode !== sub.value) await quartz.setMode(sub.value);
    await quartz.begin();
  } else {
    if (hasQuartz.value && quartz.mode !== null && quartz.mode !== 'mechanical') {
      await quartz.setMode('mechanical');
    }
    await mech.begin();
  }
}

async function onStop(): Promise<void> {
  await mech.release();
  await quartz.release();
  await device.stop();
}

const MODES: { title: string; value: DeviceMode }[] = [
  { title: 'USB microphone', value: 'usbMic' },
  { title: 'Standalone', value: 'standalone' },
];
</script>

<template>
  <v-card class="pa-3 mb-3">
    <div class="d-flex flex-wrap align-center ga-3">
      <v-btn-toggle
        v-if="hasQuartz"
        :model-value="kind"
        mandatory
        density="comfortable"
        variant="outlined"
        divided
        color="primary"
        @update:model-value="onKind"
      >
        <v-btn value="mechanical">Mechanical</v-btn>
        <v-btn value="quartz">Quartz</v-btn>
      </v-btn-toggle>

      <v-btn-toggle
        v-if="hasQuartz && kind === 'quartz'"
        :model-value="sub"
        mandatory
        density="comfortable"
        variant="outlined"
        divided
        @update:model-value="onSub"
      >
        <v-btn value="motor">Motor</v-btn>
        <v-btn value="lcd">LCD</v-btn>
        <v-btn value="fork">Fork</v-btn>
      </v-btn-toggle>

      <v-spacer />

      <v-chip :color="running ? 'success' : 'default'" variant="flat" size="small">
        <v-icon start :icon="running ? 'mdi-record' : 'mdi-stop'" />
        {{ running ? 'Running' : 'Stopped' }}
      </v-chip>
      <v-chip v-if="device.mode === 'usbMic' && device.usbStreaming" size="small" variant="tonal">
        <v-icon start icon="mdi-usb" />
        Capture is driven by the PC audio stream
      </v-chip>

      <v-select
        v-if="device.supported"
        :model-value="device.mode"
        :items="MODES"
        label="Capture mode"
        density="compact"
        variant="outlined"
        hide-details
        :disabled="device.usbStreaming || device.busy"
        style="max-width: 190px"
        @update:model-value="(m: DeviceMode) => device.setMode(m)"
      />

      <v-btn
        v-if="kind === 'quartz' && hasQuartz"
        variant="outlined"
        prepend-icon="mdi-restart"
        :disabled="!running"
        @click="quartz.restart()"
      >
        Restart
      </v-btn>
      <v-btn
        v-if="!running"
        color="success"
        variant="flat"
        size="large"
        prepend-icon="mdi-play"
        :loading="device.busy"
        @click="onStart"
      >
        Start
      </v-btn>
      <v-btn
        v-else
        color="error"
        variant="flat"
        size="large"
        prepend-icon="mdi-stop"
        :loading="device.busy"
        @click="onStop"
      >
        Stop
      </v-btn>
    </div>
  </v-card>
</template>
