<script setup lang="ts">
/**
 * Animated balance wheel (SVG): rim, four arms, hub, impulse-roller jewel and
 * a hairspring spiral that breathes with the angle. The wheel swings
 * theta(t) = A * sin(2*pi * f * t / slow), f = vph / 7200 Hz, A = amplitude.
 * The fixed outer ring shows the lift-angle arc (+- lift/2 about rest) and tick
 * marks at the amplitude extremes. Driven by requestAnimationFrame, paused
 * while the tab is hidden; with prefers-reduced-motion it is static at maximum
 * swing. A placeholder replaces it while the amplitude is invalid.
 * Maths lives in utils/balance.ts.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { arcPath, balanceAngleDeg, hairspringPath, polar, SLOW_FACTORS } from '@/utils/balance';

const props = defineProps<{
  /** Amplitude in degrees; null / <= 0 = invalid. */
  amplitudeDeg: number | null;
  /** Nominal beats per hour (e.g. 28800); null / 0 = unknown. */
  vph: number | null;
  /** Lift angle in degrees. */
  liftAngleDeg: number;
}>();

const slow = ref<number>(30);
const theta = ref(0);
const reduced = ref(false);

const valid = computed(() => (props.amplitudeDeg ?? 0) > 0 && (props.vph ?? 0) > 0);
const amp = computed(() => props.amplitudeDeg ?? 0);

let raf = 0;
let t0 = 0;

function frame(now: number): void {
  if (t0 === 0) t0 = now;
  theta.value = balanceAngleDeg((now - t0) / 1000, amp.value, props.vph ?? 0, slow.value);
  raf = requestAnimationFrame(frame);
}

function stop(): void {
  if (raf !== 0) cancelAnimationFrame(raf);
  raf = 0;
}

function sync(): void {
  stop();
  if (!valid.value) return;
  if (reduced.value) {
    theta.value = amp.value;
    return;
  }
  if (typeof document !== 'undefined' && document.hidden) return;
  raf = requestAnimationFrame(frame);
}

function onVisibility(): void {
  sync();
}

let mq: MediaQueryList | null = null;
function onMotion(e: MediaQueryListEvent): void {
  reduced.value = e.matches;
}

onMounted(() => {
  if (typeof matchMedia === 'function') {
    mq = matchMedia('(prefers-reduced-motion: reduce)');
    reduced.value = mq.matches;
    mq.addEventListener('change', onMotion);
  }
  document.addEventListener('visibilitychange', onVisibility);
  sync();
});
onBeforeUnmount(() => {
  stop();
  mq?.removeEventListener('change', onMotion);
  document.removeEventListener('visibilitychange', onVisibility);
});
watch([valid, reduced, () => props.vph, slow], sync);
watch(amp, () => {
  if (reduced.value) theta.value = amp.value;
});

const C = 100;
const lift = computed(() => Math.max(0, props.liftAngleDeg));
const liftArc = computed(() => arcPath(C, C, 90, -lift.value / 2, lift.value / 2));
const marks = computed(() =>
  [amp.value, -amp.value].map((a) => ({ a: polar(C, C, 84, a), b: polar(C, C, 97, a) })),
);
const spring = computed(() =>
  hairspringPath(theta.value, amp.value, { cx: C, cy: C, rInner: 9, rOuter: 38, turns: 4 }),
);
const arms = [0, 90, 180, 270].map((a) => ({ a: polar(C, C, 10, a), b: polar(C, C, 58, a) }));
const jewel = polar(C, C, 22, 180);
const label = computed(() => `amplitude ${Math.round(amp.value)}° · slow-motion ×1/${slow.value}`);
</script>

<template>
  <v-card class="pa-3 text-center">
    <div class="text-subtitle-1 text-left mb-1">Balance wheel</div>
    <div v-if="!valid" class="placeholder text-medium-emphasis d-flex align-center justify-center">
      Waiting for a valid amplitude
    </div>
    <svg v-else viewBox="0 0 200 200" class="wheel" role="img" :aria-label="label">
      <circle :cx="C" :cy="C" r="90" fill="none" stroke="currentColor" opacity="0.2" />
      <path
        :d="liftArc"
        fill="none"
        stroke="rgb(var(--v-theme-primary))"
        stroke-width="5"
        opacity="0.85"
      />
      <line
        v-for="(m, i) in marks"
        :key="i"
        :x1="m.a.x"
        :y1="m.a.y"
        :x2="m.b.x"
        :y2="m.b.y"
        stroke="rgb(var(--v-theme-warning))"
        stroke-width="2.5"
      />
      <line :x1="C" :y1="C - 84" :x2="C" :y2="C - 97" stroke="currentColor" opacity="0.5" />
      <path :d="spring" fill="none" stroke="currentColor" stroke-width="0.9" opacity="0.8" />
      <g :transform="`rotate(${theta} ${C} ${C})`">
        <circle
          :cx="C"
          :cy="C"
          r="58"
          fill="none"
          stroke="currentColor"
          stroke-width="7"
          opacity="0.75"
        />
        <line
          v-for="(a, i) in arms"
          :key="i"
          :x1="a.a.x"
          :y1="a.a.y"
          :x2="a.b.x"
          :y2="a.b.y"
          stroke="currentColor"
          stroke-width="5"
          opacity="0.75"
        />
        <circle :cx="C" :cy="C" r="9" fill="currentColor" opacity="0.85" />
        <circle :cx="jewel.x" :cy="jewel.y" r="5" fill="#d32f2f" />
      </g>
    </svg>
    <div v-if="valid" class="text-caption text-medium-emphasis mt-1">{{ label }}</div>
    <v-btn-toggle
      v-model="slow"
      mandatory
      density="compact"
      variant="outlined"
      divided
      class="mt-2"
    >
      <v-btn v-for="s in SLOW_FACTORS" :key="s" :value="s" size="small">1/{{ s }}</v-btn>
    </v-btn-toggle>
  </v-card>
</template>

<style scoped>
.wheel {
  width: 100%;
  max-width: 280px;
  height: auto;
}
.placeholder {
  min-height: 220px;
}
</style>
