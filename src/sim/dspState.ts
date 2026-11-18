/**
 * `DspState` store: the block enables and parameters behind `getState` /
 * `patchState`, with the firmware's merge-patch semantics (HID_CONTROL_PLANE.md
 * 6.2, `hid_control.cpp: apply_patch`, `dsp_graph.cpp: dsp_graph_set_param`).
 *
 * Rules mirrored here:
 *  - order across a patch: `bypass`, then `quartz`, then `blocks`; blocks are
 *    visited in firmware enum order, `enabled` before `params`;
 *  - read-only params (`calPpm`, `agc.gainDb`, `matchedFilter.score`) are ignored;
 *  - enabling a process block, and writing `gain.db`, `*.preset` or `notch.hz`,
 *    clears bypass (and those params also enable the block);
 *  - a range error replies `badParam` (`"patch rejected"` for blocks, the
 *    field name for quartz) and nothing applied earlier is rolled back;
 *  - writing the current quartz mode again does not restart the measurement.
 */
import type {
  DspBlockKey,
  DspBlocksState,
  DspState,
  DspStatePatch,
  QuartzMode,
  QuartzState,
} from '@/protocol/types';
import { DeviceError } from '@/transport/Transport';
import { parseQuartzMode, parseTsMethod, type QuartzParamResult } from './models/quartz';

/** Block keys in firmware enum order (`dsp_block_id_t`, bypass excluded). */
export const BLOCK_ORDER: readonly DspBlockKey[] = [
  'levelMeter',
  'gain',
  'limiter',
  'filterBank',
  'eventDetect',
  'beatRate',
  'noiseFloor',
  'eventLog',
  'softGate',
  'notch',
  'agc',
  'matchedFilter',
  'firBank',
  'spectrum',
];

/** Blocks that belong to the audio process path (enabling one clears bypass). */
export const PROCESS_BLOCKS: ReadonlySet<DspBlockKey> = new Set<DspBlockKey>([
  'gain',
  'limiter',
  'filterBank',
  'softGate',
  'notch',
  'agc',
  'firBank',
]);

/** The quartz engine as the state store sees it. */
export interface QuartzPort {
  /** Build has the quartz engine (caps.quartz). */
  readonly supported: boolean;
  /** @returns Current settings. */
  settings(): QuartzState;
  /** Selects a mode (same mode = no-op). */
  setMode(mode: QuartzMode): void;
  /** Sets a numeric / tsMethod setting. */
  setParam(name: string, value: number): QuartzParamResult;
}

/** Live (read-only) values reported inside `getState`. */
export interface LiveValues {
  /** Correction in effect (`beatRate.calPpm`). */
  calPpm: number;
  /** Live AGC gain (`agc.gainDb`). */
  agcGainDb: number;
  /** Latest matched-filter score. */
  matchScore: number;
}

/** Notifications from the store to the device. */
export interface DspStateHooks {
  /** `beatRate` liftAngle / vph changed: rolling averages are cleared. */
  onBeatParamChange?: () => void;
}

/** Writable parameters by block. */
type ParamTable = Record<string, number>;

interface ParamSpec {
  readonly json: string;
  readonly writable: boolean;
}

/** Param tables in firmware order (`dsp_blocks.cpp`). */
const PARAM_SPECS: Readonly<Record<string, readonly ParamSpec[]>> = {
  gain: [{ json: 'db', writable: true }],
  filterBank: [{ json: 'preset', writable: true }],
  firBank: [{ json: 'preset', writable: true }],
  eventDetect: [
    { json: 'threshold', writable: true },
    { json: 'prerollMs', writable: true },
    { json: 'tailMs', writable: true },
  ],
  beatRate: [
    { json: 'liftAngle', writable: true },
    { json: 'vph', writable: true },
    { json: 'calPpm', writable: false },
    { json: 'windowS', writable: true },
    { json: 'avgS', writable: true },
  ],
  softGate: [
    { json: 'floorDb', writable: true },
    { json: 'attackMs', writable: true },
    { json: 'releaseMs', writable: true },
  ],
  notch: [{ json: 'hz', writable: true }],
  agc: [
    { json: 'target', writable: true },
    { json: 'tauS', writable: true },
    { json: 'gainDb', writable: false },
  ],
  matchedFilter: [
    { json: 'threshold', writable: true },
    { json: 'learn', writable: true },
    { json: 'score', writable: false },
  ],
  spectrum: [{ json: 'stride', writable: true }],
};

const PATCH_REJECTED = 'patch rejected';
const QUARTZ_UNSUPPORTED = 'quartz timing needs the PCM1808 source';

/**
 * Rounds like the firmware's `%.6g` of a float32.
 * @param v Value.
 */
function fmt6(v: number): number {
  return Number(Math.fround(v).toPrecision(6));
}

/** @returns `true` for plain objects (not null / arrays). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** State store with merge-patch semantics. */
export class DspStateStore {
  /** Master process-path gate. */
  bypass = true;
  /** Live values the device keeps current. */
  live: LiveValues = { calPpm: 0, agcGainDb: 0, matchScore: 0 };
  /** Change hooks. */
  hooks: DspStateHooks = {};

  private readonly en: Record<DspBlockKey, boolean> = {
    levelMeter: true,
    gain: false,
    limiter: true,
    filterBank: false,
    eventDetect: true,
    beatRate: true,
    noiseFloor: true,
    eventLog: false,
    softGate: false,
    notch: false,
    agc: false,
    matchedFilter: false,
    firBank: false,
    spectrum: false,
  };

  private readonly params: Record<string, ParamTable> = {
    gain: { db: 0 },
    filterBank: { preset: 0 },
    firBank: { preset: 0 },
    eventDetect: { threshold: 6, prerollMs: 25, tailMs: 25 },
    beatRate: { liftAngle: 51, vph: 0, windowS: 6, avgS: 10 },
    softGate: { floorDb: -12, attackMs: 1, releaseMs: 40 },
    notch: { hz: 60 },
    agc: { target: 0.35, tauS: 1.5 },
    matchedFilter: { threshold: 0.35, learn: 1 },
    spectrum: { stride: 1 },
  };

  /** @param quartz The quartz engine (settings are served from it). */
  constructor(private readonly quartz: QuartzPort) {}

  /**
   * @param key Block.
   * @returns `true` when the block is enabled.
   */
  enabled(key: DspBlockKey): boolean {
    return this.en[key];
  }

  /**
   * @param block Block key.
   * @param name Param name.
   * @returns The stored value (0 when unknown).
   */
  param(block: string, name: string): number {
    return this.params[block]?.[name] ?? 0;
  }

  /** @returns `true` while the process chain is active (not bypassed). */
  get processing(): boolean {
    return !this.bypass;
  }

  /** Disables a block as an auto-eject would (used by fault injection). */
  eject(key: DspBlockKey): void {
    this.en[key] = false;
  }

  /** @returns The full `getState` snapshot. */
  getState(): DspState {
    const p = (b: string, n: string): number => fmt6(this.param(b, n));
    const blocks: DspBlocksState = {
      levelMeter: { enabled: this.en.levelMeter, params: {} },
      gain: { enabled: this.en.gain, params: { db: p('gain', 'db') } },
      limiter: { enabled: this.en.limiter, params: {} },
      filterBank: {
        enabled: this.en.filterBank,
        params: { preset: this.preset('filterBank') },
      },
      eventDetect: {
        enabled: this.en.eventDetect,
        params: {
          threshold: p('eventDetect', 'threshold'),
          prerollMs: p('eventDetect', 'prerollMs'),
          tailMs: p('eventDetect', 'tailMs'),
        },
      },
      beatRate: {
        enabled: this.en.beatRate,
        params: {
          liftAngle: p('beatRate', 'liftAngle'),
          vph: p('beatRate', 'vph'),
          calPpm: fmt6(this.live.calPpm),
          windowS: p('beatRate', 'windowS'),
          avgS: p('beatRate', 'avgS'),
        },
      },
      noiseFloor: { enabled: this.en.noiseFloor, params: {} },
      eventLog: { enabled: this.en.eventLog, params: {} },
      softGate: {
        enabled: this.en.softGate,
        params: {
          floorDb: p('softGate', 'floorDb'),
          attackMs: p('softGate', 'attackMs'),
          releaseMs: p('softGate', 'releaseMs'),
        },
      },
      notch: { enabled: this.en.notch, params: { hz: this.param('notch', 'hz') === 50 ? 50 : 60 } },
      agc: {
        enabled: this.en.agc,
        params: {
          target: p('agc', 'target'),
          tauS: p('agc', 'tauS'),
          gainDb: fmt6(this.live.agcGainDb),
        },
      },
      matchedFilter: {
        enabled: this.en.matchedFilter,
        params: {
          threshold: p('matchedFilter', 'threshold'),
          learn: p('matchedFilter', 'learn'),
          score: fmt6(this.live.matchScore),
        },
      },
      firBank: { enabled: this.en.firBank, params: { preset: this.preset('firBank') } },
      spectrum: { enabled: this.en.spectrum, params: { stride: p('spectrum', 'stride') } },
    };
    const state: DspState = { bypass: this.bypass, blocks };
    if (this.quartz.supported) state.quartz = this.quartz.settings();
    return state;
  }

  /**
   * Applies a merge patch.
   * @param patch The patch (`bypass`, `quartz`, `blocks`).
   * @throws {DeviceError} `badParam` on a rejected value (earlier fields stay applied).
   */
  applyPatch(patch: DspStatePatch): void {
    const raw: unknown = patch;
    if (!isObject(raw)) throw new DeviceError('badRequest', 'missing patch object', 'patchState');
    if (typeof raw.bypass === 'boolean') this.bypass = raw.bypass;
    if (raw.quartz !== undefined) {
      if (!isObject(raw.quartz)) throw badParam('quartz must be an object');
      this.applyQuartz(raw.quartz);
    }
    if (raw.blocks === undefined) return;
    if (!isObject(raw.blocks)) throw badParam(PATCH_REJECTED);
    for (const key of BLOCK_ORDER) {
      const bv = raw.blocks[key];
      if (bv === undefined) continue;
      if (!isObject(bv)) throw badParam(PATCH_REJECTED);
      if (typeof bv.enabled === 'boolean') this.setEnabled(key, bv.enabled);
      if (isObject(bv.params) && !this.applyParams(key, bv.params)) throw badParam(PATCH_REJECTED);
    }
  }

  private preset(block: 'filterBank' | 'firBank'): 0 | 1 | 2 | 3 {
    const v = this.param(block, 'preset');
    return v === 1 || v === 2 || v === 3 ? v : 0;
  }

  private setEnabled(key: DspBlockKey, on: boolean): void {
    this.en[key] = on;
    if (on && PROCESS_BLOCKS.has(key)) this.bypass = false;
  }

  private applyParams(key: DspBlockKey, obj: Record<string, unknown>): boolean {
    const specs = PARAM_SPECS[key];
    if (specs === undefined) return true;
    let ok = true;
    for (const spec of specs) {
      const v = obj[spec.json];
      if (!spec.writable || typeof v !== 'number') continue;
      if (!this.setParam(key, spec.json, v)) ok = false;
    }
    return ok;
  }

  /** `dsp_graph_set_param` for one writable param. */
  private setParam(key: DspBlockKey, name: string, v: number): boolean {
    if (!Number.isFinite(v)) return false;
    const t = this.params[key];
    if (t === undefined) return false;
    const inRange = (lo: number, hi: number): boolean => v >= lo && v <= hi;
    switch (`${key}.${name}`) {
      case 'gain.db':
        if (!inRange(-40, 40)) return false;
        t.db = v;
        this.en.gain = true;
        this.bypass = false;
        return true;
      case 'filterBank.preset':
      case 'firBank.preset': {
        const p = Math.trunc(v);
        if (p < 0 || p > 3) return false;
        t.preset = p;
        this.en[key] = p !== 0;
        this.bypass = false;
        return true;
      }
      case 'matchedFilter.threshold':
        if (!inRange(0, 2)) return false;
        t.threshold = v;
        return true;
      case 'matchedFilter.learn':
        t.learn = v >= 0.5 ? 1 : 0;
        return true;
      case 'spectrum.stride': {
        const s = Math.trunc(v);
        if (s < 1 || s > 16) return false;
        t.stride = s;
        return true;
      }
      case 'eventDetect.threshold':
        if (!inRange(1, 100)) return false;
        t.threshold = v;
        return true;
      case 'eventDetect.prerollMs':
        if (!inRange(0, 100)) return false;
        t.prerollMs = v;
        return true;
      case 'eventDetect.tailMs':
        if (!inRange(1, 200)) return false;
        t.tailMs = v;
        return true;
      case 'beatRate.liftAngle':
        if (!inRange(10, 90)) return false;
        t.liftAngle = v;
        this.hooks.onBeatParamChange?.();
        return true;
      case 'beatRate.vph': {
        if (v < 0) return false;
        const r = Math.round(v);
        if (r !== 0 && (r < 3600 || r > 72000)) return false;
        t.vph = r;
        this.hooks.onBeatParamChange?.();
        return true;
      }
      case 'beatRate.windowS':
        if (!inRange(2, 30)) return false;
        t.windowS = v;
        return true;
      case 'beatRate.avgS':
        if (!inRange(1, 60)) return false;
        t.avgS = v;
        return true;
      case 'notch.hz':
        if (v !== 50 && v !== 60) return false;
        t.hz = v;
        this.en.notch = true;
        this.bypass = false;
        return true;
      case 'agc.target':
        if (v <= 0 || v > 1) return false;
        t.target = v;
        return true;
      case 'agc.tauS':
        if (!inRange(0.05, 30)) return false;
        t.tauS = v;
        return true;
      case 'softGate.floorDb':
        if (!inRange(-60, 0)) return false;
        t.floorDb = v;
        return true;
      case 'softGate.attackMs':
        if (!inRange(0.1, 50)) return false;
        t.attackMs = v;
        return true;
      case 'softGate.releaseMs':
        if (!inRange(1, 500)) return false;
        t.releaseMs = v;
        return true;
      default:
        return false;
    }
  }

  /** `apply_quartz_patch`. */
  private applyQuartz(obj: Record<string, unknown>): void {
    let mode: QuartzMode | null = null;
    const hasMode = obj.mode !== undefined;
    if (hasMode) {
      if (typeof obj.mode !== 'string') throw badParam('quartz.mode must be a string');
      mode = parseQuartzMode(obj.mode);
      if (mode === null) throw badParam('quartz.mode must be mechanical, motor, lcd or fork');
    }
    const hasTs = obj.tsMethod !== undefined;
    let ts: 0 | 1 | null = null;
    if (hasTs) {
      ts = parseTsMethod(obj.tsMethod);
      if (ts === null) throw badParam('quartz.tsMethod must be threshold or xcorr');
    }
    const supported = this.quartz.supported;
    if (!supported && (hasTs || (hasMode && mode !== 'mechanical'))) {
      throw badParam(QUARTZ_UNSUPPORTED);
    }
    const numeric: readonly { json: string; api: string; range: string }[] = [
      { json: 'gateS', api: 'gate', range: 'quartz.gateS must be 0 or 3..960' },
      {
        json: 'forkHz',
        api: 'forkHz',
        range: 'quartz.forkHz must be 300, 341.33, 360, 480 or 720',
      },
      { json: 'kSigma', api: 'kSigma', range: 'quartz.kSigma must be 4..20' },
    ];
    for (const n of numeric) {
      const v = obj[n.json];
      if (typeof v !== 'number') continue;
      if (!supported) throw badParam(QUARTZ_UNSUPPORTED);
      if (this.quartz.setParam(n.api, v) !== 'ok') throw badParam(n.range);
    }
    if (hasTs && ts !== null && this.quartz.setParam('tsMethod', ts) !== 'ok') {
      throw badParam('quartz.tsMethod must be threshold or xcorr');
    }
    if (hasMode && mode !== null) {
      if (!supported && mode !== 'mechanical') throw badParam(QUARTZ_UNSUPPORTED);
      this.quartz.setMode(mode);
    }
  }
}

function badParam(message: string): DeviceError {
  return new DeviceError('badParam', message, 'patchState');
}
