<script setup lang="ts">
/**
 * Timebase view: active sample-clock correction, PC-assisted calibration,
 * GPS / PPS status with a sky plot, and the calibration history. Polls
 * `getTimebase` and `getGps` at 1 Hz only while mounted and the tab is visible.
 * Layout: two columns on desktop (correction + PC cal | GPS + sky), history
 * full width; stacked on phones.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ConnectPrompt from '@/components/ConnectPrompt.vue';
import ActiveCorrectionCard from '@/components/timebase/ActiveCorrectionCard.vue';
import CalHistory from '@/components/timebase/CalHistory.vue';
import GpsCard from '@/components/timebase/GpsCard.vue';
import PcCalibrationPanel from '@/components/timebase/PcCalibrationPanel.vue';
import SkyView from '@/components/timebase/SkyView.vue';
import { useConnectionStore } from '@/stores/connection';
import { useGpsStore } from '@/stores/gps';
import { useTimebaseStore } from '@/stores/timebase';

const connection = useConnectionStore();
const timebase = useTimebaseStore();
const gps = useGpsStore();

/** Whether this view currently holds polling claims. */
const polling = ref(false);

function startPolling(): void {
  if (polling.value) return;
  polling.value = true;
  timebase.startPolling();
  gps.startPolling();
}
function stopPolling(): void {
  if (!polling.value) return;
  polling.value = false;
  timebase.stopPolling();
  gps.stopPolling();
}
/** Pause polling in a hidden tab (a running PC calibration has its own loop). */
function onVisibility(): void {
  if (document.hidden) stopPolling();
  else startPolling();
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) startPolling();
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  stopPolling();
});
</script>

<template>
  <v-container fluid>
    <ConnectPrompt v-if="!connection.isConnected" title="Timebase" />
    <template v-else>
      <h1 class="text-h5 mb-3">Timebase</h1>
      <v-row>
        <v-col cols="12" lg="6" class="d-flex flex-column ga-4">
          <ActiveCorrectionCard />
          <PcCalibrationPanel />
        </v-col>
        <v-col v-if="connection.features.gps" cols="12" lg="6" class="d-flex flex-column ga-4">
          <GpsCard />
          <SkyView :sats="gps.sats" />
        </v-col>
        <v-col cols="12">
          <CalHistory />
        </v-col>
      </v-row>
    </template>
  </v-container>
</template>
