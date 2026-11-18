<script setup lang="ts">
/**
 * Sky plot and SNR list. The plot is an ECharts polar scatter: angle =
 * azimuth (0 deg at the top = north, clockwise), radius = 90 - elevation
 * (zenith centre, horizon rim, rings at elevation 60/30/0). Marker colour =
 * constellation, size = SNR, filled when used in the fix, hollow otherwise,
 * label = system + PRN. Satellites with unknown elevation/azimuth are listed
 * separately. Mapping lives in `utils/sky.ts`.
 */
import { computed } from 'vue';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';
import {
  SYSTEMS,
  type SatView,
  compass,
  groupBySystem,
  satLabel,
  skyPosition,
  snrSymbolSize,
  sortBySnr,
  splitSats,
} from '@/utils/sky';
import { useChartColors } from '@/composables/useChartColors';

const props = defineProps<{
  /** Satellites (named fields, see `toSat`). */
  sats: readonly SatView[];
}>();

const colors = useChartColors();
const split = computed(() => splitSats(props.sats));
const sorted = computed(() => sortBySnr(props.sats));

/** Extracts the satellite carried in a chart data item's `data.sat`. */
function satOf(p: unknown): SatView {
  return (p as { data: { sat: SatView } }).data.sat;
}

/** Tooltip HTML with every field of a satellite. */
function tip(s: SatView): string {
  return (
    `<b>${satLabel(s)}</b> (${SYSTEMS[s.sys].name})<br/>` +
    `PRN ${s.prn}<br/>` +
    `elevation ${s.el >= 0 ? `${s.el}°` : 'unknown'}<br/>` +
    `azimuth ${s.az >= 0 ? `${s.az}° ${compass(s.az)}` : 'unknown'}<br/>` +
    `SNR ${s.snr >= 0 ? `${s.snr} dB-Hz` : 'not tracked'}<br/>` +
    (s.used ? 'used in fix' : 'not used')
  );
}

const option = computed<EChartsOption>(() => {
  const c = colors.value;
  const series = groupBySystem(split.value.placed).map((g) => {
    const color = SYSTEMS[g.sys].color;
    return {
      name: `${g.sys} ${SYSTEMS[g.sys].name}`,
      type: 'scatter' as const,
      coordinateSystem: 'polar' as const,
      symbolSize: (_v: unknown, p: unknown) => snrSymbolSize(satOf(p).snr),
      label: {
        show: true,
        formatter: (p: unknown) => String(satOf(p).prn),
        position: 'inside' as const,
        fontSize: 9,
        color: c.text,
      },
      itemStyle: { color, borderColor: color, borderWidth: 2 },
      data: g.sats.map((s) => ({
        value: skyPosition(s) ?? [0, 0],
        sat: s,
        itemStyle: s.used
          ? { color, borderColor: color, borderWidth: 2 }
          : { color: 'transparent', borderColor: color, borderWidth: 2 },
      })),
    };
  });
  return {
    animation: false,
    legend: { bottom: 0, textStyle: { color: c.text } },
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => tip(satOf(p)),
    },
    polar: { radius: '70%', center: ['50%', '45%'] },
    angleAxis: {
      type: 'value',
      min: 0,
      max: 360,
      startAngle: 90,
      clockwise: true,
      interval: 90,
      axisLabel: {
        color: c.text,
        formatter: (v: number) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[v] ?? '',
      },
      splitLine: { show: true, lineStyle: { color: c.grid } },
      axisLine: { lineStyle: { color: c.axis } },
    },
    radiusAxis: {
      type: 'value',
      min: 0,
      max: 90,
      interval: 30,
      // Ring labels are omitted (they collided with satellites); see the caption.
      axisLabel: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } },
      axisLine: { lineStyle: { color: c.axis } },
    },
    series,
  };
});
</script>

<template>
  <v-card>
    <v-card-title>Sky view</v-card-title>
    <v-card-text>
      <v-row>
        <v-col cols="12" md="7">
          <v-chart class="sky-chart" :option="option" autoresize />
          <div class="text-caption text-medium-emphasis">
            Filled = used in the fix, hollow = tracked only. Size = SNR. Centre = zenith, rim =
            horizon; rings at 60°, 30° and 0° elevation.
          </div>
          <div v-if="split.unplaced.length" class="mt-2 text-body-2">
            Position unknown:
            <v-chip
              v-for="s in split.unplaced"
              :key="s.sys + s.prn"
              size="small"
              class="ma-1"
              :variant="s.used ? 'flat' : 'outlined'"
              :color="SYSTEMS[s.sys].color"
            >
              {{ satLabel(s) }}<template v-if="s.snr >= 0">&nbsp;{{ s.snr }}</template>
            </v-chip>
          </div>
        </v-col>
        <v-col cols="12" md="5">
          <div class="text-subtitle-2 mb-1">SNR (dB-Hz)</div>
          <div v-if="!sorted.length" class="text-body-2 text-medium-emphasis">
            No satellites tracked.
          </div>
          <div
            v-for="s in sorted"
            :key="s.sys + s.prn"
            class="snr-row"
            :class="{ 'snr-used': s.used }"
          >
            <span class="snr-label">{{ satLabel(s) }}</span>
            <span class="snr-track">
              <span
                class="snr-bar"
                :style="{
                  width: `${Math.max(0, Math.min(100, (s.snr / 55) * 100))}%`,
                  background: SYSTEMS[s.sys].color,
                  opacity: s.used ? 1 : 0.45,
                }"
              />
            </span>
            <span class="snr-value">{{ s.snr >= 0 ? s.snr : '—' }}</span>
          </div>
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.sky-chart {
  height: 360px;
  width: 100%;
}
.snr-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 1px 4px;
  border-radius: 4px;
}
.snr-used {
  background: rgba(var(--v-theme-on-surface), 0.08);
  font-weight: 500;
}
.snr-label {
  width: 48px;
  font-variant-numeric: tabular-nums;
}
.snr-track {
  flex: 1;
  height: 10px;
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 5px;
  overflow: hidden;
}
.snr-bar {
  display: block;
  height: 100%;
}
.snr-value {
  width: 28px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
