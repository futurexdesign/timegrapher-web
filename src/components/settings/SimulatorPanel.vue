<script setup lang="ts">
/**
 * Developer Simulator panel: drives the virtual device through the
 * {@link SimulatorControl} API only (presets, watch / quartz / GPS / crystal
 * physics, time scale, latency, faults, failure injection, build caps for the
 * next connect) and shows a live "truth" readout from `getSnapshot()`,
 * refreshed through `subscribe(listener)` plus a 1 Hz tick for the clock.
 * Every type comes from the control API (no direct model imports).
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { DspBlockKey, DspFaultReason } from '@/protocol/types';
import { getSimulatorControl, type PresetId, type SimulatorControl } from '@/sim';
import { useConnectionStore } from '@/stores/connection';

type Mech = ReturnType<SimulatorControl['getMechanical']>;
type QSrc = ReturnType<SimulatorControl['getQuartzSource']>;
type GpsP = ReturnType<SimulatorControl['getGps']>;
type Tb = ReturnType<SimulatorControl['getTimebase']>;
type Faults = ReturnType<SimulatorControl['getFaults']>;
type Build = ReturnType<SimulatorControl['getBuild']>;
type Snap = ReturnType<SimulatorControl['getSnapshot']>;
type Attached = ReturnType<SimulatorControl['getAttached']>;

/** A numeric field description. */
interface Field<T> {
  key: keyof T;
  label: string;
  step?: number;
}

const MECH_FIELDS: Field<Mech>[] = [
  { key: 'rateSDay', label: 'Rate (s/d, + gaining)', step: 0.5 },
  { key: 'beatErrorMs', label: 'Beat error (ms)', step: 0.1 },
  { key: 'amplitudeDeg', label: 'Amplitude (deg)', step: 5 },
  { key: 'liftAngleDeg', label: 'Lift angle (deg)', step: 1 },
  { key: 'jitterUs', label: 'Jitter (µs RMS)', step: 5 },
  { key: 'missedBeatProb', label: 'Missed-beat probability', step: 0.01 },
];
const VPH_ITEMS = [14400, 18000, 19800, 21600, 25200, 28800, 36000];
const QSRC_FIELDS: Field<QSrc>[] = [
  { key: 'motorRateSDay', label: 'Motor rate (s/d)', step: 0.1 },
  { key: 'motorStepS', label: 'Motor step (s)', step: 1 },
  { key: 'inhibitionPeriodS', label: 'Inhibition period (s, 0 = none)', step: 10 },
  { key: 'inhibitionJumpUs', label: 'Inhibition jump (µs)', step: 1 },
  { key: 'motorJitterUs', label: 'Motor jitter (µs)', step: 0.1 },
  { key: 'motorSnr', label: 'Motor SNR', step: 0.5 },
  { key: 'lcdRateSDay', label: 'LCD rate (s/d)', step: 0.1 },
  { key: 'lcdPatternHz', label: 'LCD pattern (Hz)', step: 16 },
  { key: 'forkRateSDay', label: 'Fork rate (s/d)', step: 0.1 },
];
const QSRC_FLAGS: { key: keyof QSrc; label: string }[] = [
  { key: 'motorClipped', label: 'Motor ADC clipped' },
  { key: 'lcdNoPattern', label: 'LCD: no pattern' },
];
const GPS_FIELDS: Field<GpsP>[] = [
  { key: 'satCount', label: 'Satellites (max 16)', step: 1 },
  { key: 'fixAfterS', label: 'Fix after (s)', step: 10 },
  { key: 'firstSentenceS', label: 'First sentence (s)', step: 1 },
];
const TB_FIELDS: Field<Tb>[] = [
  { key: 'crystalPpm', label: 'Crystal error (ppm, + fast)', step: 0.5 },
  { key: 'driftPpm', label: 'Drift amplitude (ppm)', step: 0.5 },
  { key: 'driftPeriodS', label: 'Drift period (s)', step: 60 },
];
const WATCH_ITEMS: { title: string; value: Attached }[] = [
  { title: 'None', value: 'none' },
  { title: 'Mechanical', value: 'mechanical' },
  { title: 'Quartz motor', value: 'motor' },
  { title: 'LCD', value: 'lcd' },
  { title: 'Tuning fork', value: 'fork' },
];
const FAULT_FLAGS: { key: keyof Faults; label: string }[] = [
  { key: 'timebaseUnverified', label: 'timebaseUnverified' },
  { key: 'unsupportedRate', label: 'unsupportedRate' },
  { key: 'flashBusy', label: 'flashBusy' },
  { key: 'flashError', label: 'flashError' },
  { key: 'backendUnhealthy', label: 'backendUnhealthy' },
];
const BUILD_FLAGS: { key: keyof Build; label: string }[] = [
  { key: 'quartz', label: 'Quartz engine' },
  { key: 'gps', label: 'GPS' },
  { key: 'pps', label: 'PPS' },
];
const FALLBACK_BLOCKS: DspBlockKey[] = ['gain', 'limiter', 'filterBank', 'eventDetect', 'agc'];
const REASONS: DspFaultReason[] = ['underrun', 'usbStall', 'overload'];

/** Everything shown, read in one go from the control. */
interface Readout {
  mech: Mech;
  qsrc: QSrc;
  gps: GpsP;
  tb: Tb;
  faults: Faults;
  build: Build;
  attached: Attached;
  autoAttach: boolean;
  usb: boolean;
  timeScale: number;
  latency: number;
  snap: Snap;
}

const connection = useConnectionStore();

/** The active control; re-evaluated on connect / disconnect. */
const control = computed<SimulatorControl | undefined>(() => {
  return connection.transport === null ? undefined : getSimulatorControl();
});

const state = shallowRef<Readout | null>(null);
const failCount = ref(3);
const errBlock = ref<DspBlockKey>('gain');
const errReason = ref<DspFaultReason>('underrun');
const blocks = computed<DspBlockKey[]>(() =>
  connection.caps?.blocks.length ? connection.caps.blocks : FALLBACK_BLOCKS,
);

/** Reads all values from the control. */
function readAll(): void {
  const c = control.value;
  if (!c) {
    state.value = null;
    return;
  }
  state.value = {
    mech: c.getMechanical(),
    qsrc: c.getQuartzSource(),
    gps: c.getGps(),
    tb: c.getTimebase(),
    faults: c.getFaults(),
    build: c.getBuild(),
    attached: c.getAttached(),
    autoAttach: c.getAutoAttach(),
    usb: c.getUsbStreaming(),
    timeScale: c.getTimeScale(),
    latency: c.getLatencyMs(),
    snap: c.getSnapshot(),
  };
}

let off: (() => void) | null = null;
watch(
  control,
  (c) => {
    off?.();
    off = c ? c.subscribe(readAll) : null;
    readAll();
  },
  { immediate: true },
);
const timer = setInterval(readAll, 1000);
onBeforeUnmount(() => {
  off?.();
  clearInterval(timer);
});

/** Log10 of the time scale, the slider's unit. */
const logScale = computed(() => Math.log10(state.value?.timeScale ?? 1));

/**
 * Parses a text-field value; NaN when not a finite number.
 * @param v Field value.
 */
function num(v: string | number): number {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

/**
 * Sets a numeric field via a setter when the input parses.
 * @param v Field value.
 * @param apply Called with the number.
 */
function setNum(v: string | number, apply: (n: number) => void): void {
  const n = num(v);
  if (Number.isFinite(n)) apply(n);
}

/** Applies a preset. @param id Preset id. */
function preset(id: PresetId): void {
  control.value?.applyPreset(id);
}

/** Formats a number for the truth readout. @param n Value. @param d Decimals. */
function f(n: number, d = 2): string {
  return n.toFixed(d);
}
</script>

<template>
  <div v-if="!control || !state" class="text-medium-emphasis" data-testid="sim-none">
    No virtual device is open. Connect to the virtual device to use the simulator.
  </div>
  <div v-else data-testid="simulator">
    <div class="text-subtitle-2 mb-1">Presets</div>
    <div class="d-flex flex-wrap ga-2 mb-4">
      <v-tooltip v-for="p in control.presets" :key="p.id" :text="p.description" location="top">
        <template #activator="{ props }">
          <v-btn v-bind="props" size="small" variant="tonal" @click="preset(p.id)">
            {{ p.label }}
          </v-btn>
        </template>
      </v-tooltip>
    </div>
    <ul class="text-caption text-medium-emphasis mb-4 pl-4">
      <li v-for="p in control.presets" :key="p.id">
        <b>{{ p.label }}:</b> {{ p.description }}
      </li>
    </ul>

    <div class="text-subtitle-2 mb-1">Watch on the stand</div>
    <v-select
      :model-value="state.attached"
      :items="WATCH_ITEMS"
      label="Attached watch"
      density="compact"
      @update:model-value="(v: Attached) => control?.setAttached(v)"
    />
    <v-switch
      :model-value="state.autoAttach"
      label="Swap the watch to match the quartz mode chosen in the app"
      hint="Off: the watch only changes here, so a mismatched mode sees no signal (wrong-watch test)."
      persistent-hint
      color="primary"
      density="compact"
      class="mb-3"
      @update:model-value="(v: boolean | null) => control?.setAutoAttach(Boolean(v))"
    />

    <div class="text-subtitle-2 mb-1">Mechanical watch</div>
    <v-row density="compact">
      <v-col cols="12" sm="6" md="4">
        <v-select
          :model-value="state.mech.vph"
          :items="VPH_ITEMS"
          label="Beats per hour"
          density="compact"
          @update:model-value="(v: number) => control?.setMechanical({ vph: v })"
        />
      </v-col>
      <v-col v-for="fl in MECH_FIELDS" :key="fl.key" cols="12" sm="6" md="4">
        <v-text-field
          :model-value="state.mech[fl.key]"
          :label="fl.label"
          type="number"
          :step="fl.step"
          density="compact"
          @update:model-value="
            (v: string | number) => setNum(v, (n) => control?.setMechanical({ [fl.key]: n }))
          "
        />
      </v-col>
    </v-row>

    <div class="text-subtitle-2 mb-1">Quartz source</div>
    <v-row density="compact">
      <v-col v-for="fl in QSRC_FIELDS" :key="fl.key" cols="12" sm="6" md="4">
        <v-text-field
          :model-value="state.qsrc[fl.key]"
          :label="fl.label"
          type="number"
          :step="fl.step"
          density="compact"
          @update:model-value="
            (v: string | number) => setNum(v, (n) => control?.setQuartzSource({ [fl.key]: n }))
          "
        />
      </v-col>
    </v-row>
    <div class="d-flex flex-wrap ga-4 mb-2">
      <v-switch
        v-for="fl in QSRC_FLAGS"
        :key="fl.key"
        :model-value="state.qsrc[fl.key] as boolean"
        :label="fl.label"
        density="compact"
        hide-details
        @update:model-value="(v) => control?.setQuartzSource({ [fl.key]: Boolean(v) })"
      />
    </div>

    <div class="text-subtitle-2 mb-1">GPS</div>
    <div class="d-flex flex-wrap ga-4 align-center mb-2">
      <v-switch
        :model-value="state.gps.antenna"
        label="Antenna with sky view"
        density="compact"
        hide-details
        @update:model-value="(v) => control?.setGps({ antenna: Boolean(v) })"
      />
      <v-btn
        size="small"
        variant="tonal"
        prepend-icon="mdi-power-cycle"
        @click="control.gpsColdStart()"
      >
        Cold start
      </v-btn>
    </div>
    <v-row density="compact">
      <v-col v-for="fl in GPS_FIELDS" :key="fl.key" cols="12" sm="6" md="4">
        <v-text-field
          :model-value="state.gps[fl.key]"
          :label="fl.label"
          type="number"
          :step="fl.step"
          density="compact"
          :disabled="fl.key === 'satCount' && !connection.features.gps"
          @update:model-value="
            (v: string | number) => setNum(v, (n) => control?.setGps({ [fl.key]: n }))
          "
        />
      </v-col>
    </v-row>

    <div class="text-subtitle-2 mb-1">Board crystal</div>
    <v-row density="compact">
      <v-col v-for="fl in TB_FIELDS" :key="fl.key" cols="12" sm="6" md="4">
        <v-text-field
          :model-value="state.tb[fl.key]"
          :label="fl.label"
          type="number"
          :step="fl.step"
          density="compact"
          @update:model-value="
            (v: string | number) => setNum(v, (n) => control?.setTimebase({ [fl.key]: n }))
          "
        />
      </v-col>
    </v-row>

    <div class="text-subtitle-2 mb-1">Time and link</div>
    <v-slider
      :model-value="logScale"
      :min="-2"
      :max="6"
      :step="0.1"
      :label="`Time scale ×${f(state.timeScale, state.timeScale < 10 ? 2 : 0)}`"
      density="compact"
      hide-details
      class="mb-2"
      @update:model-value="(v: number) => control?.setTimeScale(10 ** v)"
    />
    <v-text-field
      :model-value="state.latency"
      label="Request latency (ms)"
      type="number"
      min="0"
      density="compact"
      @update:model-value="(v: string | number) => setNum(v, (n) => control?.setLatencyMs(n))"
    />

    <div class="text-subtitle-2 mb-1">Faults</div>
    <div class="d-flex flex-wrap ga-x-4 mb-2">
      <v-switch
        v-for="fl in FAULT_FLAGS"
        :key="fl.key"
        :model-value="state.faults[fl.key]"
        :label="fl.label"
        density="compact"
        hide-details
        @update:model-value="(v) => control?.setFaults({ [fl.key]: Boolean(v) })"
      />
      <v-switch
        :model-value="state.usb"
        label="usbStreaming"
        density="compact"
        hide-details
        @update:model-value="(v) => control?.setUsbStreaming(Boolean(v))"
      />
    </div>

    <div class="d-flex flex-wrap ga-2 align-center mb-2">
      <v-text-field
        v-model.number="failCount"
        label="N"
        type="number"
        min="0"
        density="compact"
        hide-details
        style="max-width: 6rem"
      />
      <v-btn size="small" variant="tonal" @click="control.failNextRequests(failCount)">
        Fail next N requests
      </v-btn>
    </div>
    <div class="d-flex flex-wrap ga-2 align-center mb-2">
      <v-select
        v-model="errBlock"
        :items="blocks"
        label="Block"
        density="compact"
        hide-details
        style="max-width: 11rem"
      />
      <v-select
        v-model="errReason"
        :items="REASONS"
        label="Reason"
        density="compact"
        hide-details
        style="max-width: 11rem"
      />
      <v-btn size="small" variant="tonal" @click="control.injectDspError(errBlock, errReason)">
        Inject DSP error
      </v-btn>
      <v-btn size="small" variant="tonal" @click="control.injectSampleLoss()">Sample loss</v-btn>
      <v-btn size="small" color="error" variant="tonal" @click="control.disconnect('simulated')">
        Disconnect
      </v-btn>
    </div>

    <div class="text-subtitle-2 mb-1">Build caps (applied at the next connect)</div>
    <div class="d-flex flex-wrap ga-4 mb-4">
      <v-switch
        v-for="fl in BUILD_FLAGS"
        :key="fl.key"
        :model-value="state.build[fl.key]"
        :label="fl.label"
        density="compact"
        hide-details
        @update:model-value="(v) => control?.setBuild({ [fl.key]: Boolean(v) })"
      />
    </div>

    <div class="text-subtitle-2 mb-1">Truth</div>
    <v-table density="compact" data-testid="sim-truth">
      <tbody>
        <tr>
          <th>Sim time</th>
          <td>{{ f(state.snap.simWallS, 1) }} s (×{{ f(state.snap.timeScale) }})</td>
        </tr>
        <tr>
          <th>Running / attached</th>
          <td>{{ state.snap.running ? 'running' : 'stopped' }} / {{ state.snap.attached }}</td>
        </tr>
        <tr>
          <th>Quartz mode</th>
          <td>{{ state.snap.quartzMode }}</td>
        </tr>
        <tr>
          <th>True crystal error</th>
          <td>{{ f(state.snap.xtalPpm) }} ppm (+ = fast)</td>
        </tr>
        <tr>
          <th>Correction in effect</th>
          <td>{{ f(state.snap.effectiveCalPpm) }} ppm ({{ state.snap.effectiveCalSource }})</td>
        </tr>
        <tr>
          <th>Expected mechanical rate</th>
          <td>{{ f(state.snap.expectedMechanicalRateSDay) }} s/d</td>
        </tr>
        <tr>
          <th>GPS</th>
          <td>
            {{ state.snap.gpsFix ? 'fix' : 'no fix'
            }}<span v-if="state.snap.gpsUtcUnix">
              , UTC {{ new Date(state.snap.gpsUtcUnix * 1000).toISOString().slice(11, 19) }}</span
            >
          </td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>
