<script setup lang="ts">
/**
 * Mechanical panel: headline tiles (rate, beat error, amplitude as the
 * averaged value with the instant one small; A/h, editable lift angle, lock
 * state, jitter), the tick-tock chart with the balance wheel beside it, and the
 * trend chart. UNCALIBRATED is flagged when the firmware has no timebase
 * calibration (`calSource === 'none'`).
 */
import { computed, ref, watch } from 'vue';
import { useMechanicalStore } from '@/stores/mechanical';
import { useDeviceStore } from '@/stores/device';
import { fmtFixed, fmtRate, fmtThousands } from '@/utils/format';
import BalanceWheel from './BalanceWheel.vue';
import MetricTile from './MetricTile.vue';
import TickTockChart from './TickTockChart.vue';
import TrendChart from './TrendChart.vue';

const store = useMechanicalStore();
const device = useDeviceStore();
const r = computed(() => store.rate);
const avg = computed(() => r.value?.avgLong ?? null);

const state = computed(() => {
  const v = r.value;
  if (!v) return { text: 'No data', color: 'default' };
  if (!v.timebaseOk) return { text: 'Checking clock', color: 'warning' };
  if (v.locked) return { text: 'Locked', color: 'success' };
  return { text: 'Acquiring', color: 'info' };
});

const lift = ref<string>('51');
const editing = ref(false);
watch(
  () => r.value?.liftAngleDeg,
  (v) => {
    if (v !== undefined && !editing.value) lift.value = String(v);
  },
  { immediate: true },
);
const liftError = computed(() => {
  const n = Number(lift.value);
  return Number.isFinite(n) && n >= 10 && n <= 90 ? '' : '10 to 90';
});
async function commitLift(): Promise<void> {
  editing.value = false;
  if (liftError.value) return;
  await store.setLiftAngle(Number(lift.value));
}

const showEmpty = computed(() => !r.value || (!r.value.locked && store.ticks.length === 0));
const idleHint = computed(() =>
  device.running
    ? 'Listening: place the watch on the stand. Rate, beat error and amplitude appear once the beat locks.'
    : 'Place the watch on the stand and press Start.',
);
</script>

<template>
  <div>
    <v-alert v-if="showEmpty" type="info" variant="tonal" density="compact" class="mb-3">
      {{ idleHint }}
    </v-alert>

    <div class="d-flex flex-wrap align-center ga-2 mb-2">
      <v-chip :color="state.color" size="small" variant="flat">{{ state.text }}</v-chip>
      <v-chip v-if="r && r.calSource === 'none'" color="amber-darken-2" size="small" variant="flat">
        <v-icon start icon="mdi-alert" />UNCALIBRATED
      </v-chip>
      <v-chip v-else-if="r" size="small" variant="tonal">
        cal {{ r.calSource }} {{ fmtRate(r.calPpm, true, 2) }} ppm
      </v-chip>
    </div>

    <v-row density="compact">
      <v-col cols="12" sm="6" md="3">
        <MetricTile
          label="Rate"
          unit="s/d"
          :value="fmtRate(avg?.rateSDay, avg?.rateValid ?? false, 1)"
          :sub="`instant ${fmtRate(r?.instant.rateSDay, r?.instant.rateValid ?? false, 1)} · + = gaining`"
          :muted="!avg?.rateValid"
        />
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <MetricTile
          label="Beat error"
          unit="ms"
          :value="avg?.beatErrorValid ? fmtFixed(avg.beatErrorMs, 2) : '—'"
          :sub="`instant ${r?.instant.beatErrorValid ? fmtFixed(r.instant.beatErrorMs, 2) : '—'}`"
          :muted="!avg?.beatErrorValid"
        />
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <MetricTile
          label="Amplitude"
          unit="°"
          :value="avg?.amplitudeValid ? fmtFixed(avg.amplitudeDeg, 0) : '—'"
          :sub="`instant ${r?.instant.amplitudeValid ? fmtFixed(r.instant.amplitudeDeg, 0) : '—'}`"
          :muted="!avg?.amplitudeValid"
        />
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <MetricTile
          label="Beat rate"
          unit="A/h"
          :value="r && r.vphNearest > 0 ? fmtThousands(r.vphNearest) : '—'"
          :sub="
            r
              ? `raw ${fmtFixed(r.vphRaw, 0)} · jitter ${fmtFixed(r.jitterUs, 0)} µs · ${r.ratePoints} pts`
              : ''
          "
          :muted="!r || r.vphNearest <= 0"
        >
          <v-text-field
            v-model="lift"
            label="Lift angle"
            suffix="°"
            type="number"
            min="10"
            max="90"
            density="compact"
            variant="underlined"
            hide-details="auto"
            :error-messages="liftError"
            class="mt-1 lift-field"
            @focus="editing = true"
            @blur="commitLift"
            @keydown.enter="commitLift"
          />
        </MetricTile>
      </v-col>
    </v-row>

    <v-row class="mt-1">
      <v-col cols="12" lg="8">
        <TickTockChart />
      </v-col>
      <v-col cols="12" lg="4">
        <BalanceWheel
          :amplitude-deg="avg?.amplitudeValid ? avg.amplitudeDeg : null"
          :vph="r && r.vphNearest > 0 ? r.vphNearest : null"
          :lift-angle-deg="r?.liftAngleDeg ?? 51"
        />
      </v-col>
      <v-col cols="12">
        <TrendChart />
      </v-col>
    </v-row>
  </div>
</template>

<style scoped>
.lift-field {
  max-width: 140px;
}
</style>
