<script setup lang="ts">
/**
 * Quartz panel (motor / LCD / fork): headline rate (motor: with inhibition;
 * LCD / fork: oscillator rate), raw and uncalibrated rates, state chip and the
 * firmware `reason`, motor inhibition details, gate progress and selector,
 * fork frequency, and SNR / weak-signal / clipping hints. The motor pulse
 * residual chart is shown in motor mode.
 */
import { computed, ref, watch } from 'vue';
import { useQuartzStore } from '@/stores/quartz';
import { useDeviceStore } from '@/stores/device';
import { fmtDuration, fmtFixed, fmtRate } from '@/utils/format';
import { inhibitionText, isValidGate, QUARTZ_STATE_LABEL, quartzRates } from '@/utils/quartzPulses';
import MetricTile from './MetricTile.vue';
import PulseResidualChart from './PulseResidualChart.vue';

const store = useQuartzStore();
const device = useDeviceStore();
const q = computed(() => store.quartz);
const rates = computed(() => (q.value ? quartzRates(q.value) : null));
const motor = computed(() => q.value?.motor ?? null);

const stateColor = computed(() => {
  switch (q.value?.state) {
    case 'measuring':
      return 'success';
    case 'acquiring':
    case 'waitTimebase':
      return 'info';
    case 'unsupportedRate':
      return 'error';
    case 'done':
      return 'primary';
    default:
      return 'default';
  }
});

const progress = computed(() => {
  const v = q.value;
  if (!v || v.gateS <= 0) return null;
  return Math.min(100, (v.elapsedS / v.gateS) * 100);
});

/* Gate selector: presets 0 / 10 / 60 or custom 3..960. */
const GATE_PRESETS = [0, 10, 60];
const gateChoice = ref<number | 'custom'>(0);
const customGate = ref('120');
watch(
  () => store.settings?.gateS ?? q.value?.gateS,
  (g) => {
    if (g === undefined) return;
    if (GATE_PRESETS.includes(g)) gateChoice.value = g;
    else {
      gateChoice.value = 'custom';
      customGate.value = String(g);
    }
  },
  { immediate: true },
);
const customValid = computed(
  () => isValidGate(Number(customGate.value)) && Number(customGate.value) > 0,
);
async function onGate(v: number | 'custom'): Promise<void> {
  gateChoice.value = v;
  if (v !== 'custom') await store.setGate(v);
}
async function applyCustom(): Promise<void> {
  if (customValid.value) await store.setGate(Number(customGate.value));
}

const FORK_HZ = [300, 341.333, 360, 480, 720];

const hints = computed(() => {
  const out: { text: string; color: string }[] = [];
  const v = q.value;
  if (!v) return out;
  if (v.motor?.hintWeakSignal) {
    out.push({ text: 'Weak signal: reposition the watch closer to the coil', color: 'warning' });
  }
  if (v.motor?.hintClipped) {
    out.push({ text: 'Signal clipping: open jumper JP1 (reduce gain)', color: 'error' });
  } else if (v.motor?.clipped || v.lcd?.clipped || v.fork?.clipped) {
    out.push({ text: 'Input clipped', color: 'warning' });
  }
  if (v.lcd?.status === 'no_pattern') {
    out.push({ text: 'No LCD pattern found: adjust the pickup', color: 'warning' });
  }
  return out;
});

const idleHint = computed(() =>
  device.running
    ? 'Measuring: keep the watch steady near the pickup.'
    : 'Place the watch on the stand and press Start.',
);
</script>

<template>
  <div>
    <v-alert
      v-if="!q || q.state === 'idle'"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-3"
    >
      {{ idleHint }}
    </v-alert>

    <div v-if="q" class="d-flex flex-wrap align-center ga-2 mb-2">
      <v-chip :color="stateColor" size="small" variant="flat">
        {{ QUARTZ_STATE_LABEL[q.state] }}
      </v-chip>
      <v-chip v-if="!q.calibrated" color="amber-darken-2" size="small" variant="flat">
        <v-icon start icon="mdi-alert" />UNCALIBRATED
      </v-chip>
      <v-chip v-else size="small" variant="tonal">
        cal {{ q.calSource }} {{ fmtRate(q.calPpm, true, 2) }} ppm
      </v-chip>
      <v-chip v-if="motor?.rebuilding" size="small" variant="tonal">refitting</v-chip>
      <span v-if="q.reason" class="text-body-2 text-medium-emphasis">{{ q.reason }}</span>
    </div>

    <div v-for="h in hints" :key="h.text" class="mb-2">
      <v-alert :type="h.color === 'error' ? 'error' : 'warning'" variant="tonal" density="compact">
        {{ h.text }}
      </v-alert>
    </div>

    <v-row density="compact">
      <v-col cols="12" sm="6" md="4">
        <MetricTile
          :label="q?.mode === 'motor' ? 'Rate with inhibition' : 'Oscillator rate'"
          unit="s/d"
          :value="rates ? fmtRate(rates.headline, rates.valid, 2) : '\u2014'"
          :sub="
            rates
              ? `raw ${fmtRate(rates.raw, rates.valid, 2)} \u00B7 uncal ${fmtRate(rates.uncal, rates.valid, 2)} \u00B7 + = gaining`
              : ''
          "
          :muted="!rates?.valid"
        />
      </v-col>
      <v-col v-if="motor" cols="12" sm="6" md="4">
        <MetricTile
          label="Inhibition"
          :value="inhibitionText(motor.inhibition)"
          :sub="
            motor.events > 0
              ? `${motor.events} event${motor.events > 1 ? 's' : ''} \u00B7 period ${motor.inhibitionPeriodValid ? fmtFixed(motor.inhibitionPeriodS, 1) + ' s' : '\u2014'} \u00B7 last jump ${fmtFixed(motor.jumpLastUs, 0)} \u00B5s (n = ${motor.jumpLastN} at 8192 Hz)`
              : `jump threshold ${fmtFixed(motor.jumpThresholdUs, 0)} \u00B5s`
          "
        />
      </v-col>
      <v-col cols="12" sm="6" md="4">
        <MetricTile
          label="Signal"
          :value="motor ? `SNR ${fmtFixed(motor.peakSnr, 0)}` : q ? 'OK' : '\u2014'"
          :sub="
            motor
              ? `${motor.pulses} pulses \u00B7 step ${fmtFixed(motor.stepS, 1)} s \u00B7 residual ${fmtFixed(motor.residualRmsUs, 1)} \u00B5s rms`
              : q?.lcd
                ? `${q.lcd.f0Hz} Hz pattern \u00B7 ${q.lcd.blocks} blocks \u00B7 ${q.lcd.status}`
                : q?.fork
                  ? `${fmtFixed(q.fork.fNomHz, 3)} Hz \u00B7 ${q.fork.blocks} blocks`
                  : ''
          "
        />
      </v-col>
    </v-row>

    <v-card v-if="q" class="pa-3 mt-2">
      <div class="d-flex flex-wrap align-center ga-4">
        <div v-if="q.mode === 'motor'" class="d-flex flex-wrap align-center ga-3">
          <span class="text-subtitle-2">Gate</span>
          <v-btn-toggle
            :model-value="gateChoice"
            mandatory
            density="compact"
            variant="outlined"
            divided
            @update:model-value="onGate"
          >
            <v-btn :value="0" size="small">2 events</v-btn>
            <v-btn :value="10" size="small">10 s</v-btn>
            <v-btn :value="60" size="small">60 s</v-btn>
            <v-btn value="custom" size="small">Custom</v-btn>
          </v-btn-toggle>
          <v-text-field
            v-if="gateChoice === 'custom'"
            v-model="customGate"
            type="number"
            label="Gate (s)"
            min="3"
            max="960"
            density="compact"
            variant="outlined"
            hide-details
            :error="!customValid"
            style="max-width: 120px"
            @keydown.enter="applyCustom"
            @blur="applyCustom"
          />
        </div>
        <div v-if="q.mode === 'fork'" class="d-flex align-center ga-3">
          <v-select
            :model-value="store.settings?.forkHz ?? q.forkHz"
            :items="FORK_HZ"
            label="Fork frequency"
            suffix="Hz"
            density="compact"
            variant="outlined"
            hide-details
            style="min-width: 190px"
            @update:model-value="(v: number) => store.setForkHz(v)"
          />
        </div>
        <div class="flex-grow-1" style="min-width: 220px">
          <div class="text-caption text-medium-emphasis">
            {{ fmtDuration(q.elapsedS) }}
            <template v-if="q.gateS > 0"> / {{ fmtDuration(q.gateS) }}</template>
            <template v-else-if="q.mode === 'motor'"> (until two inhibition events)</template>
          </div>
          <v-progress-linear
            :model-value="progress ?? 0"
            :indeterminate="progress === null && q.mode === 'motor' && q.state === 'measuring'"
            height="6"
            rounded
            color="primary"
          />
        </div>
      </div>
    </v-card>

    <div v-if="q?.mode === 'motor'" class="mt-3">
      <PulseResidualChart />
    </div>
  </div>
</template>
