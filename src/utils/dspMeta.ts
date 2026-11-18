/**
 * Typed metadata table for the firmware DSP blocks, mirroring
 * `src/dsp_blocks.cpp` (block / param names, group) and the `patchState`
 * validation in `dsp_graph.cpp` / `beat_analysis.cpp` (ranges). The UI renders
 * every block card from this table; the device's `caps.pipeline` (group) and
 * `caps.blocks` (presence) take precedence when available.
 */
import type { DspBlockKey, PipelineNode } from '@/protocol/types';

/** How a parameter is edited. */
export type ParamKind = 'slider' | 'select' | 'combo' | 'switch' | 'readonly';

/** Block group: analysis taps never modify audio; process blocks do. */
export type BlockGroup = 'analysis' | 'process';

/** One option of a `select` parameter. */
export interface ParamOption {
  /** Numeric wire value. */
  value: number;
  /** Display name. */
  title: string;
}

/** Metadata for one block parameter. */
export interface ParamMeta {
  /** Wire key (camelCase) in `params`. */
  key: string;
  /** Human label. */
  label: string;
  /** Unit suffix ('' when unitless). */
  unit: string;
  /** Control kind. */
  kind: ParamKind;
  /** Inclusive minimum (slider; also the validation bound). */
  min?: number;
  /** Inclusive maximum. */
  max?: number;
  /** Slider step. */
  step?: number;
  /** Options for `select`. */
  options?: ParamOption[];
  /** Firmware default (used by "reset to default"). */
  default: number;
  /** True when `patchState` ignores writes (live telemetry). */
  readOnly: boolean;
  /** Short help text. */
  help: string;
}

/** Metadata for one DSP block. */
export interface BlockMeta {
  /** Block key. */
  key: DspBlockKey;
  /** Card title. */
  title: string;
  /** One-paragraph user description. */
  description: string;
  /** Fallback group (device `caps.pipeline` wins). */
  group: BlockGroup;
  /** Processing order within the group (from the firmware node table). */
  order: number;
  /** Parameters in display order. */
  params: ParamMeta[];
}

/** Filter preset names shared by filterBank and firBank. */
export const PRESET_OPTIONS: ParamOption[] = [
  { value: 0, title: 'Bypass' },
  { value: 1, title: 'Wide (~160 Hz - 16 kHz)' },
  { value: 2, title: 'Medium (~400 Hz - 12 kHz)' },
  { value: 3, title: 'Narrow (~800 Hz - 8 kHz)' },
];

/** Common movement rates (A/h) offered for the beatRate.vph select; 0 = auto. */
export const VPH_OPTIONS: ParamOption[] = [
  { value: 0, title: 'Auto' },
  { value: 14400, title: '14 400' },
  { value: 18000, title: '18 000' },
  { value: 19800, title: '19 800' },
  { value: 21600, title: '21 600' },
  { value: 25200, title: '25 200' },
  { value: 28800, title: '28 800' },
  { value: 36000, title: '36 000' },
];

const presetParam = (what: string): ParamMeta => ({
  key: 'preset',
  label: 'Passband',
  unit: '',
  kind: 'select',
  min: 0,
  max: 3,
  options: PRESET_OPTIONS,
  default: 0,
  readOnly: false,
  help: `Bandwidth of the ${what}. Narrower removes more noise but can soften the tick.`,
});

/** Metadata for every block, in firmware pipeline order (process chain, then taps). */
export const BLOCK_META: Record<DspBlockKey, BlockMeta> = {
  notch: {
    key: 'notch',
    title: 'Mains notch',
    group: 'process',
    order: 1,
    description:
      'A narrow notch filter that removes mains hum at 50 or 60 Hz from the audio. Enable it if you see a steady low-frequency buzz in the spectrum or a raised noise floor; pick the frequency of your local mains.',
    params: [
      {
        key: 'hz',
        label: 'Mains frequency',
        unit: 'Hz',
        kind: 'select',
        min: 50,
        max: 60,
        options: [
          { value: 50, title: '50 Hz' },
          { value: 60, title: '60 Hz' },
        ],
        default: 60,
        readOnly: false,
        help: 'Only 50 or 60 Hz are accepted.',
      },
    ],
  },
  filterBank: {
    key: 'filterBank',
    title: 'Filter bank (IIR)',
    group: 'process',
    order: 2,
    description:
      'Cascaded high-pass and low-pass filters that trim rumble and hiss around the watch tick. Start with Wide and narrow it only if noise still hides the ticks. Choosing Bypass turns the block off.',
    params: [presetParam('high-pass / low-pass pair')],
  },
  firBank: {
    key: 'firBank',
    title: 'FIR bank',
    group: 'process',
    order: 3,
    description:
      'A 64-tap linear-phase band-pass with the same presets as the filter bank. It does not distort timing between frequencies, at the cost of a little more CPU. Use it instead of, or after, the IIR filter for the cleanest tick shape.',
    params: [presetParam('FIR band-pass')],
  },
  softGate: {
    key: 'softGate',
    title: 'Soft gate',
    group: 'process',
    order: 4,
    description:
      'Opens instantly on a tick and then fades the signal down towards a floor between ticks, so the quiet gaps between beats stay quiet. Useful for listening and for noisy rooms; it does not affect the timing analysis taps.',
    params: [
      {
        key: 'floorDb',
        label: 'Floor',
        unit: 'dB',
        kind: 'slider',
        min: -60,
        max: 0,
        step: 1,
        default: -12,
        readOnly: false,
        help: 'Gain applied between ticks.',
      },
      {
        key: 'attackMs',
        label: 'Attack',
        unit: 'ms',
        kind: 'slider',
        min: 0.1,
        max: 50,
        step: 0.1,
        default: 1,
        readOnly: false,
        help: 'How fast the gate opens on a tick.',
      },
      {
        key: 'releaseMs',
        label: 'Release',
        unit: 'ms',
        kind: 'slider',
        min: 1,
        max: 500,
        step: 1,
        default: 40,
        readOnly: false,
        help: 'How fast the gate closes after a tick.',
      },
    ],
  },
  gain: {
    key: 'gain',
    title: 'Gain',
    group: 'process',
    order: 5,
    description:
      'Fixed make-up gain for quiet pickups. Raise it until ticks are clearly visible without clipping; use the AGC instead if the level changes between watches.',
    params: [
      {
        key: 'db',
        label: 'Gain',
        unit: 'dB',
        kind: 'slider',
        min: -40,
        max: 40,
        step: 0.5,
        default: 0,
        readOnly: false,
        help: 'Make-up gain, -40..+40 dB.',
      },
    ],
  },
  agc: {
    key: 'agc',
    title: 'Auto gain (AGC)',
    group: 'process',
    order: 6,
    description:
      'A slow peak follower that adjusts gain (within plus or minus 12 dB) so tick peaks sit near a target level. Handy when swapping watches with different loudness. Choose a longer time constant to avoid pumping.',
    params: [
      {
        key: 'target',
        label: 'Target peak',
        unit: 'FS',
        kind: 'slider',
        min: 0.01,
        max: 1,
        step: 0.01,
        default: 0.35,
        readOnly: false,
        help: 'Desired tick peak as a fraction of full scale (above 0, up to 1).',
      },
      {
        key: 'tauS',
        label: 'Time constant',
        unit: 's',
        kind: 'slider',
        min: 0.05,
        max: 30,
        step: 0.05,
        default: 1.5,
        readOnly: false,
        help: 'Follower speed; larger is slower.',
      },
      {
        key: 'gainDb',
        label: 'Live gain',
        unit: 'dB',
        kind: 'readonly',
        default: 0,
        readOnly: true,
        help: 'Gain the AGC is applying right now.',
      },
    ],
  },
  limiter: {
    key: 'limiter',
    title: 'Limiter',
    group: 'process',
    order: 7,
    description:
      'A hard clamp at full scale just before the audio is quantised to 24 bit. It protects the USB output from overs; the limiter counter in the meters shows how often it acted. Leave it on.',
    params: [],
  },
  levelMeter: {
    key: 'levelMeter',
    title: 'Level meter',
    group: 'analysis',
    order: 0,
    description:
      'Measures peak and RMS level of the raw input (pre) and of the final output after the filtering chain (post). Drives the meters at the top of this page and the clip counter.',
    params: [],
  },
  matchedFilter: {
    key: 'matchedFilter',
    title: 'Matched filter',
    group: 'analysis',
    order: 1,
    description:
      'Learns the shape of a typical tick (a 64-sample template) and scores how well each new sound correlates with it. Once learned, the tick detector only opens on sounds that look like a tick, which rejects clicks and bumps. Keep learning on until the score is steady.',
    params: [
      {
        key: 'threshold',
        label: 'Score threshold',
        unit: '',
        kind: 'slider',
        min: 0,
        max: 2,
        step: 0.01,
        default: 0.35,
        readOnly: false,
        help: 'Minimum correlation score for an event to open.',
      },
      {
        key: 'learn',
        label: 'Learn template',
        unit: '',
        kind: 'switch',
        min: 0,
        max: 1,
        step: 1,
        default: 1,
        readOnly: false,
        help: 'While on, the template adapts to closed events.',
      },
      {
        key: 'score',
        label: 'Latest score',
        unit: '',
        kind: 'readonly',
        default: 0,
        readOnly: true,
        help: 'Most recent correlation score.',
      },
    ],
  },
  spectrum: {
    key: 'spectrum',
    title: 'Spectrum',
    group: 'analysis',
    order: 2,
    description:
      'A 512-point FFT of the raw input that finds the strongest tonal peaks. Use it to spot hum, whine or the tick resonance and decide where to set the filters. It costs some CPU, so it is off by default.',
    params: [
      {
        key: 'stride',
        label: 'Block stride',
        unit: 'blocks',
        kind: 'slider',
        min: 1,
        max: 16,
        step: 1,
        default: 1,
        readOnly: false,
        help: 'Analyse every Nth block; higher saves CPU.',
      },
    ],
  },
  noiseFloor: {
    key: 'noiseFloor',
    title: 'Noise floor',
    group: 'analysis',
    order: 3,
    description:
      'Tracks the background noise level between ticks. The tick detector and the soft gate work relative to it, so it adapts to quiet and noisy rooms automatically.',
    params: [],
  },
  eventDetect: {
    key: 'eventDetect',
    title: 'Tick detector',
    group: 'analysis',
    order: 4,
    description:
      'Finds tick events: a sound opens an event when it exceeds the noise floor by the threshold factor. Lower the threshold for faint ticks; raise it if noise causes false events. Pre-roll and tail set how much audio is kept around each event.',
    params: [
      {
        key: 'threshold',
        label: 'Threshold',
        unit: 'x noise',
        kind: 'slider',
        min: 1,
        max: 100,
        step: 0.5,
        default: 6,
        readOnly: false,
        help: 'Detect when the signal exceeds noise floor times this.',
      },
      {
        key: 'prerollMs',
        label: 'Pre-roll',
        unit: 'ms',
        kind: 'slider',
        min: 0,
        max: 100,
        step: 1,
        default: 25,
        readOnly: false,
        help: 'Audio kept before the trigger.',
      },
      {
        key: 'tailMs',
        label: 'Tail',
        unit: 'ms',
        kind: 'slider',
        min: 1,
        max: 200,
        step: 1,
        default: 25,
        readOnly: false,
        help: 'Audio kept after the event.',
      },
    ],
  },
  eventLog: {
    key: 'eventLog',
    title: 'Event log',
    group: 'analysis',
    order: 5,
    description:
      'Keeps a ring of the last 32 detected events (rise, SNR, energy) for diagnostics. Turn it on when troubleshooting detection.',
    params: [],
  },
  beatRate: {
    key: 'beatRate',
    title: 'Beat analysis',
    group: 'analysis',
    order: 6,
    description:
      'Turns detected ticks into rate (s/d), beat error and amplitude. Set the beat rate and lift angle of the movement under test for correct amplitude; leave the rate on Auto to pick the nearest common beat rate.',
    params: [
      {
        key: 'liftAngle',
        label: 'Lift angle',
        unit: '°',
        kind: 'slider',
        min: 10,
        max: 90,
        step: 1,
        default: 51,
        readOnly: false,
        help: 'Used to compute amplitude; check the movement spec.',
      },
      {
        key: 'vph',
        label: 'Beat rate',
        unit: 'A/h',
        kind: 'combo',
        min: 3600,
        max: 72000,
        options: VPH_OPTIONS,
        default: 0,
        readOnly: false,
        help: 'Nominal alternations per hour: pick a common rate or type any whole number 3600..72000; 0 = auto.',
      },
      {
        key: 'windowS',
        label: 'Fit window',
        unit: 's',
        kind: 'slider',
        min: 2,
        max: 30,
        step: 1,
        default: 6,
        readOnly: false,
        help: 'Window for the rate / beat-error fit.',
      },
      {
        key: 'avgS',
        label: 'Average time',
        unit: 's',
        kind: 'slider',
        min: 1,
        max: 60,
        step: 1,
        default: 10,
        readOnly: false,
        help: 'Integration time of the long average (also on the OLED).',
      },
      {
        key: 'calPpm',
        label: 'Clock correction',
        unit: 'ppm',
        kind: 'readonly',
        default: 0,
        readOnly: true,
        help: 'Sample-clock correction in effect (+ = board clock fast). Change it on the Timebase page.',
      },
    ],
  },
};

/** Fallback static pipeline (firmware order) used when `caps.pipeline` is absent. */
export const STATIC_PIPELINE: PipelineNode[] = [
  { key: 'input', group: 'source', order: 0, inputs: [] },
  { key: 'levelMeter', group: 'analysis', order: 0, inputs: ['input', 'limiter'] },
  { key: 'matchedFilter', group: 'analysis', order: 1, inputs: ['input'] },
  { key: 'spectrum', group: 'analysis', order: 2, inputs: ['input'] },
  { key: 'noiseFloor', group: 'analysis', order: 3, inputs: ['input'] },
  {
    key: 'eventDetect',
    group: 'analysis',
    order: 4,
    inputs: ['input', 'noiseFloor', 'matchedFilter'],
  },
  { key: 'eventLog', group: 'analysis', order: 5, inputs: ['eventDetect'] },
  { key: 'beatRate', group: 'analysis', order: 6, inputs: ['eventDetect'] },
  { key: 'notch', group: 'process', order: 1, inputs: ['input'] },
  { key: 'filterBank', group: 'process', order: 2, inputs: ['notch'] },
  { key: 'firBank', group: 'process', order: 3, inputs: ['filterBank'] },
  { key: 'softGate', group: 'process', order: 4, inputs: ['firBank'] },
  { key: 'gain', group: 'process', order: 5, inputs: ['softGate'] },
  { key: 'agc', group: 'process', order: 6, inputs: ['gain'] },
  { key: 'limiter', group: 'process', order: 7, inputs: ['agc'] },
  { key: 'pcm24', group: 'sink', order: 8, inputs: ['limiter'] },
  { key: 'usb', group: 'sink', order: 9, inputs: ['pcm24'] },
];

/**
 * Looks up metadata for a block key.
 * @param key Block key.
 * @returns The metadata, or `undefined` for keys this UI does not know (newer firmware).
 */
export function blockMeta(key: string): BlockMeta | undefined {
  return (BLOCK_META as Record<string, BlockMeta | undefined>)[key];
}

/**
 * Effective group of a block: device `caps.pipeline` wins, else the table.
 * @param key Block key.
 * @param pipeline `caps.pipeline` if advertised.
 * @returns `'analysis'` or `'process'`, or `undefined` if unknown.
 */
export function blockGroup(key: string, pipeline?: PipelineNode[]): BlockGroup | undefined {
  const node = pipeline?.find((n) => n.key === key);
  if (node?.group === 'analysis' || node?.group === 'process') return node.group;
  return blockMeta(key)?.group;
}

/**
 * Blocks of one group that the device offers, in processing order.
 * @param group Group to list.
 * @param blocks `caps.blocks` (absent blocks are omitted).
 * @param pipeline `caps.pipeline` if advertised (provides group and order).
 */
export function blocksInGroup(
  group: BlockGroup,
  blocks: readonly string[],
  pipeline?: PipelineNode[],
): BlockMeta[] {
  const out: { meta: BlockMeta; order: number }[] = [];
  for (const key of blocks) {
    const meta = blockMeta(key);
    if (!meta || blockGroup(key, pipeline) !== group) continue;
    const order = pipeline?.find((n) => n.key === key)?.order ?? meta.order;
    out.push({ meta, order });
  }
  return out.sort((a, b) => a.order - b.order).map((e) => e.meta);
}

/**
 * Clamps a value to a parameter's range and snaps to its step.
 * @param p Param metadata.
 * @param v Raw value.
 */
export function clampParam(p: ParamMeta, v: number): number {
  let x = v;
  if (p.min !== undefined) x = Math.max(p.min, x);
  if (p.max !== undefined) x = Math.min(p.max, x);
  return x;
}

/**
 * Validates a typed value for a parameter against the firmware range.
 * `beatRate.vph` accepts 0 (auto) or an integer 3600..72000; other params
 * must lie within min..max.
 * @param p Param metadata.
 * @param v Candidate value.
 * @returns An error message, or `null` when valid.
 */
export function validateParam(p: ParamMeta, v: number): string | null {
  if (!Number.isFinite(v)) return 'Enter a number';
  if (p.key === 'vph') {
    if (!Number.isInteger(v)) return 'Whole number only';
    return v === 0 || (v >= 3600 && v <= 72000) ? null : 'Use 0 (auto) or 3600..72000';
  }
  if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) {
    return `Must be ${p.min ?? '-inf'}..${p.max ?? 'inf'}`;
  }
  return null;
}
