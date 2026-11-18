<script setup lang="ts">
/**
 * One headline tile: caption, big value with unit, and an optional small
 * secondary line (e.g. the instant value under the averaged one).
 */
defineProps<{
  /** Caption above the value. */
  label: string;
  /** Big value text (already formatted). */
  value: string;
  /** Unit shown next to the value. */
  unit?: string;
  /** Small line under the value. */
  sub?: string;
  /** Dim the tile (value invalid). */
  muted?: boolean;
}>();
</script>

<template>
  <v-card variant="tonal" class="metric-tile pa-3 h-100">
    <div class="text-caption text-medium-emphasis">{{ label }}</div>
    <div class="d-flex align-baseline ga-1" :class="{ 'text-disabled': muted }">
      <span class="metric-value">{{ value }}</span>
      <span v-if="unit" class="text-body-2 text-medium-emphasis">{{ unit }}</span>
    </div>
    <div v-if="sub" class="text-caption text-medium-emphasis">{{ sub }}</div>
    <slot />
  </v-card>
</template>

<style scoped>
.metric-value {
  font-size: 2rem;
  font-weight: 500;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
</style>
