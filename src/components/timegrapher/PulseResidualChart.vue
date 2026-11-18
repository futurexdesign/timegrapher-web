<script setup lang="ts">
/**
 * Motor pulse residual chart: each `quartzPulse` as (tS, residual in µs)
 * against a least-squares line over the pulse sequence, coloured by leading
 * spike polarity. Inhibition jumps show as steps, the coil-half offset as two
 * bands. Math in utils/quartzPulses.ts. Redraw throttled to 4 Hz.
 */
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';
import { useQuartzStore } from '@/stores/quartz';
import { pulseResiduals } from '@/utils/quartzPulses';
import { useChartColors } from '@/composables/useChartColors';
import { useThrottled } from './chartSupport';

const store = useQuartzStore();
const colors = useChartColors();

function build(): EChartsOption {
  const c = colors.value;
  const res = pulseResiduals(store.pulses);
  const trace = (pol: 1 | -1): [number, number][] =>
    res.filter((p) => p.polarity === pol).map((p) => [p.tS, p.resUs]);
  const axis = { color: c.text };
  return {
    animation: false,
    textStyle: { color: c.text },
    grid: { left: 56, right: 12, top: 28, bottom: 32 },
    legend: { top: 0, textStyle: axis },
    tooltip: { trigger: 'item', valueFormatter: (v) => `${Number(v).toFixed(1)} µs` },
    xAxis: {
      type: 'value',
      name: 's',
      min: 'dataMin',
      /* 'dataMin' puts the raw first-pulse time on the first tick. */
      axisLabel: { ...axis, formatter: (v: number) => String(Math.round(v)), hideOverlap: true },
      splitLine: { lineStyle: { color: c.grid } },
    },
    yAxis: {
      type: 'value',
      name: 'µs',
      scale: true,
      axisLabel: axis,
      splitLine: { lineStyle: { color: c.grid } },
    },
    series: [
      {
        name: '+ polarity',
        type: 'scatter',
        data: trace(1),
        symbolSize: 6,
        itemStyle: { color: c.tick },
      },
      {
        name: '− polarity',
        type: 'scatter',
        data: trace(-1),
        symbolSize: 6,
        itemStyle: { color: c.tock },
      },
    ],
  };
}

const option = useThrottled(build, [() => store.pulseVersion, colors]);
</script>

<template>
  <v-card class="pa-3">
    <div class="text-subtitle-1 mb-1">Pulse residuals</div>
    <div class="text-caption text-medium-emphasis mb-1">
      Pulse time minus a straight-line fit; steps are inhibition jumps.
    </div>
    <v-chart :option="option" :update-options="{ notMerge: true }" autoresize class="chart" />
  </v-card>
</template>

<style scoped>
.chart {
  height: 300px;
  width: 100%;
}
</style>
