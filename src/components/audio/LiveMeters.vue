<script setup lang="ts">
/**
 * Live meters strip: input (pre) and output (post) peak bars with RMS in
 * dBFS, noise floor, AGC gain and the clip / limiter counters. Values come
 * from the metrics store (5 Hz push while the view is mounted).
 */
import { computed } from 'vue';
import { useMetricsStore } from '@/stores/metrics';

const metrics = useMetricsStore();

/** Bar range: -90 dBFS .. 0 dBFS maps to 0 .. 100 %. */
const MIN_DB = -90;
const pct = (db: number): number => Math.max(0, Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100));
const fmt = (db: number): string => (db <= -119 ? '-inf' : db.toFixed(1));

const m = computed(() => metrics.latest);
const meters = computed(() => [
  { id: 'in', label: 'Input (pre)', peak: metrics.preDb, rms: metrics.preRmsDb },
  { id: 'out', label: 'Output (post)', peak: metrics.postDb, rms: metrics.postRmsDb },
]);
const barColor = (db: number): string => (db > -1 ? 'error' : db > -12 ? 'warning' : 'primary');
</script>

<template>
  <v-card variant="outlined" class="pa-3" data-testid="live-meters">
    <div class="d-flex flex-wrap ga-4 align-center">
      <div v-for="mm in meters" :key="mm.id" class="meter">
        <div class="d-flex text-caption">
          <span class="flex-grow-1">{{ mm.label }}</span>
          <span class="tabular">peak {{ fmt(mm.peak) }} / rms {{ fmt(mm.rms) }} dBFS</span>
        </div>
        <v-progress-linear
          :model-value="pct(mm.peak)"
          :buffer-value="pct(mm.rms)"
          :color="barColor(mm.peak)"
          height="12"
          rounded
          :aria-label="`${mm.label} peak level`"
        />
      </div>
      <div class="d-flex flex-wrap ga-2 align-center">
        <v-chip size="small" label title="Estimated background noise level">
          Noise {{ fmt(metrics.noiseDb) }} dBFS
        </v-chip>
        <v-chip size="small" label title="Gain applied by the AGC">
          AGC {{ m ? m.agcGainDb.toFixed(1) : '-' }} dB
        </v-chip>
        <v-chip
          size="small"
          label
          :color="m && m.clipCount > 0 ? 'error' : undefined"
          title="Samples at full scale on the input"
        >
          Clips {{ m?.clipCount ?? '-' }}
        </v-chip>
        <v-chip
          size="small"
          label
          :color="m && m.limiterCount > 0 ? 'warning' : undefined"
          title="Times the output limiter acted"
        >
          Limiter {{ m?.limiterCount ?? '-' }}
        </v-chip>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.meter {
  flex: 1 1 260px;
  min-width: 0;
}
.tabular {
  font-variant-numeric: tabular-nums;
}
</style>
