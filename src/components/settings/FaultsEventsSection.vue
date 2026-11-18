<script setup lang="ts">
/**
 * Faults and events section: the DSP fault log (`getErrors`, extended live by
 * `error` notifies through a `{errors: true}` subscription claim held while
 * mounted) with a clear button, and the newest detected events (`getEvents`,
 * limit 32) with refresh and an optional live `{events: true}` toggle.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useDiagnosticsStore } from '@/stores/diagnostics';

const diagnostics = useDiagnosticsStore();

const live = computed({
  get: () => diagnostics.liveEvents,
  set: (v: boolean) => void diagnostics.setLiveEvents(v),
});

onMounted(() => {
  void diagnostics.attach();
  void diagnostics.refreshEvents();
});
onBeforeUnmount(() => {
  void diagnostics.detach();
});

/**
 * Formats an uptime.
 * @param ms Milliseconds.
 */
function uptime(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
</script>

<template>
  <div data-testid="faults-events">
    <div class="d-flex align-center mb-2">
      <div class="text-subtitle-2 flex-grow-1">Faults ({{ diagnostics.errors.length }})</div>
      <v-btn size="small" variant="text" icon="mdi-refresh" @click="diagnostics.refreshErrors()" />
      <v-btn
        size="small"
        variant="tonal"
        :disabled="diagnostics.errors.length === 0"
        @click="diagnostics.clearErrors()"
      >
        Clear
      </v-btn>
    </div>
    <div v-if="diagnostics.errors.length === 0" class="text-medium-emphasis mb-3">
      No faults logged.
    </div>
    <v-list v-else density="compact" class="mb-3">
      <v-list-item
        v-for="(e, i) in diagnostics.errors"
        :key="i"
        prepend-icon="mdi-alert-circle-outline"
        :title="`${e.block}: ${e.reason}`"
        :subtitle="`uptime ${uptime(e.uptimeMs)}, sample ${e.sampleIndex}`"
      />
    </v-list>

    <div class="d-flex align-center flex-wrap mb-2">
      <div class="text-subtitle-2 flex-grow-1">Recent events</div>
      <v-switch v-model="live" label="Live" density="compact" hide-details class="mr-2" />
      <v-btn
        size="small"
        variant="tonal"
        prepend-icon="mdi-refresh"
        @click="diagnostics.refreshEvents()"
      >
        Refresh
      </v-btn>
    </div>
    <div style="overflow-x: auto">
      <v-table density="compact">
        <thead>
          <tr>
            <th>Start sample</th>
            <th class="text-right">Duration</th>
            <th class="text-right">SNR dB</th>
            <th class="text-right">Peak</th>
            <th class="text-right">Conf.</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(e, i) in diagnostics.events" :key="`${e.startSample}-${i}`">
            <td>{{ e.startSample }}</td>
            <td class="text-right">{{ e.durationSamples }}</td>
            <td class="text-right">{{ e.snrDb.toFixed(1) }}</td>
            <td class="text-right">{{ e.peakAbs.toFixed(3) }}</td>
            <td class="text-right">{{ e.confidence.toFixed(2) }}</td>
          </tr>
          <tr v-if="diagnostics.events.length === 0">
            <td colspan="5" class="text-medium-emphasis">No events.</td>
          </tr>
        </tbody>
      </v-table>
    </div>
  </div>
</template>
