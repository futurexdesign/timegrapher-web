<script setup lang="ts">
/**
 * Root component: Vuetify `v-app` hosting the layout and the global snackbar.
 * The Vuetify theme follows the theme store (including the OS preference when
 * set to "system").
 */
import { watch } from 'vue';
import { useTheme } from 'vuetify';
import DefaultLayout from '@/layouts/DefaultLayout.vue';
import { useSnackbarStore } from '@/stores/snackbar';
import { useThemeStore } from '@/stores/theme';

const snackbar = useSnackbarStore();
const themeStore = useThemeStore();
const theme = useTheme();

watch(
  () => themeStore.resolved,
  (name) => {
    // v4: change() is async (optional view transition); fire and forget.
    void theme.change(name);
  },
  { immediate: true },
);
</script>

<template>
  <v-app>
    <DefaultLayout />
    <v-snackbar v-model="snackbar.open" :color="snackbar.level" :timeout="6000" multi-line>
      {{ snackbar.message }}
      <template #actions>
        <v-btn @click="snackbar.dismiss()">Close</v-btn>
      </template>
    </v-snackbar>
  </v-app>
</template>
