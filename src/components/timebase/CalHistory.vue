<script setup lang="ts">
/**
 * Calibration history: the device's persisted timebase log (ppm over time,
 * marker shape/colour by source) overlaid with this browser session's live PPS
 * ppm (1 Hz, in memory, capped at 24 h), a band of +/- logDeltaPpm around the
 * last logged value, crystal drift statistics and a collapsed data table.
 * Hidden when the firmware has no timebase log.
 */
import { computed, onMounted, ref, watch } from 'vue';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';
import type { TimebaseLogEntry, TimebaseLogSource } from '@/protocol/timegrapher_hid';
import { useConnectionStore } from '@/stores/connection';
import { LOG_DELTA_RANGE, useTimebaseStore } from '@/stores/timebase';
import { downsample, driftStats } from '@/utils/calibration';
import { useChartColors } from '@/composables/useChartColors';

const connection = useConnectionStore();
const store = useTimebaseStore();
const colors = useChartColors();

const entries = computed<TimebaseLogEntry[]>(() => store.log?.entries ?? []);
const hasData = computed(() => entries.value.length > 0 || store.sessionPps.length > 0);
const stats = computed(() => driftStats(entries.value));
const pending = computed(() => store.log?.pending === true || store.tb?.logPending === true);
const delta = computed(() => store.log?.logDeltaPpm ?? store.tb?.logDeltaPpm ?? null);

const SOURCE_STYLE: Record<TimebaseLogSource, { symbol: string; color: () => string }> = {
  pps: { symbol: 'circle', color: () => colors.value.success },
  ntp: { symbol: 'diamond', color: () => colors.value.primary },
  manual: { symbol: 'triangle', color: () => colors.value.warning },
};

/** Live series re-sampled only every 5 new points to bound chart redraws. */
const sessionTick = computed(() => Math.floor(store.sessionPps.length / 5));
const sessionData = computed(() =>
  sessionTick.value >= 0 ? downsample(store.sessionPps, 1500) : [],
);

const option = computed<EChartsOption>(() => {
  const c = colors.value;
  const last = entries.value[entries.value.length - 1];
  const d = delta.value;
  const logSeries = (['pps', 'ntp', 'manual'] as const).map((src) => ({
    name: `log: ${src}`,
    type: 'scatter' as const,
    symbol: SOURCE_STYLE[src].symbol,
    symbolSize: 11,
    itemStyle: { color: SOURCE_STYLE[src].color() },
    data: entries.value
      .filter((e) => e.source === src)
      .map((e) => ({ value: [e.dateUnix * 1000, e.ppm], entry: e })),
  }));
  return {
    animation: false,
    legend: { top: 0, textStyle: { color: c.text } },
    grid: { left: 56, right: 16, top: 36, bottom: 56 },
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const q = p as { data: { entry?: TimebaseLogEntry; value: [number, number] } };
        const e = q.data.entry;
        if (!e) {
          return `${new Date(q.data.value[0]).toLocaleString()}<br/>live PPS ${q.data.value[1].toFixed(3)} ppm`;
        }
        return (
          `${new Date(e.dateUnix * 1000).toLocaleString()}<br/>` +
          `<b>${e.ppm.toFixed(3)} ppm</b> (${e.source})<br/>reason: ${e.reason}` +
          (e.durationS > 0 ? `<br/>duration ${e.durationS} s` : '')
        );
      },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
    xAxis: {
      type: 'time',
      axisLabel: { color: c.axis },
      splitLine: { lineStyle: { color: c.grid } },
    },
    yAxis: {
      type: 'value',
      name: 'ppm',
      scale: true,
      axisLabel: { color: c.axis },
      nameTextStyle: { color: c.axis },
      splitLine: { lineStyle: { color: c.grid } },
    },
    series: [
      {
        name: 'log trend',
        type: 'line',
        showSymbol: false,
        silent: true,
        lineStyle: { color: c.axis, width: 1, type: 'dashed' },
        data: entries.value.map((e) => [e.dateUnix * 1000, e.ppm]),
        markArea:
          last && d !== null
            ? {
                silent: true,
                itemStyle: { color: `${c.warning}22` },
                label: {
                  show: true,
                  position: 'insideTopRight',
                  color: c.axis,
                  formatter: `±${d} ppm`,
                },
                data: [[{ yAxis: last.ppm - d }, { yAxis: last.ppm + d }]],
              }
            : undefined,
      },
      ...logSeries,
      {
        name: 'this session (live PPS)',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        lineStyle: { color: c.success, width: 1.5 },
        itemStyle: { color: c.success },
        data: sessionData.value,
      },
    ],
  };
});

const rows = computed(() =>
  [...entries.value].reverse().map((e) => ({
    key: `${e.dateUnix}-${e.source}`,
    local: new Date(e.dateUnix * 1000).toLocaleString(),
    utc: new Date(e.dateUnix * 1000).toISOString().replace('T', ' ').slice(0, 19),
    ppm: `${e.ppm >= 0 ? '+' : '−'}${Math.abs(e.ppm).toFixed(3)}`,
    source: e.source,
    reason: e.reason,
    duration: e.durationS > 0 ? `${e.durationS} s` : '—',
  })),
);

const confirmClear = ref(false);
const deltaInput = ref('');
const deltaValid = computed(() => {
  const v = Number(deltaInput.value);
  return deltaInput.value.trim() !== '' && v >= LOG_DELTA_RANGE.min && v <= LOG_DELTA_RANGE.max;
});

watch(
  delta,
  (d) => {
    if (d !== null && deltaInput.value === '') deltaInput.value = String(d);
  },
  { immediate: true },
);

async function setDelta(): Promise<void> {
  if (!deltaValid.value) return;
  if (await store.setLogDelta(Number(deltaInput.value))) await store.refreshLog();
}
async function doClear(): Promise<void> {
  confirmClear.value = false;
  await store.clearLog();
}

onMounted(() => {
  if (connection.features.timebaseLog) void store.refreshLog();
});
// A deferred write completed: pick up the new entry.
watch(
  () => store.tb?.logPending,
  (now, before) => {
    if (before === true && now === false && connection.features.timebaseLog)
      void store.refreshLog();
  },
);
</script>

<template>
  <v-card v-if="connection.features.timebaseLog">
    <v-card-title class="d-flex align-center flex-wrap">
      Calibration history
      <v-chip
        v-if="pending"
        size="small"
        color="warning"
        class="ml-3"
        prepend-icon="mdi-timer-sand"
      >
        log write waiting
      </v-chip>
      <v-spacer />
      <v-btn prepend-icon="mdi-refresh" @click="store.refreshLog()">Refresh</v-btn>
      <v-btn
        prepend-icon="mdi-delete"
        color="error"
        :disabled="!entries.length || store.working"
        @click="confirmClear = true"
      >
        Clear log
      </v-btn>
    </v-card-title>
    <v-card-text>
      <v-expansion-panels class="mb-3" variant="accordion">
        <v-expansion-panel title="How entries get logged">
          <v-expansion-panel-text class="text-body-2">
            <ul class="pl-4">
              <li>
                A PPS entry is logged when the offset has changed by at least
                <b>logDeltaPpm</b> since the last entry (and at least a day after it), or monthly.
                It needs a full PPS window, 10 minutes of continuous lock and a GPS date.
              </li>
              <li>A successful Save to flash of a manual or NTP calibration also adds an entry.</li>
              <li>At most 24 entries are kept; the oldest is dropped.</li>
              <li>
                Flash is written only when no USB audio stream is open and no quartz measurement is
                running; until then the write is deferred and shown as &ldquo;log write
                waiting&rdquo;.
              </li>
            </ul>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <div v-if="!hasData" class="text-center text-medium-emphasis py-6 mb-3" data-testid="empty">
        <v-icon icon="mdi-chart-line-variant" size="40" />
        <div class="text-subtitle-1 mt-1">No calibration history yet</div>
        <div class="text-body-2">Saving a PC calibration or a GPS PPS lock creates entries.</div>
      </div>
      <v-chart v-else class="hist-chart" :option="option" autoresize />
      <div v-if="hasData" class="text-caption text-medium-emphasis mb-3">
        Dashed line: logged entries. Green line: live PPS ppm in this browser session (kept in
        memory, up to 24 h). Shaded band: &plusmn;logDeltaPpm around the last entry.
      </div>

      <div v-if="stats" class="d-flex flex-wrap ga-6 mb-3" data-testid="drift-stats">
        <div>
          <div class="text-caption text-medium-emphasis">Span</div>
          <div class="text-h6">{{ stats.spanDays.toFixed(1) }} d</div>
        </div>
        <div>
          <div class="text-caption text-medium-emphasis">Min / max</div>
          <div class="text-h6">
            {{ stats.minPpm.toFixed(3) }} / {{ stats.maxPpm.toFixed(3) }} ppm
          </div>
        </div>
        <div>
          <div class="text-caption text-medium-emphasis">Drift (linear fit)</div>
          <div class="text-h6">
            <template v-if="stats.driftPpmPerMonth !== null">
              {{ stats.driftPpmPerMonth >= 0 ? '+' : '−'
              }}{{ Math.abs(stats.driftPpmPerMonth).toFixed(3) }} ppm/month
            </template>
            <template v-else>needs 2+ dates</template>
          </div>
        </div>
      </div>

      <div class="d-flex flex-wrap align-center ga-3 mb-3">
        <v-text-field
          v-model="deltaInput"
          label="logDeltaPpm"
          type="number"
          step="0.05"
          :min="LOG_DELTA_RANGE.min"
          :max="LOG_DELTA_RANGE.max"
          density="compact"
          hide-details
          :error="!deltaValid"
          style="max-width: 160px"
        />
        <v-btn :disabled="!deltaValid || store.working" @click="setDelta">Set threshold</v-btn>
        <span class="text-caption text-medium-emphasis">
          0.05..10 ppm. Sent on its own; the stored calibration is untouched.
        </span>
      </div>

      <v-expansion-panels>
        <v-expansion-panel :title="`Entries (${entries.length})`">
          <v-expansion-panel-text>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>Date (local)</th>
                  <th>UTC</th>
                  <th class="text-right">ppm</th>
                  <th>Source</th>
                  <th>Reason</th>
                  <th class="text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.key">
                  <td>{{ r.local }}</td>
                  <td>{{ r.utc }}</td>
                  <td class="text-right">{{ r.ppm }}</td>
                  <td>{{ r.source }}</td>
                  <td>{{ r.reason }}</td>
                  <td class="text-right">{{ r.duration }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </v-card-text>

    <v-dialog v-model="confirmClear" max-width="420">
      <v-card title="Clear the calibration log?">
        <v-card-text>
          All logged entries are erased from flash. This cannot be undone. It needs the USB audio
          stream to be closed.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirmClear = false">Cancel</v-btn>
          <v-btn color="error" @click="doClear">Clear log</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.hist-chart {
  height: 320px;
  width: 100%;
}
</style>
