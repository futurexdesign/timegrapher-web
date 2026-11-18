<script setup lang="ts">
/**
 * PC-assisted calibration panel: duration choice, progress, live ppm +/-
 * stderr and an offset-vs-time chart with the fitted line, then Apply /
 * Apply & Save. The algorithm lives in `usePcCalibration`.
 */
import { computed, ref, onBeforeUnmount } from 'vue';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';
import { usePcCalibration } from '@/composables/usePcCalibration';
import { useChartColors } from '@/composables/useChartColors';

const cal = usePcCalibration();
const colors = useChartColors();

const PRESETS = [5, 15, 30, 60] as const;
const choice = ref<number | 'custom'>(15);
const customMin = ref('10');
const minutes = computed(() =>
  choice.value === 'custom' ? Number(customMin.value) : choice.value,
);
const minutesValid = computed(() => Number.isFinite(minutes.value) && minutes.value >= 2);
const running = computed(() => cal.status.value === 'running');

/** mm:ss text. */
function mmss(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function start(): void {
  if (minutesValid.value) void cal.start({ durationS: minutes.value * 60 });
}
onBeforeUnmount(() => {
  cal.cancel();
});

const alertType = computed(() => {
  switch (cal.level.value) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
});

/** Chart: offset (device minus host, us) against run time, with the fit. */
const option = computed<EChartsOption>(() => {
  const c = colors.value;
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 16, bottom: 36 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'value',
      name: 's',
      nameLocation: 'end',
      axisLabel: { color: c.axis },
      nameTextStyle: { color: c.axis },
      splitLine: { lineStyle: { color: c.grid } },
    },
    yAxis: {
      type: 'value',
      name: 'offset µs',
      scale: true,
      axisLabel: { color: c.axis },
      nameTextStyle: { color: c.axis },
      splitLine: { lineStyle: { color: c.grid } },
    },
    series: [
      {
        name: 'samples',
        type: 'scatter',
        symbolSize: 5,
        itemStyle: { color: c.primary },
        data: cal.chart.value.points,
      },
      {
        name: 'fit',
        type: 'line',
        showSymbol: false,
        lineStyle: { color: c.error, width: 2 },
        data: cal.chart.value.line,
      },
    ],
  };
});
</script>

<template>
  <v-card>
    <v-card-title>PC calibration</v-card-title>
    <v-card-text>
      <v-alert type="info" variant="tonal" density="compact" class="mb-3">
        Measures the board clock against this computer. The PC clock must be NTP-synchronised, and
        this tab must stay in the foreground (browsers throttle background tabs). The screen is kept
        awake while it runs when the browser allows it.
      </v-alert>

      <div class="d-flex flex-wrap align-center ga-3 mb-2">
        <v-btn-toggle v-model="choice" mandatory divided density="comfortable" :disabled="running">
          <v-btn v-for="m in PRESETS" :key="m" :value="m" variant="outlined">{{ m }} min</v-btn>
          <v-btn value="custom" variant="outlined">Custom</v-btn>
        </v-btn-toggle>
        <v-text-field
          v-if="choice === 'custom'"
          v-model="customMin"
          label="Minutes"
          type="number"
          min="2"
          density="compact"
          hide-details
          style="max-width: 120px"
          :disabled="running"
          :error="!minutesValid"
        />
        <v-btn
          v-if="!running"
          color="primary"
          variant="flat"
          :disabled="!minutesValid"
          @click="start"
        >
          Start
        </v-btn>
        <v-btn v-else color="error" variant="tonal" @click="cal.cancel()">Cancel</v-btn>
      </div>

      <template v-if="cal.status.value !== 'idle'">
        <v-progress-linear :model-value="cal.progress.value * 100" height="20" rounded class="my-3">
          <span class="text-caption">
            {{ mmss(cal.elapsedS.value) }} elapsed &middot;
            {{ mmss(cal.remainingS.value) }} remaining
          </span>
        </v-progress-linear>

        <div v-if="cal.fit.value" class="mb-2" data-testid="live-ppm">
          <span class="text-h5">
            {{ cal.fit.value.ppm >= 0 ? '+' : '−' }}{{ Math.abs(cal.fit.value.ppm).toFixed(3) }} ppm
          </span>
          <span class="text-body-2 text-medium-emphasis ml-2">
            &plusmn; {{ cal.fit.value.stderrPpm.toFixed(3) }} &middot;
            {{ cal.secPerDay.value?.toFixed(3) }} s/d &middot; {{ cal.fit.value.points }} pts over
            {{ Math.round(cal.fit.value.spanS) }} s{{ running ? ' (running)' : '' }}
          </span>
        </div>
        <div class="text-caption text-medium-emphasis mb-1">
          {{ cal.sampleCount.value }} samples<span v-if="cal.timeouts.value">
            &middot; {{ cal.timeouts.value }} timeouts</span
          ><span v-if="cal.stepRestarts.value">
            &middot; {{ cal.stepRestarts.value }} restarts (clock step)</span
          >
        </div>
        <v-alert
          v-if="cal.hiddenSeen.value && running"
          type="warning"
          density="compact"
          class="mb-2"
        >
          Tab was hidden: sampling may have been throttled.
        </v-alert>
        <v-chart class="cal-chart" :option="option" autoresize />
        <v-alert
          v-if="cal.message.value"
          :type="alertType"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          {{ cal.message.value }}
        </v-alert>
      </template>
    </v-card-text>
    <v-card-actions v-if="cal.status.value === 'done'">
      <v-spacer />
      <v-btn :disabled="!cal.applicable.value || cal.applied.value" @click="cal.apply(false)">
        Apply
      </v-btn>
      <v-btn
        color="primary"
        variant="tonal"
        :disabled="!cal.applicable.value || (cal.applied.value && cal.saved.value)"
        @click="cal.apply(true)"
      >
        Apply &amp; Save
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.cal-chart {
  height: 240px;
  width: 100%;
}
</style>
