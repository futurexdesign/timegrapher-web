<script setup lang="ts">
/**
 * Active sample-clock correction: the ppm in effect and where it comes from,
 * its expected timing effect, the stored calibration (RAM vs flash) and the
 * actions Save / Clear / manual entry. Data comes from the timebase store
 * (polled by the parent view).
 */
import { computed, ref } from 'vue';
import { useTimebaseStore } from '@/stores/timebase';
import { ppmToSecPerDay } from '@/utils/calibration';
import type { TimebaseSource } from '@/protocol/timegrapher_hid';

const store = useTimebaseStore();
const tb = computed(() => store.tb);

const SOURCE_TEXT: Record<TimebaseSource, string> = {
  none: 'No correction: timing assumes the nominal sample rate. Calibrate for trustworthy rates.',
  manual: 'Entered by hand (stored in RAM; save to flash to keep it).',
  ntp: 'Measured against this computer’s NTP-synchronised clock (PC calibration).',
  pps: 'Tracked live from the GPS 1 PPS pulse; it overrides the stored value while locked.',
};

/** Signed ppm text. */
function signed(v: number, digits = 3): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

const calDate = computed(() =>
  tb.value && tb.value.dateUnix > 0 ? new Date(tb.value.dateUnix * 1000).toLocaleString() : null,
);
const duration = computed(() => {
  const s = tb.value?.durationS ?? 0;
  if (s <= 0) return null;
  return s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
});

const dialog = ref(false);
const confirmClear = ref(false);
const manual = ref('0');
const manualNum = computed(() => Number(manual.value));
const manualValid = computed(
  () =>
    manual.value.trim() !== '' &&
    Number.isFinite(manualNum.value) &&
    Math.abs(manualNum.value) <= 1000,
);

function openManual(): void {
  manual.value = String(tb.value?.calPpm ?? 0);
  dialog.value = true;
}
async function submitManual(): Promise<void> {
  if (!manualValid.value) return;
  if (await store.setTimebase({ ppm: manualNum.value, source: 'manual' })) dialog.value = false;
}
async function doClear(): Promise<void> {
  confirmClear.value = false;
  await store.clear();
}
</script>

<template>
  <v-card>
    <v-card-title class="d-flex align-center">
      Active correction
      <v-spacer />
      <v-chip
        v-if="tb"
        size="small"
        :color="tb.source === 'none' ? 'warning' : 'success'"
        :prepend-icon="tb.source === 'none' ? 'mdi-alert' : 'mdi-check'"
      >
        {{ tb.source }}
      </v-chip>
    </v-card-title>
    <v-card-text v-if="tb">
      <v-alert
        v-if="tb.source === 'none'"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-3"
      >
        Uncalibrated: all timing results are based on the nominal sample rate.
      </v-alert>
      <div class="d-flex flex-wrap align-baseline ga-4">
        <div>
          <div class="text-h4 font-weight-medium" data-testid="ppm-in-effect">
            {{ signed(tb.ppm) }}<span class="text-body-1 ml-1">ppm</span>
          </div>
          <div class="text-caption text-medium-emphasis">+ = board clock fast</div>
        </div>
        <div>
          <div class="text-h6">{{ signed(ppmToSecPerDay(tb.ppm), 2) }} s/d</div>
          <div class="text-caption text-medium-emphasis">
            expected effect on timing (&asymp; 0.0864 s/d per ppm)
          </div>
        </div>
      </div>
      <p class="text-body-2 mt-2">{{ SOURCE_TEXT[tb.source] }}</p>

      <v-divider class="my-3" />
      <div class="text-subtitle-2 mb-1">Stored calibration</div>
      <v-table density="compact">
        <tbody>
          <tr>
            <td>Value</td>
            <td>
              {{ signed(tb.calPpm) }} ppm ({{ tb.calSource }})
              <v-chip size="x-small" :color="tb.saved ? 'success' : 'warning'" class="ml-1">
                {{ tb.saved ? 'saved to flash' : 'unsaved (RAM only)' }}
              </v-chip>
            </td>
          </tr>
          <tr>
            <td>Measured</td>
            <td>{{ calDate ?? 'unknown' }}</td>
          </tr>
          <tr>
            <td>Duration</td>
            <td>{{ duration ?? 'unknown / manual' }}</td>
          </tr>
        </tbody>
      </v-table>
    </v-card-text>
    <v-card-text v-else>Waiting for the device...</v-card-text>
    <v-card-actions class="flex-wrap">
      <v-btn prepend-icon="mdi-pencil" :disabled="!tb" @click="openManual">Manual entry</v-btn>
      <v-spacer />
      <v-btn
        prepend-icon="mdi-content-save"
        color="primary"
        variant="tonal"
        :disabled="!tb || tb.saved || store.working"
        :loading="store.working"
        @click="store.save()"
      >
        Save to flash
      </v-btn>
      <v-btn
        prepend-icon="mdi-delete"
        color="error"
        :disabled="!tb || tb.calSource === 'none' || store.working"
        @click="confirmClear = true"
      >
        Clear
      </v-btn>
    </v-card-actions>

    <v-dialog v-model="dialog" max-width="420">
      <v-card title="Manual correction">
        <v-card-text>
          <v-text-field
            v-model="manual"
            label="Clock error (ppm)"
            hint="-1000..1000; + = board clock fast. Stored in RAM with source manual."
            persistent-hint
            type="number"
            step="0.001"
            :error="!manualValid"
            autofocus
            @keyup.enter="submitManual"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">Cancel</v-btn>
          <v-btn color="primary" :disabled="!manualValid" @click="submitManual">Set</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="confirmClear" max-width="420">
      <v-card title="Clear the stored calibration?">
        <v-card-text>
          The stored correction is reset to 0 ppm / none in RAM. Flash is only changed if you save
          afterwards. A locked PPS keeps correcting.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirmClear = false">Cancel</v-btn>
          <v-btn color="error" @click="doClear">Clear</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
