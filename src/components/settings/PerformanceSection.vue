<script setup lang="ts">
/**
 * Performance section: DSP block time (last / mean / max) against its budget,
 * main-loop load, USB underruns / short writes, PCM ring fill and quartz block
 * time, from `getTiming`. Polled at 1 Hz only while this component is mounted
 * (i.e. the panel is expanded) and the browser tab is visible. Includes a
 * `resetTiming` button. Needs `caps.timing`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useDiagnosticsStore } from '@/stores/diagnostics';
import { budgetColor, budgetPercent } from '@/utils/budget';

const connection = useConnectionStore();
const diagnostics = useDiagnosticsStore();

const t = computed(() => diagnostics.timing);
const budget = computed(() => t.value?.dspBlockBudgetUs ?? 0);
const bars = computed(() => {
  const v = t.value;
  if (!v) return [];
  return [
    { label: 'Last', us: v.dspBlockUsLast },
    { label: 'Mean', us: v.dspBlockUsMean },
    { label: 'Max', us: v.dspBlockUsMax },
  ].map((b) => ({
    ...b,
    pct: budgetPercent(b.us, budget.value),
    color: budgetColor(b.us, budget.value),
  }));
});
const hasQuartz = computed(() => connection.features.quartz);

let polling = false;
const resetting = ref(false);

function start(): void {
  if (polling) return;
  polling = true;
  diagnostics.startPolling();
}
function stop(): void {
  if (!polling) return;
  polling = false;
  diagnostics.stopPolling();
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

/** Clears the device statistics. */
async function reset(): Promise<void> {
  resetting.value = true;
  await diagnostics.resetTiming();
  resetting.value = false;
}
</script>

<template>
  <div data-testid="performance">
    <v-alert v-if="!connection.features.timing" type="info" variant="tonal" density="compact">
      This firmware does not report timing statistics.
    </v-alert>
    <template v-else-if="t">
      <div class="text-subtitle-2 mb-2">
        DSP block time (budget {{ budget.toFixed(0) }} µs per {{ t.dspBlockSamples }}-sample block)
      </div>
      <div v-for="b in bars" :key="b.label" class="d-flex align-center ga-3 mb-1">
        <span class="text-caption" style="width: 3rem">{{ b.label }}</span>
        <v-progress-linear
          :model-value="Math.min(100, b.pct)"
          :color="b.color"
          height="14"
          rounded
          class="flex-grow-1"
        />
        <span class="text-caption text-right" style="width: 8rem">
          {{ b.us.toFixed(0) }} µs ({{ b.pct.toFixed(0) }}%)
        </span>
      </div>
      <v-row dense class="mt-3">
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">Loop busy</div>
          <div class="text-h6">{{ t.loopBusyPct.toFixed(1) }} %</div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">Underruns</div>
          <div class="text-h6" :class="{ 'text-error': t.underruns > 0 }">{{ t.underruns }}</div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">Short writes</div>
          <div class="text-h6" :class="{ 'text-warning': t.shortWrites > 0 }">
            {{ t.shortWrites }}
          </div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">Ring min / max</div>
          <div class="text-h6">{{ t.ringMin }} / {{ t.ringMax }}</div>
        </v-col>
        <v-col v-if="hasQuartz" cols="12">
          <div class="text-caption text-medium-emphasis">Quartz block (last / mean / max)</div>
          <div class="text-body-1">
            {{ t.quartzBlockUsLast.toFixed(0) }} / {{ t.quartzBlockUsMean.toFixed(0) }} /
            {{ t.quartzBlockUsMax.toFixed(0) }} µs
          </div>
        </v-col>
      </v-row>
    </template>
    <div v-else class="text-medium-emphasis">Waiting for timing data...</div>
    <v-btn
      v-if="connection.features.timing"
      class="mt-3"
      size="small"
      variant="tonal"
      prepend-icon="mdi-restart"
      :loading="resetting"
      @click="reset"
    >
      Reset timing
    </v-btn>
  </div>
</template>
