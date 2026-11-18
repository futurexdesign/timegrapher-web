<script setup lang="ts">
/**
 * One parameter row of a block card: renders the control kind from the
 * {@link ParamMeta} (slider, select, switch, read-only value), a live value for
 * read-only telemetry, and a "reset to default" button. Reads and writes the
 * DSP state store (optimistic, debounced).
 */
import { computed, ref } from 'vue';
import type { DspBlockKey } from '@/protocol/types';
import { useDspStateStore } from '@/stores/dspState';
import { useMetricsStore } from '@/stores/metrics';
import { validateParam, type ParamMeta } from '@/utils/dspMeta';

const props = defineProps<{
  /** Owning block. */
  blockKey: DspBlockKey;
  /** Parameter metadata. */
  param: ParamMeta;
}>();

const dsp = useDspStateStore();
const metrics = useMetricsStore();

/** Current value: live metrics for AGC gain / match score, else the state. */
const value = computed<number | undefined>(() => {
  if (props.param.kind === 'readonly') {
    const m = metrics.latest;
    if (m && props.blockKey === 'agc' && props.param.key === 'gainDb') return m.agcGainDb;
    if (m && props.blockKey === 'matchedFilter' && props.param.key === 'score') return m.matchScore;
  }
  return dsp.paramValue(props.blockKey, props.param.key);
});

const decimals = computed(() => {
  const step = props.param.step ?? 1;
  const s = String(step);
  return s.includes('.') ? (s.split('.')[1]?.length ?? 0) : 0;
});

const display = computed(() => {
  const v = value.value;
  if (v === undefined) return '-';
  const num =
    Number.isInteger(v) && decimals.value === 0 ? String(v) : v.toFixed(decimals.value || 2);
  const unit = props.param.unit;
  return unit ? `${num} ${unit}` : num;
});

const isDefault = computed(() => {
  const v = value.value;
  return v === undefined || Math.abs(v - props.param.default) < 1e-6;
});

/** Writes a value; selects and switches send immediately, sliders are debounced. */
function set(v: number | null): void {
  if (v === null) return;
  const delay = props.param.kind === 'slider' ? undefined : 0;
  dsp.setParam(props.blockKey, props.param.key, v, delay);
}

const comboError = ref<string | null>(null);

/** Combobox entry: a listed item (number) or typed text; invalid input is not sent. */
function setCombo(raw: unknown): void {
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  const err =
    typeof raw === 'string' && raw.trim() === '' ? 'Enter a number' : validateParam(props.param, v);
  comboError.value = err;
  if (err === null) dsp.setParam(props.blockKey, props.param.key, v, 0);
}

function reset(): void {
  comboError.value = null;
  dsp.setParam(props.blockKey, props.param.key, props.param.default, 0);
}
</script>

<template>
  <div v-if="param.readOnly || value !== undefined" class="param-row">
    <div class="d-flex align-center">
      <span class="text-body-2 flex-grow-1">{{ param.label }}</span>
      <span class="text-body-2 font-weight-medium tabular" :data-testid="`val-${param.key}`">
        {{ display }}
      </span>
      <v-btn
        v-if="!param.readOnly"
        icon="mdi-restore"
        size="x-small"
        variant="text"
        density="comfortable"
        :disabled="isDefault"
        :aria-label="`Reset ${param.label} to default`"
        title="Reset to default"
        @click="reset"
      />
    </div>
    <v-slider
      v-if="param.kind === 'slider'"
      :model-value="value"
      :min="param.min"
      :max="param.max"
      :step="param.step"
      density="compact"
      hide-details
      color="primary"
      :aria-label="param.label"
      @update:model-value="set"
    />
    <v-select
      v-else-if="param.kind === 'select'"
      :model-value="value"
      :items="param.options"
      item-title="title"
      item-value="value"
      density="compact"
      variant="outlined"
      hide-details
      :aria-label="param.label"
      @update:model-value="set"
    />
    <v-combobox
      v-else-if="param.kind === 'combo'"
      :model-value="value"
      :items="param.options"
      item-title="title"
      item-value="value"
      :return-object="false"
      density="compact"
      variant="outlined"
      :error-messages="comboError ?? undefined"
      :hide-details="comboError === null"
      :aria-label="param.label"
      @update:model-value="setCombo"
    />
    <v-switch
      v-else-if="param.kind === 'switch'"
      :model-value="(value ?? 0) >= 0.5"
      density="compact"
      hide-details
      color="primary"
      :aria-label="param.label"
      @update:model-value="(v) => set(v ? 1 : 0)"
    />
    <div class="text-caption text-medium-emphasis">{{ param.help }}</div>
  </div>
</template>

<style scoped>
.param-row {
  margin-bottom: 8px;
}
.tabular {
  font-variant-numeric: tabular-nums;
}
</style>
