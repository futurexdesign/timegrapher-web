<script setup lang="ts">
/** Appearance section: light / dark / system theme (theme store). */
import { useThemeStore, type ThemePreference } from '@/stores/theme';

const theme = useThemeStore();

/**
 * Applies the chosen preference.
 * @param p Preference, or null when the toggle was cleared.
 */
function set(p: ThemePreference | null): void {
  if (p !== null) theme.setPreference(p);
}
</script>

<template>
  <v-btn-toggle
    :model-value="theme.preference"
    mandatory
    divided
    density="comfortable"
    data-testid="appearance"
    @update:model-value="set"
  >
    <v-btn value="light" prepend-icon="mdi-white-balance-sunny">Light</v-btn>
    <v-btn value="dark" prepend-icon="mdi-weather-night">Dark</v-btn>
    <v-btn value="system" prepend-icon="mdi-laptop">System</v-btn>
  </v-btn-toggle>
</template>
