<script setup lang="ts">
/**
 * Spectrum peaks bar chart. Polls `getSpectrum` at 1 Hz while mounted and the
 * browser tab is visible (the parent only mounts it when the spectrum block is
 * enabled). Shows the strongest tonal peaks (at most 8) as bars over frequency.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import VChart from 'vue-echarts';
import { useTheme } from 'vuetify';
import type { DspSpectrum } from '@/protocol/types';
import { useConnectionStore } from '@/stores/connection';

/** Poll period (ms). */
const POLL_MS = 1000;

const connection = useConnectionStore();
const theme = useTheme();
const spectrum = ref<DspSpectrum | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function poll(): Promise<void> {
  if (busy || document.visibilityState !== 'visible' || !connection.isConnected) return;
  busy = true;
  try {
    spectrum.value = await connection.requireTransport().request('getSpectrum');
  } catch {
    /* transient (timeout / disconnect); the next poll retries */
  } finally {
    busy = false;
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});

const option = computed(() => {
  const colors = theme.current.value.colors;
  const text = colors['on-surface'];
  const peaks = spectrum.value?.valid ? [...spectrum.value.peaks].sort((a, b) => a.hz - b.hz) : [];
  return {
    animation: false,
    grid: { left: 48, right: 12, top: 12, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: peaks.map((p) => `${Math.round(p.hz)}`),
      name: 'Hz',
      nameLocation: 'end',
      axisLabel: { color: text },
      nameTextStyle: { color: text },
    },
    yAxis: {
      type: 'value',
      name: 'mag',
      axisLabel: { color: text },
      nameTextStyle: { color: text },
    },
    series: [
      {
        type: 'bar',
        data: peaks.map((p) => p.mag),
        itemStyle: { color: colors.primary },
      },
    ],
  };
});
</script>

<template>
  <v-card variant="outlined" class="pa-3" data-testid="spectrum-chart">
    <div class="text-subtitle-2 mb-1">
      Spectrum peaks
      <span v-if="spectrum?.valid" class="text-caption text-medium-emphasis">
        ({{ spectrum.fftN }}-point FFT, {{ spectrum.sourceHz }} Hz source)
      </span>
    </div>
    <v-chart class="chart" :option="option" autoresize />
    <div v-if="!spectrum?.valid" class="text-caption text-medium-emphasis">
      Waiting for a spectrum result...
    </div>
  </v-card>
</template>

<style scoped>
.chart {
  height: 180px;
  width: 100%;
}
</style>
