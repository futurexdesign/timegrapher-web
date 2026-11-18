/**
 * Vuetify instance. Components are auto-imported by `vite-plugin-vuetify`;
 * icons use the Material Design Icons webfont (`mdi-*` class names).
 */
import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import { createVuetify } from 'vuetify';

/** Configured Vuetify plugin instance (themes: light, dark). */
export const vuetify = createVuetify({
  theme: { defaultTheme: 'light' },
  icons: { defaultSet: 'mdi' },
  defaults: { VBtn: { variant: 'text' } },
});
