<script setup lang="ts">
/**
 * GPS status card (shown only with `caps.gps`): ticking UTC, fix and quality,
 * satellites, DOPs and an optional (default hidden) position. With `caps.pps`
 * a PPS sub-card shows the lock state and counters from `getTimebase`.
 * Data is polled by the parent view (gps + timebase stores).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useGpsStore } from '@/stores/gps';
import { useTimebaseStore } from '@/stores/timebase';

const connection = useConnectionStore();
const gps = useGpsStore();
const timebase = useTimebaseStore();

const info = computed(() => gps.info);
const pps = computed(() => timebase.tb?.pps ?? null);

const QUALITY: Record<number, string> = {
  0: 'no fix',
  1: 'GPS',
  2: 'DGPS',
  4: 'RTK fixed',
  5: 'RTK float',
  6: 'dead reckoning',
};

/** Local clock ticking once a second to advance the displayed UTC between polls. */
const now = ref(Date.now());
let polledAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});
watch(info, () => {
  polledAt = Date.now();
});

const utc = computed(() => {
  const i = info.value;
  if (!i || i.utcUnix === 0) return null;
  return new Date(i.utcUnix * 1000 + Math.max(0, i.ageMs) + (now.value - polledAt));
});
const utcDate = computed(() => utc.value?.toISOString().slice(0, 10) ?? '—');
const utcTime = computed(() => utc.value?.toISOString().slice(11, 19) ?? '—');

const fmt = (v: number, d = 2): string => (v > 0 ? v.toFixed(d) : '—');
</script>

<template>
  <v-card v-if="connection.features.gps">
    <v-card-title class="d-flex align-center">
      GPS
      <v-spacer />
      <v-chip v-if="info" size="small" :color="info.fix ? 'success' : 'warning'">
        {{ info.fix ? 'fix' : 'no fix' }}
      </v-chip>
    </v-card-title>
    <v-card-text v-if="info">
      <div class="d-flex flex-wrap ga-6 mb-3">
        <div>
          <div class="text-caption text-medium-emphasis">UTC</div>
          <div class="text-h5 font-weight-medium" data-testid="utc">
            {{ utcTime }}<span class="text-caption ml-1">UTC</span>
          </div>
          <div class="text-body-2">{{ utcDate }}</div>
        </div>
        <div>
          <div class="text-caption text-medium-emphasis">Quality</div>
          <div class="text-h6">{{ QUALITY[info.quality] ?? `q${info.quality}` }}</div>
          <div class="text-body-2">
            {{ info.ageMs >= 0 ? `RMC ${(info.ageMs / 1000).toFixed(1)} s ago` : 'no RMC yet' }}
          </div>
        </div>
        <div>
          <div class="text-caption text-medium-emphasis">Satellites</div>
          <div class="text-h6">{{ info.satsUsed }} used</div>
          <div class="text-body-2">{{ info.sats.length }} in view</div>
        </div>
        <div>
          <div class="text-caption text-medium-emphasis">DOP</div>
          <div class="text-body-1">
            H {{ fmt(info.hdop) }} &middot; P {{ fmt(info.pdop) }} &middot; V {{ fmt(info.vdop) }}
          </div>
        </div>
      </div>

      <div class="d-flex align-center justify-space-between flex-wrap">
        <span class="text-subtitle-2">Position</span>
        <v-switch
          :model-value="!gps.hidePosition"
          label="Show position"
          density="compact"
          hide-details
          color="primary"
          class="flex-grow-0"
          @update:model-value="gps.setHidePosition(!$event)"
        />
      </div>
      <div class="text-body-1" data-testid="position">
        <template v-if="gps.hidePosition">hidden</template>
        <template v-else-if="info.posValid">
          {{ info.lat.toFixed(6) }}&deg;, {{ info.lon.toFixed(6) }}&deg; &middot;
          {{ info.altM.toFixed(1) }} m
        </template>
        <template v-else>no position yet</template>
      </div>

      <template v-if="connection.features.pps">
        <v-divider class="my-3" />
        <v-card variant="tonal" data-testid="pps-card">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            PPS
            <v-spacer />
            <v-chip v-if="pps" size="small" :color="pps.locked ? 'success' : 'warning'">
              {{ pps.locked ? 'locked' : 'not locked' }}
            </v-chip>
          </v-card-title>
          <v-card-text v-if="pps" class="d-flex flex-wrap ga-6">
            <div>
              <div class="text-caption text-medium-emphasis">ppm</div>
              <div class="text-h6">{{ pps.locked ? pps.ppm.toFixed(3) : '—' }}</div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">window</div>
              <div class="text-h6">{{ pps.window }} s</div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">good / rejects / no-fix</div>
              <div class="text-h6">{{ pps.good }} / {{ pps.rejects }} / {{ pps.noFix }}</div>
            </div>
          </v-card-text>
          <v-card-text v-else>Waiting for the device...</v-card-text>
        </v-card>
      </template>
    </v-card-text>
    <v-card-text v-else>Waiting for GPS data...</v-card-text>
  </v-card>
</template>
