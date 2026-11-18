<script setup lang="ts">
/**
 * Application shell: navigation drawer (permanent rail on md and up,
 * temporary overlay on mobile), app bar with connection controls, and the
 * routed content area.
 */
import { ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { routes } from '@/router';
import AppBarConnection from '@/components/AppBarConnection.vue';

const { mdAndUp } = useDisplay();
const drawer = ref(mdAndUp.value);
watch(mdAndUp, (v) => {
  drawer.value = v;
});

const navItems = routes.flatMap((r) =>
  r.meta?.nav ? [{ to: r.path, title: r.meta.nav.title, icon: r.meta.nav.icon }] : [],
);
</script>

<template>
  <v-navigation-drawer v-model="drawer" :rail="mdAndUp" :temporary="!mdAndUp">
    <v-list nav density="comfortable">
      <v-list-item
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        :prepend-icon="item.icon"
        :title="item.title"
        exact
      />
    </v-list>
  </v-navigation-drawer>

  <v-app-bar flat border="b">
    <v-app-bar-nav-icon v-if="!mdAndUp" @click="drawer = !drawer" />
    <v-app-bar-title>Timegrapher</v-app-bar-title>
    <AppBarConnection />
  </v-app-bar>

  <v-main>
    <router-view />
  </v-main>
</template>
