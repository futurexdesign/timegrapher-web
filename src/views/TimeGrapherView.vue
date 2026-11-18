<script setup lang="ts">
/**
 * Time Grapher view (landing page): live rate, beat error and amplitude of a
 * mechanical watch (tick-tock chart, balance wheel, trend) or the rate of a
 * quartz watch (motor / LCD / tuning fork). Shows the connect prompt until a
 * device is connected.
 *
 * On connect it reads the device status and quartz settings to pick the
 * initial panel (the device store polls `getDevice` app-wide).
 * If capture is already running (started elsewhere) it claims the matching
 * subscription.
 */
import { ref, watch } from 'vue';
import ConnectPrompt from '@/components/ConnectPrompt.vue';
import HeaderBar from '@/components/timegrapher/HeaderBar.vue';
import type { QuartzSubMode, TimegrapherKind } from '@/components/timegrapher/types';
import MechanicalPanel from '@/components/timegrapher/MechanicalPanel.vue';
import QuartzPanel from '@/components/timegrapher/QuartzPanel.vue';
import { useConnectionStore } from '@/stores/connection';
import { useDeviceStore } from '@/stores/device';
import { useMechanicalStore } from '@/stores/mechanical';
import { useQuartzStore } from '@/stores/quartz';

const connection = useConnectionStore();
const device = useDeviceStore();
const mech = useMechanicalStore();
const quartz = useQuartzStore();

const kind = ref<TimegrapherKind>('mechanical');
const sub = ref<QuartzSubMode>('motor');

async function init(): Promise<void> {
  await device.refresh();
  await quartz.syncSettings();
  const m = quartz.settings?.mode;
  if (m !== undefined && m !== 'mechanical') {
    kind.value = 'quartz';
    sub.value = m;
  } else {
    kind.value = 'mechanical';
  }
  if (device.running && device.supported) {
    if (kind.value === 'quartz') await quartz.claim();
    else await mech.claim();
  }
}

watch(
  () => connection.isConnected,
  (c) => {
    if (c) void init();
  },
  { immediate: true },
);
</script>

<template>
  <v-container fluid>
    <ConnectPrompt v-if="!connection.isConnected" title="Time Grapher" />
    <div v-else>
      <HeaderBar v-model:kind="kind" v-model:sub="sub" />
      <MechanicalPanel v-if="kind === 'mechanical'" />
      <QuartzPanel v-else />
    </div>
  </v-container>
</template>
