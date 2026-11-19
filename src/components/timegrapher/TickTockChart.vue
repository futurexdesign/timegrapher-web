<script setup lang="ts">
/**
 * Tick-tock (paper-strip) chart: scatter of each beat's lead (`-u`, early =
 * up) against signal time, ticks (parity 0) and tocks (parity 1) in two
 * colours, rejected beats hollow. A new grid clears the trace (see the
 * mechanical store).
 *
 * Like a conventional timegrapher strip, a gaining watch rises and a losing
 * one falls, so the slope has the sign of the rate trend; the gap between the
 * two lines is the beat error. In "Raw" the fitted rate lines (dashed, one per
 * parity) are drawn over the dots. "Flatten" subtracts the fitted slope to
 * show beat error and noise. "Fold" wraps y at +-nominal/2 (paper-strip wrap).
 * A readout beside the chart derives rate and beat error from the plotted
 * points as a cross-check of the firmware values (rate = slope of the plot *
 * 0.0864, see utils/tickTock.ts).
 *
 * Redraw is throttled to 4 Hz; the accepted series use ECharts `large` mode.
 */
import { computed, ref } from 'vue';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';
import { useMechanicalStore } from '@/stores/mechanical';
import { fmtFixed, fmtRate } from '@/utils/format';
import {
  fitLinePoints,
  fitTickTock,
  plotValueUs,
  windowStart,
  xWindow,
  type TickPoint,
  type TickTockFit,
} from '@/utils/tickTock';
import { useChartColors } from '@/composables/useChartColors';
import { useThrottled } from './chartSupport';

const store = useMechanicalStore();
const colors = useChartColors();

/** Window choices in seconds (Infinity = all retained). */
const WINDOWS = [
  { label: '30 s', value: 30 },
  { label: '2 min', value: 120 },
  { label: '10 min', value: 600 },
  { label: 'All', value: Number.POSITIVE_INFINITY },
];
const windowS = ref(120);
const flatten = ref(false);
const fold = ref(true);
/** Y scale: auto-fit to the data, fixed ± ms, or the full ± nominal/2. */
const SCALES: { label: string; value: 'auto' | 'full' | number }[] = [
  { label: 'Auto', value: 'auto' },
  { label: '±1', value: 1 },
  { label: '±5', value: 5 },
  { label: '±20', value: 20 },
  { label: 'Full', value: 'full' },
];
const scale = ref<'auto' | 'full' | number>('auto');
/** Minimum auto span (ms) so a sub-millisecond beat error stays visible. */
const MIN_SPAN_MS = 2;

/** Y-axis bounds (ms) for the plotted values. */
function yRange(vals: number[], nominalMs: number): [number, number] {
  if (scale.value === 'full') return [-nominalMs / 2, nominalMs / 2];
  if (typeof scale.value === 'number') return [-scale.value, scale.value];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [-MIN_SPAN_MS / 2, MIN_SPAN_MS / 2];
  const mid = (lo + hi) / 2;
  const span = Math.max(MIN_SPAN_MS, (hi - lo) * 1.2);
  return [mid - span / 2, mid + span / 2];
}

interface Built {
  option: EChartsOption;
  fit: TickTockFit | null;
  shown: number;
}

function build(): Built {
  const all = store.ticks;
  const last = all[all.length - 1];
  const first = last ? windowStart(all, last.tS - windowS.value) : 0;
  const pts: TickPoint[] = all.slice(first);
  const fit = fitTickTock(pts);
  /* x = seconds since the grid's first beat, so axis labels stay put as the
   * window scrolls; the axis span is fixed by the selected window (xWindow). */
  const t0 = all[0]?.tS ?? 0;
  const xr = xWindow(last ? last.tS - t0 : 0, windowS.value);
  const c = colors.value;
  const nominal = pts[0]?.nominalUs ?? 0;
  const trace = (parity: 0 | 1, accepted: boolean): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of pts) {
      if (p.parity !== parity || p.accepted !== accepted) continue;
      out.push([p.tS - t0, plotValueUs(p, flatten.value ? fit : null, fold.value) / 1000]);
    }
    return out;
  };
  const accepted = (name: string, parity: 0 | 1, color: string) => ({
    name,
    type: 'scatter' as const,
    data: trace(parity, true),
    symbolSize: 4,
    large: true,
    largeThreshold: 2000,
    progressive: 4000,
    itemStyle: { color },
  });
  const rejected = (name: string, parity: 0 | 1, color: string) => ({
    name,
    type: 'scatter' as const,
    data: trace(parity, false),
    symbol: 'circle',
    symbolSize: 6,
    itemStyle: { color: 'transparent', borderColor: color, borderWidth: 1.5 },
  });
  /* Fitted rate lines (raw mode): the slope that encodes the rate, made explicit. */
  const lastPt = pts[pts.length - 1];
  const fitLine = (name: string, parity: 0 | 1, color: string) => {
    const ends =
      fit && !flatten.value && lastPt && pts[0]
        ? fitLinePoints(fit, parity, pts[0].tS, lastPt.tS, nominal, fold.value)
        : null;
    return {
      name,
      type: 'line' as const,
      data: ends ? ends.map(([t, v]): [number, number] => [t - t0, v / 1000]) : [],
      symbol: 'none',
      silent: true,
      z: 1,
      lineStyle: { color, width: 1.5, type: 'dashed' as const, opacity: 0.8 },
    };
  };
  const nominalMs = nominal / 1000 || 125;
  const vals: number[] = [];
  for (const parity of [0, 1] as const) for (const d of trace(parity, true)) vals.push(d[1]);
  const [yMin, yMax] = yRange(vals, nominalMs);
  const option: EChartsOption = {
    animation: false,
    textStyle: { color: c.text },
    grid: { left: 52, right: 12, top: 28, bottom: 32 },
    legend: { top: 0, textStyle: { color: c.text }, data: ['tick', 'tock'] },
    tooltip: { trigger: 'item', valueFormatter: (v) => `${Number(v).toFixed(3)} ms` },
    xAxis: {
      type: 'value',
      name: 's',
      nameLocation: 'end',
      min: xr.min,
      max: xr.max,
      /* Six even divisions of the window (5 s for 30 s, 20 s for 2 min, …). */
      ...(xr.step !== null ? { interval: xr.step } : {}),
      axisLabel: {
        color: c.text,
        hideOverlap: true,
        formatter: (v: number) => String(Math.round(v)),
      },
      splitLine: { lineStyle: { color: c.grid } },
    },
    yAxis: {
      type: 'value',
      name: 'early (+) / late (−), ms',
      min: yMin,
      max: yMax,
      axisLabel: {
        /* Auto-fit bounds are arbitrary values; label only the even ticks. */
        showMinLabel: scale.value !== 'auto',
        showMaxLabel: scale.value !== 'auto',
        color: c.text,
        formatter: (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
      },
      splitLine: { lineStyle: { color: c.grid } },
    },
    series: [
      accepted('tick', 0, c.tick),
      accepted('tock', 1, c.tock),
      rejected('tick (rejected)', 0, c.tick),
      rejected('tock (rejected)', 1, c.tock),
      fitLine('tick rate', 0, c.tick),
      fitLine('tock rate', 1, c.tock),
    ],
  };
  return { option, fit, shown: pts.length };
}

const built = useThrottled(build, [() => store.tickVersion, windowS, flatten, fold, scale, colors]);
const option = computed(() => built.value.option);
const fit = computed(() => built.value.fit);
const fwRate = computed(() => store.rate);
</script>

<template>
  <v-card class="pa-3">
    <div class="d-flex flex-wrap align-center ga-3 mb-2">
      <div class="text-subtitle-1">Tick-tock</div>
      <v-btn-toggle v-model="windowS" mandatory density="compact" variant="outlined" divided>
        <v-btn v-for="w in WINDOWS" :key="w.label" :value="w.value" size="small">
          {{ w.label }}
        </v-btn>
      </v-btn-toggle>
      <v-btn-toggle v-model="flatten" mandatory density="compact" variant="outlined" divided>
        <v-btn :value="false" size="small">Raw</v-btn>
        <v-btn :value="true" size="small">Flatten</v-btn>
      </v-btn-toggle>
      <v-btn-toggle v-model="scale" mandatory density="compact" variant="outlined" divided>
        <v-btn v-for="sc in SCALES" :key="sc.label" :value="sc.value" size="small">
          {{ sc.label }}
        </v-btn>
      </v-btn-toggle>
      <v-switch v-model="fold" label="Fold" density="compact" hide-details color="primary" />
      <v-chip v-if="store.gridRestarts > 0" size="small" variant="tonal" color="warning">
        {{ store.gridRestarts }} grid restart{{ store.gridRestarts > 1 ? 's' : '' }}
      </v-chip>
    </div>
    <div class="d-flex flex-column flex-md-row ga-3">
      <div class="chart-wrap flex-grow-1">
        <v-chart :option="option" :update-options="{ notMerge: true }" autoresize class="chart" />
        <div v-if="store.ticks.length === 0" class="chart-empty text-medium-emphasis">
          Waiting for beats (the beat rate must lock first)
        </div>
      </div>
      <div class="readout text-body-2">
        <div class="text-caption text-medium-emphasis">From plotted points</div>
        <div>
          Rate
          <strong>{{ fit ? fmtRate(fit.rateSDay, true, 1) : '—' }}</strong> s/d
        </div>
        <div>
          Beat error
          <strong>{{ fit?.beatErrorMs != null ? fmtFixed(fit.beatErrorMs, 2) : '—' }}</strong>
          ms
        </div>
        <div class="text-caption text-medium-emphasis">{{ fit?.n ?? 0 }} accepted beats</div>
        <v-divider class="my-2" />
        <div class="text-caption text-medium-emphasis">Firmware (instant)</div>
        <div>
          Rate
          <strong>{{ fwRate ? fmtRate(fwRate.rateSDay, fwRate.rateValid, 1) : '—' }}</strong>
          s/d
        </div>
        <div>
          Beat error
          <strong>{{
            fwRate && fwRate.beatErrorValid ? fmtFixed(fwRate.beatErrorMs, 2) : '—'
          }}</strong>
          ms
        </div>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.chart-wrap {
  position: relative;
  min-width: 0;
}
.chart {
  height: 340px;
  width: 100%;
}
.chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.readout {
  min-width: 170px;
  font-variant-numeric: tabular-nums;
}
</style>
