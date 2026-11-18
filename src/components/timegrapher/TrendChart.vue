<script setup lang="ts">
/**
 * Trend chart: rate (avgLong), beat error and amplitude against wall-clock
 * time, from the ~1 Hz `beat` series in the mechanical store. Three stacked
 * grids (rate, beat error, amplitude) sharing one time axis; not-locked /
 * invalid periods are `null` points, drawn as gaps. A larger, finer version of
 * the OLED trend. Redraw is throttled to 4 Hz.
 */
import { computed, ref } from 'vue';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';
import { useMechanicalStore } from '@/stores/mechanical';
import { useChartColors } from '@/composables/useChartColors';
import { useThrottled } from './chartSupport';

const store = useMechanicalStore();
const colors = useChartColors();

/** Window choices in minutes. */
const WINDOWS = [2, 10, 30, 60];
const windowMin = ref(10);

/** Y axes: label, minimum span, label decimals, minimum tick interval, optional floor. */
const Y_AXES: {
  name: string;
  span: number;
  dec: number;
  minInterval: number;
  floor?: number;
}[] = [
  { name: 's/d', span: 1, dec: 1, minInterval: 0.5 },
  { name: 'ms', span: 0.1, dec: 2, minInterval: 0.05, floor: 0 },
  { name: '°', span: 10, dec: 0, minInterval: 5 },
];

function build(): EChartsOption {
  const c = colors.value;
  const all = store.trend;
  const tMax = all[all.length - 1]?.t ?? Date.now();
  const tMin = Math.max(
    tMax - windowMin.value * 60_000,
    all.find(
      (p) =>
        p.t >= tMax - windowMin.value * 60_000 &&
        (p.rate !== null || p.beatError !== null || p.amplitude !== null),
    )?.t ?? tMax,
  );
  let i = all.length;
  while (i > 0 && (all[i - 1]?.t ?? 0) >= tMin) i--;
  const pts = all.slice(i);
  const series = (
    key: 'rate' | 'beatError' | 'amplitude',
    name: string,
    color: string,
    idx: number,
  ) => ({
    name,
    type: 'line' as const,
    xAxisIndex: idx,
    yAxisIndex: idx,
    showSymbol: false,
    connectNulls: false,
    sampling: 'lttb' as const,
    lineStyle: { width: 1.5, color },
    itemStyle: { color },
    data: pts.map((p) => [p.t, p[key]]),
    ...(key === 'rate'
      ? {
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: 0 }],
            lineStyle: { color: c.ref, type: 'dotted' as const },
            label: { show: false },
          },
        }
      : {}),
  });
  const axisText = { color: c.text };
  const grids = [
    { left: 56, right: 12, top: 22, height: '22%' },
    { left: 56, right: 12, top: '40%', height: '17%' },
    { left: 56, right: 12, top: '66%', height: '22%' },
  ];
  return {
    animation: false,
    textStyle: { color: c.text },
    grid: grids,
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: grids.map((_, k) => ({
      type: 'time' as const,
      gridIndex: k,
      min: tMin,
      max: tMax,
      axisLabel: { ...axisText, show: k === 2, hideOverlap: true },
      splitNumber: 4,
      splitLine: { lineStyle: { color: c.grid } },
    })),
    yAxis: Y_AXES.map((a, k) => ({
      type: 'value' as const,
      gridIndex: k,
      name: a.name,
      splitNumber: 3,
      minInterval: a.minInterval,
      // minimum span so tiny noise does not fill the whole height
      min: (v: { min: number; max: number }) => {
        const lo = Math.min(v.min, (v.min + v.max) / 2 - a.span / 2);
        return a.floor === undefined ? lo : Math.max(a.floor, lo);
      },
      max: (v: { min: number; max: number }) => {
        const hi = Math.max(v.max, (v.min + v.max) / 2 + a.span / 2);
        return a.floor === undefined ? hi : Math.max(hi, a.floor + a.span);
      },
      nameTextStyle: axisText,
      axisLabel: { ...axisText, formatter: (v: number) => v.toFixed(a.dec) },
      splitLine: { lineStyle: { color: c.grid } },
    })),
    series: [
      series('rate', 'Rate (s/d)', c.rate, 0),
      series('beatError', 'Beat error (ms)', c.beatError, 1),
      series('amplitude', 'Amplitude (°)', c.amplitude, 2),
    ],
  };
}

const option = useThrottled(build, [() => store.trendVersion, windowMin, colors]);
/** Per-grid emptiness: true when no non-null point exists in the series. */
const emptyRate = computed(
  () => store.trendVersion >= 0 && !store.trend.some((p) => p.rate !== null),
);
const emptyBe = computed(
  () => store.trendVersion >= 0 && !store.trend.some((p) => p.beatError !== null),
);
const emptyAmp = computed(
  () => store.trendVersion >= 0 && !store.trend.some((p) => p.amplitude !== null),
);
const empties = computed(() => [emptyRate.value, emptyBe.value, emptyAmp.value]);
</script>

<template>
  <v-card class="pa-3">
    <div class="d-flex flex-wrap align-center ga-3 mb-2">
      <div class="text-subtitle-1">Trend</div>
      <v-btn-toggle v-model="windowMin" mandatory density="compact" variant="outlined" divided>
        <v-btn v-for="w in WINDOWS" :key="w" :value="w" size="small">{{ w }} min</v-btn>
      </v-btn-toggle>
      <span class="text-caption text-medium-emphasis"> Averaged values; gaps = not locked </span>
    </div>
    <div class="chart-wrap">
      <v-chart :option="option" :update-options="{ notMerge: true }" autoresize class="chart" />
      <div
        v-for="(e, i) in empties"
        :key="i"
        class="grid-empty text-caption text-medium-emphasis"
        :style="{ top: ['8%', '44%', '70%'][i] }"
      >
        <template v-if="e">No data yet</template>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.chart-wrap {
  position: relative;
}
.chart {
  height: 420px;
  width: 100%;
}
.grid-empty {
  position: absolute;
  left: 56px;
  right: 12px;
  text-align: center;
  pointer-events: none;
}
.chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>
