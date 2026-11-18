<script setup lang="ts">
/**
 * Card for one DSP block: enable switch, expandable user description and the
 * parameter controls from the metadata table. The `highlighted` prop flashes
 * the card when the user picked its node in the pipeline graph.
 */
import { computed, ref } from 'vue';
import { useDspStateStore } from '@/stores/dspState';
import type { BlockMeta } from '@/utils/dspMeta';
import ParamControl from './ParamControl.vue';

const props = defineProps<{
  /** Block metadata. */
  meta: BlockMeta;
  /** Draw the highlight ring. */
  highlighted?: boolean;
}>();

const dsp = useDspStateStore();
const expanded = ref(false);

const enabled = computed(() => dsp.blockEnabled(props.meta.key));
/** A process block that is enabled but skipped because master bypass is on. */
const bypassed = computed(() => props.meta.group === 'process' && enabled.value && dsp.bypass);
</script>

<template>
  <v-card
    :id="`block-${meta.key}`"
    variant="outlined"
    :class="['block-card', { highlighted }]"
    :data-testid="`card-${meta.key}`"
  >
    <v-card-item>
      <v-card-title class="text-subtitle-1">{{ meta.title }}</v-card-title>
      <template #append>
        <v-chip v-if="bypassed" size="x-small" color="warning" class="mr-2">bypassed</v-chip>
        <v-switch
          :model-value="enabled"
          density="compact"
          hide-details
          color="primary"
          :aria-label="`Enable ${meta.title}`"
          @update:model-value="(v) => dsp.setEnabled(meta.key, Boolean(v))"
        />
      </template>
    </v-card-item>
    <v-card-text>
      <p :class="['text-body-2 text-medium-emphasis description', { clamped: !expanded }]">
        {{ meta.description }}
      </p>
      <v-btn
        size="x-small"
        variant="text"
        class="px-0 mb-2"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Less' : 'More' }}
      </v-btn>
      <ParamControl v-for="p in meta.params" :key="p.key" :block-key="meta.key" :param="p" />
    </v-card-text>
  </v-card>
</template>

<style scoped>
.block-card {
  transition:
    box-shadow 0.3s,
    border-color 0.3s;
}
.block-card.highlighted {
  border-color: rgb(var(--v-theme-primary));
  box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), 0.35);
}
.description.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
