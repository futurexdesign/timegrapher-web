<script setup lang="ts">
/**
 * SVG diagram of the DSP data-flow graph. Built from `caps.pipeline` (falling
 * back to the static firmware order when the device does not advertise it) and
 * laid out by `layoutPipeline`: the process chain runs left to right on the top
 * row, analysis taps and the quartz branch hang below. Enabled blocks are
 * filled, disabled ones outlined and dimmed; under master bypass the process
 * chain is drawn dashed. A bypass switch sits on the chain. Nodes are
 * focusable buttons; activating one emits `select` (the view scrolls to the
 * block's card). The SVG scales with its viewBox and wraps the chain into bands
 * at phone width, so the page never scrolls horizontally.
 */
import { computed } from 'vue';
import { useDisplay } from 'vuetify';
import type { PipelineNode } from '@/protocol/types';
import { useConnectionStore } from '@/stores/connection';
import { useDspStateStore } from '@/stores/dspState';
import { STATIC_PIPELINE, blockMeta } from '@/utils/dspMeta';
import { layoutPipeline, type LayoutNode } from '@/utils/pipelineLayout';

const emit = defineEmits<{
  /** A block node was activated. */
  select: [key: string];
}>();

const connection = useConnectionStore();
const dsp = useDspStateStore();
const display = useDisplay();

/** Short labels that fit a node; the full title goes into the tooltip / aria-label. */
const SHORT: Record<string, string> = {
  input: 'Input',
  pcm24: 'PCM24',
  usb: 'USB',
  quartz: 'Quartz',
  notch: 'Notch',
  filterBank: 'Filter',
  firBank: 'FIR',
  softGate: 'Gate',
  gain: 'Gain',
  agc: 'AGC',
  limiter: 'Limiter',
  levelMeter: 'Levels',
  matchedFilter: 'Matched',
  spectrum: 'Spectrum',
  noiseFloor: 'Noise',
  eventDetect: 'Detect',
  eventLog: 'Log',
  beatRate: 'Beat rate',
};

/** Pipeline nodes: device graph or fallback, without blocks the device lacks. */
const pipeline = computed<PipelineNode[]>(() => {
  const caps = connection.caps;
  const src = caps?.pipeline && caps.pipeline.length > 0 ? caps.pipeline : STATIC_PIPELINE;
  const present = new Set<string>(caps?.blocks ?? []);
  return src.filter((n) => blockMeta(n.key) === undefined || present.has(n.key));
});

const layout = computed(() =>
  layoutPipeline(pipeline.value, { columnsPerBand: display.xs.value ? 4 : 10 }),
);

const isBlock = (key: string): boolean => blockMeta(key) !== undefined;
const titleOf = (key: string): string => blockMeta(key)?.title ?? SHORT[key] ?? key;
const shortOf = (key: string): string => SHORT[key] ?? titleOf(key);

function enabledOf(n: LayoutNode): boolean {
  return isBlock(n.key) ? dsp.blockEnabled(n.key as never) : true;
}

function nodeClass(n: LayoutNode): Record<string, boolean> {
  const block = isBlock(n.key);
  return {
    node: true,
    block,
    on: block && enabledOf(n),
    off: block && !enabledOf(n),
    bypassed: n.group === 'process' && dsp.bypass,
  };
}

const groupByKey = computed(() => new Map(layout.value.nodes.map((n) => [n.key, n.group])));

function edgeClass(to: string): Record<string, boolean> {
  const toGroup = groupByKey.value.get(to);
  return {
    edge: true,
    tap: toGroup === 'analysis' || toGroup === 'quartz',
    bypassed: toGroup === 'process' && dsp.bypass,
  };
}

function ariaFor(n: LayoutNode): string {
  if (!isBlock(n.key)) return `${titleOf(n.key)} (fixed node)`;
  return `${titleOf(n.key)}: ${enabledOf(n) ? 'enabled' : 'disabled'}. Show settings.`;
}

function activate(n: LayoutNode): void {
  if (isBlock(n.key)) emit('select', n.key);
}

function toggleBypass(): void {
  dsp.setBypass(!dsp.bypass);
}
</script>

<template>
  <v-card variant="outlined" class="pa-2" data-testid="pipeline-graph">
    <svg
      :viewBox="`0 0 ${layout.width} ${layout.height}`"
      role="group"
      aria-label="DSP pipeline graph"
      class="graph"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker
          id="pg-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" class="arrow" />
        </marker>
      </defs>
      <path
        v-if="layout.bypassPath"
        :d="layout.bypassPath"
        :class="['edge', 'arc', { active: dsp.bypass }]"
        marker-end="url(#pg-arrow)"
        fill="none"
      />
      <path
        v-for="e in layout.edges"
        :key="`${e.from}>${e.to}`"
        :d="e.path"
        :class="edgeClass(e.to)"
        marker-end="url(#pg-arrow)"
        fill="none"
      />
      <g
        v-for="n in layout.nodes"
        :key="n.key"
        :class="nodeClass(n)"
        :transform="`translate(${n.x} ${n.y})`"
        :tabindex="isBlock(n.key) ? 0 : undefined"
        :role="isBlock(n.key) ? 'button' : 'img'"
        :aria-label="ariaFor(n)"
        :data-node="n.key"
        @click="activate(n)"
        @keydown.enter.prevent="activate(n)"
        @keydown.space.prevent="activate(n)"
      >
        <title>{{ titleOf(n.key) }}</title>
        <rect :width="n.w" :height="n.h" rx="6" class="box" />
        <text
          :x="n.w / 2"
          :y="n.h / 2"
          class="label"
          text-anchor="middle"
          dominant-baseline="central"
        >
          {{ shortOf(n.key) }}
        </text>
      </g>
      <g
        v-if="layout.bypassAnchor"
        class="bypass-switch"
        role="switch"
        tabindex="0"
        :aria-checked="dsp.bypass"
        aria-label="Master bypass of the processing chain"
        :transform="`translate(${layout.bypassAnchor.x} ${layout.bypassAnchor.y})`"
        data-testid="bypass-switch"
        @click="toggleBypass"
        @keydown.enter.prevent="toggleBypass"
        @keydown.space.prevent="toggleBypass"
      >
        <rect x="-34" y="-8" width="68" height="16" rx="8" :class="['pill', { on: dsp.bypass }]" />
        <circle :cx="dsp.bypass ? 26 : -26" cy="0" r="6" class="knob" />
        <text
          :x="dsp.bypass ? -6 : 6"
          y="0"
          class="pill-label"
          text-anchor="middle"
          dominant-baseline="central"
        >
          {{ dsp.bypass ? 'bypass' : 'active' }}
        </text>
      </g>
    </svg>
    <div class="text-caption text-medium-emphasis px-2">
      Solid arrows carry audio through the chain (dimmed when bypassed, the orange arc is the bypass
      path); dotted lines are analysis taps (they never change the audio). Click a block to jump to
      its settings.
    </div>
  </v-card>
</template>

<style scoped>
.graph {
  display: block;
  width: 100%;
  height: auto;
  max-height: 460px;
}
.edge {
  stroke: rgba(var(--v-theme-on-surface), 0.6);
  stroke-width: 1.6;
}
.edge.tap {
  stroke-width: 1;
  stroke-dasharray: 2 3;
}
.edge.bypassed {
  opacity: 0.3;
}
.edge.arc {
  opacity: 0.35;
}
.edge.arc.active {
  opacity: 1;
  stroke: rgb(var(--v-theme-warning));
  stroke-width: 2;
}
.arrow {
  fill: rgba(var(--v-theme-on-surface), 0.6);
}
.node .box {
  fill: rgb(var(--v-theme-surface-variant));
  stroke: rgba(var(--v-theme-on-surface), 0.4);
  stroke-width: 1;
}
.node .label {
  fill: rgb(var(--v-theme-on-surface-variant));
  font-size: 11px;
  pointer-events: none;
}
.node.block {
  cursor: pointer;
}
.node.on .box {
  fill: rgb(var(--v-theme-primary));
  stroke: rgb(var(--v-theme-primary));
}
.node.on .label {
  fill: rgb(var(--v-theme-on-primary));
}
.node.off .box {
  fill: transparent;
  stroke: rgba(var(--v-theme-on-surface), 0.5);
}
.node.off .label {
  fill: rgba(var(--v-theme-on-surface), 0.6);
}
.node.off {
  opacity: 0.7;
}
.node.bypassed {
  opacity: 0.5;
}
.node:focus-visible .box,
.bypass-switch:focus-visible .pill {
  outline: none;
  stroke: rgb(var(--v-theme-secondary));
  stroke-width: 3;
}
.bypass-switch {
  cursor: pointer;
}
.pill {
  fill: rgba(var(--v-theme-on-surface), 0.15);
  stroke: rgba(var(--v-theme-on-surface), 0.5);
}
.pill.on {
  fill: rgb(var(--v-theme-warning));
}
.knob {
  fill: rgb(var(--v-theme-surface));
}
.pill-label {
  font-size: 9px;
  fill: rgb(var(--v-theme-on-surface));
  pointer-events: none;
}
</style>
