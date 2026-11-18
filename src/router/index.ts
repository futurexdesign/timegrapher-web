/**
 * Application routes. Hash history keeps the built `dist/` hostable from any
 * static path without server rewrites. Views are lazy-loaded.
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

/** Navigation entry metadata used by the drawer. */
export interface NavMeta {
  title: string;
  icon: string;
}

declare module 'vue-router' {
  interface RouteMeta {
    nav?: NavMeta;
  }
}

/** Route table; entries with `meta.nav` appear in the navigation drawer. */
export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'timegrapher',
    component: () => import('@/views/TimeGrapherView.vue'),
    meta: { nav: { title: 'Time Grapher', icon: 'mdi-timer-outline' } },
  },
  {
    path: '/audio',
    name: 'audio',
    component: () => import('@/views/AudioAnalysisView.vue'),
    meta: { nav: { title: 'Audio Analysis / Filtering', icon: 'mdi-waveform' } },
  },
  {
    path: '/timebase',
    name: 'timebase',
    component: () => import('@/views/TimebaseView.vue'),
    meta: { nav: { title: 'Timebase', icon: 'mdi-clock-check-outline' } },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { nav: { title: 'Settings', icon: 'mdi-cog-outline' } },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

/** The router instance. */
export const router = createRouter({ history: createWebHashHistory(), routes });
