/** Application entry point: installs Pinia, the router, Vuetify and ECharts. */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { vuetify } from './plugins/vuetify';
import './plugins/echarts';

createApp(App).use(createPinia()).use(router).use(vuetify).mount('#app');
