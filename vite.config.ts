/**
 * Vite + Vitest configuration.
 *
 * `base: './'` makes every asset URL relative so the built `dist/` folder can
 * be hosted from any path (static file server, GitHub Pages sub-path, ...).
 * Routing uses hash history for the same reason.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

export default defineConfig({
  base: './',
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    server: { deps: { inline: ['vuetify'] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/main.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
