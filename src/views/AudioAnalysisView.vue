<script setup lang="ts">
/**
 * Audio Analysis / Filtering view: live level meters, the DSP pipeline graph,
 * an optional spectrum chart and two groups of block cards ("Audio Analysis"
 * for read-only taps, "Filtering" for the process chain). Blocks the device
 * does not advertise in `caps.blocks` are hidden. Holds a 5 Hz metrics claim
 * while mounted.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import BlockCard from '@/components/audio/BlockCard.vue';
import LiveMeters from '@/components/audio/LiveMeters.vue';
import PipelineGraph from '@/components/audio/PipelineGraph.vue';
import SpectrumChart from '@/components/audio/SpectrumChart.vue';
import ConnectPrompt from '@/components/ConnectPrompt.vue';
import { useConnectionStore } from '@/stores/connection';
import { useDspStateStore } from '@/stores/dspState';
import { useMetricsStore } from '@/stores/metrics';
import { blocksInGroup } from '@/utils/dspMeta';

const connection = useConnectionStore();
const dsp = useDspStateStore();
const metrics = useMetricsStore();

const highlighted = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

const blockKeys = computed(() => connection.caps?.blocks ?? []);
const pipeline = computed(() => connection.caps?.pipeline);
const analysis = computed(() => blocksInGroup('analysis', blockKeys.value, pipeline.value));
const filtering = computed(() => blocksInGroup('process', blockKeys.value, pipeline.value));
const showSpectrum = computed(
  () => blockKeys.value.includes('spectrum') && dsp.blockEnabled('spectrum'),
);

onMounted(() => {
  metrics.acquire();
  if (connection.isConnected && dsp.state === null) void dsp.load();
});
onBeforeUnmount(() => {
  metrics.release();
  if (highlightTimer !== null) clearTimeout(highlightTimer);
});

/** Scrolls to and briefly highlights the card of a block. */
async function reveal(key: string): Promise<void> {
  highlighted.value = key;
  await nextTick();
  document.getElementById(`block-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (highlightTimer !== null) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlighted.value = null;
  }, 2000);
}
</script>

<template>
  <v-container fluid>
    <ConnectPrompt v-if="!connection.isConnected" title="Audio Analysis / Filtering" />
    <div v-else>
      <h1 class="text-h5 mb-3">Audio Analysis / Filtering</h1>
      <LiveMeters class="mb-4" />
      <v-progress-linear v-if="dsp.loading && dsp.state === null" indeterminate class="mb-4" />
      <PipelineGraph class="mb-4" @select="reveal" />
      <SpectrumChart v-if="showSpectrum" class="mb-4" />

      <template v-if="dsp.state !== null">
        <h2 v-if="analysis.length" class="text-h6 mb-2">Audio Analysis</h2>
        <v-row v-if="analysis.length" class="mb-4">
          <v-col v-for="b in analysis" :key="b.key" cols="12" sm="6" lg="4">
            <BlockCard :meta="b" :highlighted="highlighted === b.key" />
          </v-col>
        </v-row>
        <h2 v-if="filtering.length" class="text-h6 mb-2">Filtering</h2>
        <v-row v-if="filtering.length">
          <v-col v-for="b in filtering" :key="b.key" cols="12" sm="6" lg="4">
            <BlockCard :meta="b" :highlighted="highlighted === b.key" />
          </v-col>
        </v-row>
      </template>
    </div>
  </v-container>
</template>
