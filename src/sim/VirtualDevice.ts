/**
 * The virtual timegrapher: device state, op handlers and the signal-time
 * engine behind {@link VirtualTransport}.
 *
 * Time model. The device reads an injected monotonic {@link Clock}. On every
 * request and notify poll it first calls {@link VirtualDevice.advance}, which
 *  - scales the elapsed real time by `timeScale` and advances the slow
 *    processes (UTC, GPS, PPS, crystal drift, timebase-log policy);
 *  - advances the signal models (watch, quartz engine, DSP telemetry) only
 *    while capture runs (`usbStreaming || runRequested`), by at most
 *    `signalScaleMax` times real time so a long demo fast-forward does not
 *    burn CPU on beat analysis;
 *  - advances the `getTime` counter in REAL time (the app's calibration compares
 *    it with the host clock).
 * Capture start (not running -> running) is a stream reset: beat `seq`,
 * the quartz `measurementId`, grids and counters restart, as in firmware.
 *
 * Behaviour is mirrored from `hid_control.cpp` / `HID_CONTROL_PLANE.md` and the
 * protocol addendum (device mode, beats, pipeline, GPS, timebase log). Where
 * the sources are silent the choice is documented at the point it is made.
 */
import type {
  DeviceMode,
  DeviceStatus,
  DeviceStreamState,
  DspBeat,
  DspBeatRate,
  DspBeats,
  DspBeatsPacked,
  DspError,
  DspEvent,
  DspFaultReason,
  HidBleLinkStatus,
  HidDiag,
  HidHelloCaps,
  HidHelloControl,
  HidHelloLink,
  HidHelloResult,
  HidLinkKind,
  HidNotify,
  HidSubscribePatch,
  GpsInfo,
  HidSubscription,
  OpName,
  PipelineNode,
  QuartzMode,
  RequestOf,
  ResultOf,
  Timebase,
  TimebaseLog,
  TimebaseLogEntry,
} from '@/protocol/types';
import type { DspBlockKey } from '@/protocol/types';
import { BEATS_PACKED_FORMAT } from '@/protocol/constants';
import { DeviceError } from '@/transport/Transport';
import { performanceClock, type Clock } from './clock';
import { BLOCK_ORDER, DspStateStore } from './dspState';
import { DspModel, type SignalInput } from './models/dsp';
import { GpsModel, DEFAULT_GPS, type GpsSimParams } from './models/gps';
import {
  DEFAULT_MECHANICAL,
  MechanicalModel,
  type MechanicalConfig,
  type MechanicalParams,
} from './models/mechanical';
import { QuartzEngine } from './models/quartz';
import {
  DEFAULT_QUARTZ_SOURCE,
  type QuartzContext,
  type QuartzSourceParams,
  type WatchKind,
} from './models/quartzTypes';
import { DEFAULT_TIMEBASE, TimebaseModel, type TimebaseSimParams } from './models/timebase';
import { LOG_DELTA_RANGE, TimebaseLogModel, ppsDecision } from './models/timebaseLog';
import { SubscriptionState, type RateCaps } from './notifier';
import { createRng, type Rng } from './rng';
import { REPLY_ENVELOPE_BYTES, HID_JSON_MAX, fitCount, notifyEnvelopeBytes } from './wire';
import { packBeats } from './beatsPackedEncoder';
import { NumberedRing } from './rings';

/** Faults a scenario can switch on. */
export interface FaultState {
  /** Capture rate unverified: no lock / timing, quartz `waitTimebase`. */
  timebaseUnverified: boolean;
  /** Capture rate is not 48 kHz: quartz `unsupportedRate`. */
  unsupportedRate: boolean;
  /** Flash operations reply `busy`. */
  flashBusy: boolean;
  /** Flash operations reply `flashError`. */
  flashError: boolean;
  /** `start` replies `badRequest` (capture backend unhealthy). */
  backendUnhealthy: boolean;
}

/** One queued request failure (see {@link VirtualDevice.failNextRequests}). */
export interface InjectedFailure {
  /** Requests still to fail. */
  remaining: number;
  /** Error code to reply. */
  code: DeviceError['code'];
  /** Error message to reply. */
  message: string;
  /** Only fail this op (any op when omitted). */
  op?: string;
}

/** Construction options. */
export interface VirtualDeviceOptions {
  /** Monotonic clock (default `performance.now`). */
  clock?: Clock;
  /** PRNG seed (default 1). */
  seed?: number;
  /** Build has the quartz engine (default true). */
  quartz?: boolean;
  /** Build has GPS NMEA (default true). */
  gps?: boolean;
  /** Build has the PPS input (default true; needs `gps` to produce pulses). */
  pps?: boolean;
  /** Saved device mode at boot (default `usbMic`, like a fresh board). */
  mode?: DeviceMode;
  /** USB host already streaming at boot. */
  usbStreaming?: boolean;
  /** Start capture immediately (as if `start` had been sent). */
  runRequested?: boolean;
  /** Watch on the stand (default `mechanical`). */
  attached?: WatchKind;
  /**
   * Swap the watch on the stand to match the quartz mode the app selects
   * (default true). Off = the attached watch only changes through the
   * simulator control, which models putting the wrong watch on the stand.
   */
  autoAttach?: boolean;
  /** Simulated seconds per real second (default 1). */
  timeScale?: number;
  /** Cap on signal-model speed-up (default 20). */
  signalScaleMax?: number;
  /** Overrides of the physical models. */
  mechanical?: Partial<MechanicalParams>;
  /** Overrides of the quartz source. */
  quartzSource?: Partial<QuartzSourceParams>;
  /** Overrides of the GPS receiver. */
  gpsParams?: Partial<GpsSimParams>;
  /** Overrides of the crystal model. */
  timebase?: Partial<TimebaseSimParams>;
  /** Background noise floor (float full scale). */
  noiseFloor?: number;
  /**
   * Link this device pretends to be reached over (default `usbHid`). It fills
   * `hello.link`, `hello.control.owner` and the `claim` / `getLink` results.
   * Ownership follows §4.7; a second host is modelled by {@link VirtualDevice.setForeignOwner}.
   */
  linkKind?: HidLinkKind;
  /** ATT MTU reported in `hello.link.mtu` when `linkKind` is `ble` (default 185). */
  linkMtu?: number;
  /**
   * Board name; `hello.board` reports it as `<board> (virtual)`. Default:
   * `Pico2W` for a BLE build, else `Pico2`.
   */
  board?: string;
  /**
   * Build has BLE: `hello.caps.ble` is true and `getLink` carries a `ble`
   * block. Default: `linkKind === 'ble'`, so a plain device has no BLE.
   * `false` together with `linkKind: 'ble'` is contradictory and throws.
   */
  ble?: boolean;
  /**
   * Build speaks the packed beat format (BLE_TRANSPORT_PLAN.md §14.2):
   * `caps.beatsPacked`, `subscribe.beatsPacked` and `getBeats.packed`. Default
   * `true`; `false` models older firmware.
   */
  beatsPacked?: boolean;
  /**
   * Build accepts `hello.frameMax` on BLE (§14.3) and reports `link.frameMax`.
   * Default `true`; `false` models older firmware, which ignores the field.
   * Has no effect on a USB link.
   */
  largeFrames?: boolean;
}

/** Name the simulated radio advertises (`getLink.ble.name`). */
const BLE_NAME = 'TG-SIM0';
/** Fixed fake Bluetooth address of the simulated radio. */
const BLE_ADDRESS = '00:00:00:00:51:4D';
/** Connection interval the simulated link reports while connected (µs): the 15 ms request of §14.4 was accepted. */
const BLE_CONN_INTERVAL_US = 15000;
/** TX frame size before any `hello.frameMax` (the HID report size, bytes). */
const DEFAULT_TX_FRAME = 63;
/** Largest TX frame a BLE client can ask for (§14.3). */
export const MAX_TX_FRAME = 255;
/** Beats per packed block the simulator sends (the `caps.beatsMax` of the JSON stream). */
const PACKED_BATCH = 8;
/** ATT MTU before the exchange completes (the BLE default). */
const BLE_DEFAULT_MTU = 23;

/** Control lease length (ms, §4.7). */
const LEASE_MS = 10000;

/** Longest signal span simulated per advance (s); beyond this time is dropped. */
const MAX_SIGNAL_SPAN_S = 300;
/** Signal integration step (s). */
const SIGNAL_STEP_S = 0.25;
/**
 * Parses a device-mode name like `device_mode_from_name` (case-insensitive aliases).
 * @param name Requested mode.
 * @returns The canonical mode, or `null` when unknown.
 */
function parseDeviceMode(name: unknown): DeviceMode | null {
  if (typeof name !== 'string') return null;
  const n = name.toLowerCase();
  if (n === 'usbmic' || n === 'usb_mic' || n === 'usb') return 'usbMic';
  if (n === 'standalone' || n === 'sa') return 'standalone';
  return null;
}

const EVENT_RING = 32;
const ERROR_RING = 8;
const BEAT_RING = 64;
const BEATS_MAX = 8;
const QUARTZ_PULSES_MAX = 8;
const U32_MAX = 4294967295;

/** The real firmware's rate caps and sizes (`hid_control.cpp`). */
const RATE_CAPS = { metricsHzMax: 20, beatHzMax: 5, timingHzMax: 5, quartzHzMax: 5 } as const;

/** Fixed pipeline (mirror of `kNodes` in `dsp_blocks.cpp`). */
function buildPipeline(quartz: boolean): PipelineNode[] {
  const nodes: PipelineNode[] = [
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
  if (quartz) nodes.push({ key: 'quartz', group: 'quartz', order: 0, inputs: ['input'] });
  return nodes;
}

/** The simulated device. */
export class VirtualDevice {
  /** Fault flags (mutate through the control API or directly in tests). */
  readonly faults: FaultState = {
    timebaseUnverified: false,
    unsupportedRate: false,
    flashBusy: false,
    flashError: false,
    backendUnhealthy: false,
  };
  /** The watch physically on the stand. */
  attached: WatchKind;
  /** Follow the selected quartz mode with the attached watch (see options). */
  autoAttach: boolean;
  /** Simulated seconds per real second. */
  timeScale: number;
  /** Cap on signal-model speed-up. */
  signalScaleMax: number;
  /** Background noise floor (float full scale). */
  noiseFloor: number;

  /** Mechanical watch model. */
  readonly mechanical: MechanicalModel;
  /** Quartz engine model. */
  readonly quartz: QuartzEngine;
  /** GPS receiver model. */
  readonly gps: GpsModel;
  /** Crystal / counter / calibration model. */
  readonly timebase: TimebaseModel;
  /** Timebase-log model. */
  readonly log = new TimebaseLogModel();
  /** DSP state store. */
  readonly state: DspStateStore;
  /** DSP telemetry model. */
  readonly dsp: DspModel;
  /** Pending request failures. */
  failure: InjectedFailure | null = null;

  /** Capabilities advertised in `hello`. */
  readonly caps: HidHelloCaps;

  private readonly clock: Clock;
  /** Link the requests arrive on. */
  private readonly linkKind: HidLinkKind;
  private readonly linkMtu: number;
  private readonly board: string;
  private readonly hasBle: boolean;
  private readonly hasPackedBeats: boolean;
  private readonly hasLargeFrames: boolean;
  /** TX frame size in use on the link, bytes (§14.3). */
  private txFrame = DEFAULT_TX_FRAME;
  private readonly rng: Rng;
  private readonly hasQuartz: boolean;
  private readonly hasGps: boolean;
  private readonly hasPps: boolean;
  private readonly bootMs: number;
  private lastMs: number;
  private wallS = 0;
  private lastPpsEvalS = 0;

  private mode: DeviceMode;
  private flashMode: DeviceMode;
  private runRequested: boolean;
  private usbStreaming: boolean;
  private wasRunning: boolean;

  private readonly events = new NumberedRing<DspEvent>(EVENT_RING);
  private readonly errors = new NumberedRing<DspError>(ERROR_RING);
  private readonly beats = new NumberedRing<DspBeat>(BEAT_RING);
  /** Replaced by a fresh instance on a takeover (the firmware's `ControlHandler::reset()`). */
  private subscription: SubscriptionState;
  private readonly subscriptionCaps: RateCaps;
  /** Control owner (§4.7): `null` = none, {@link linkKind} = this link, else a foreign link. */
  private owner: HidLinkKind | null = null;
  /** Monotonic ms at which the owner's lease runs out. */
  private leaseDeadlineMs = 0;
  /** A `controlReleased` notify waiting for the next poll (foreign takeover). */
  private pendingRelease: HidLinkKind | null = null;
  private eventCursor = 0;
  private errorCursor = 0;
  private beatCursor = 0;
  private pulseMeasurement = 0;
  private pulseNextSeq = 0;

  /**
   * @param options Construction options.
   * @throws {RangeError} when `linkKind` is `ble` and `ble` is `false`.
   */
  constructor(options: VirtualDeviceOptions = {}) {
    this.clock = options.clock ?? performanceClock;
    this.linkKind = options.linkKind ?? 'usbHid';
    this.hasBle = options.ble ?? this.linkKind === 'ble';
    this.hasPackedBeats = options.beatsPacked ?? true;
    this.hasLargeFrames = options.largeFrames ?? true;
    if (this.linkKind === 'ble' && !this.hasBle) {
      throw new RangeError('a device reached over BLE must be built with BLE');
    }
    this.board = options.board ?? (this.hasBle ? 'Pico2W' : 'Pico2');
    this.linkMtu = options.linkMtu ?? 185;
    this.rng = createRng(options.seed ?? 1);
    this.hasQuartz = options.quartz ?? true;
    this.hasGps = options.gps ?? true;
    this.hasPps = options.pps ?? true;
    this.attached = options.attached ?? 'mechanical';
    this.autoAttach = options.autoAttach ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.signalScaleMax = options.signalScaleMax ?? 20;
    this.noiseFloor = options.noiseFloor ?? 1.5e-4;
    this.mechanical = new MechanicalModel(this.rng, {
      ...DEFAULT_MECHANICAL,
      ...options.mechanical,
    });
    this.quartz = new QuartzEngine(this.rng, { ...DEFAULT_QUARTZ_SOURCE, ...options.quartzSource });
    this.gps = new GpsModel(this.rng, { ...DEFAULT_GPS, ...options.gpsParams });
    this.timebase = new TimebaseModel(this.rng, { ...DEFAULT_TIMEBASE, ...options.timebase });
    this.dsp = new DspModel(this.rng);
    this.state = new DspStateStore({
      supported: this.hasQuartz,
      settings: () => this.quartz.settings(),
      setMode: (m) => {
        this.quartz.setMode(m);
        this.followMode(m);
      },
      setParam: (n, v) => this.quartz.setParam(n, v),
    });
    this.state.hooks.onBeatParamChange = () => {
      this.mechanical.clearAverages();
    };
    this.mode = options.mode ?? 'usbMic';
    this.flashMode = this.mode;
    this.usbStreaming = options.usbStreaming ?? false;
    // Boot: standalone sets the run latch (device_boot_run).
    this.runRequested = options.runRequested ?? this.mode === 'standalone';
    this.bootMs = this.clock();
    this.lastMs = this.bootMs;
    this.wasRunning = this.running;
    const rateCaps: RateCaps = {
      ...RATE_CAPS,
      quartz: this.hasQuartz,
      beats: true,
      beatsPacked: this.hasPackedBeats,
    };
    this.subscriptionCaps = rateCaps;
    this.subscription = new SubscriptionState(rateCaps);
    this.caps = {
      maxJsonBytes: 2048,
      ...RATE_CAPS,
      timing: true,
      quartz: this.hasQuartz,
      quartzPulsesMax: QUARTZ_PULSES_MAX,
      blocks: [...BLOCK_ORDER],
      deviceMode: true,
      beats: true,
      beatsMax: BEATS_MAX,
      ...(this.hasPackedBeats ? { beatsPacked: BEATS_PACKED_FORMAT } : {}),
      gps: this.hasGps,
      pps: this.hasPps,
      timebaseLog: true,
      timebaseLogMax: 24,
      ...(this.hasBle ? { ble: true } : {}),
      pipeline: buildPipeline(this.hasQuartz),
    };
  }

  /** @returns The TX frame size in use on the link, bytes (63 until `hello.frameMax`, §14.3). */
  get txFrameBytes(): number {
    return this.txFrame;
  }

  /** @returns `true` when the device accepts `hello.frameMax` on a BLE link (INFO `txMax`). */
  get acceptsFrameMax(): boolean {
    return this.hasLargeFrames && this.linkKind === 'ble';
  }

  /** Returns the TX frame size to 63 bytes, as a dropped BLE link does (§14.3). */
  resetTxFrame(): void {
    this.txFrame = DEFAULT_TX_FRAME;
  }

  // --- Scenario-facing accessors -------------------------------------------------

  /** @returns Capture runs while `usbStreaming || runRequested`. */
  get running(): boolean {
    return this.usbStreaming || this.runRequested;
  }

  /** @returns `true` while a subscription needs notify polling. */
  get wantsPolling(): boolean {
    return this.subscription.active || this.pendingRelease !== null;
  }

  /**
   * Scenario hook: another host (on the other link) takes or releases control.
   *
   * With a kind, that link becomes the owner with a fresh lease. When this
   * link held control, its subscription is cleared (the firmware's handler
   * reset) and a `controlReleased` notify is queued for the next poll, so
   * notify delivery needs an active poll loop (any active subscription).
   * Later requests other than `hello` / `ping` fail with `linkBusy` until
   * this link claims with `takeover: true` or the lease runs out. With
   * `null`, a foreign owner is dropped and control is free again; ownership by
   * this link is untouched.
   * @param kind Link that now owns control, or `null`.
   * @throws {RangeError} when `kind` is this device's own link.
   */
  setForeignOwner(kind: HidLinkKind | null): void {
    if (kind === null) {
      if (this.owner !== this.linkKind) this.owner = null;
      return;
    }
    if (kind === this.linkKind) {
      throw new RangeError('foreign owner must differ from the device link');
    }
    if (this.owner === this.linkKind) {
      this.subscription = new SubscriptionState(this.subscriptionCaps);
      this.pendingRelease = kind;
    }
    this.owner = kind;
    this.leaseDeadlineMs = this.clock() + LEASE_MS;
  }

  /** @returns Simulated wall-clock seconds since power-up. */
  get simWallS(): number {
    return this.wallS;
  }

  /**
   * Sets whether the USB host has the audio stream open.
   * @param on New state.
   */
  setUsbStreaming(on: boolean): void {
    this.advance();
    this.usbStreaming = on;
    this.afterRunChange();
  }

  /** @returns Current device status. */
  status(): DeviceStatus {
    const streamState: DeviceStreamState = this.faults.backendUnhealthy
      ? 'error'
      : this.usbStreaming
        ? 'active'
        : 'idle';
    return {
      mode: this.mode,
      running: this.running,
      runRequested: this.runRequested,
      usbStreaming: this.usbStreaming,
      streamState,
      saved: this.flashMode === this.mode,
    };
  }

  /** @returns The seed-independent device-side view of what the app sees as truth. */
  quartzContext(): QuartzContext {
    const eff = this.timebase.effective(this.hasPps && this.hasGps);
    return {
      attached: this.attached,
      sourceHz: this.sourceHz(),
      timebaseOk: !this.faults.timebaseUnverified,
      xtalPpm: this.timebase.xtalPpm,
      calPpm: eff.ppm,
      calSource: eff.source,
    };
  }

  /** Re-evaluates faults that change the quartz context (restarts the measurement). */
  syncFaults(): void {
    this.quartz.observe(this.quartzContext());
  }

  /**
   * Queues request failures.
   * @param failure Failure spec; `null` clears.
   */
  failNextRequests(failure: InjectedFailure | null): void {
    this.failure = failure;
  }

  /**
   * Logs a DSP fault as the firmware does on auto-eject and disables the block.
   * @param block Block key.
   * @param reason Fault reason.
   */
  injectError(block: DspBlockKey, reason: DspFaultReason): void {
    this.advance();
    this.state.eject(block);
    this.errors.push({
      block,
      reason,
      uptimeMs: Math.floor(this.clock() - this.bootMs),
      sampleIndex: String(Math.round(this.wallS * 48000)),
    });
  }

  /** Capture sample loss: restarts a running quartz measurement. */
  injectSampleLoss(): void {
    this.quartz.noteSampleLoss();
  }

  // --- Time engine ---------------------------------------------------------------

  /** Brings every model up to the clock. Cheap when no time has passed. */
  advance(): void {
    const now = this.clock();
    const dtReal = (now - this.lastMs) / 1000;
    this.lastMs = now;
    if (dtReal <= 0) return;
    const dtSim = dtReal * this.timeScale;
    this.timebase.advanceCounter(dtReal * 1000);
    // Slow processes in chunks so the PPS / log policy sees intermediate states.
    const chunks = Math.min(4000, Math.max(1, Math.ceil(dtSim / 30)));
    const dt = dtSim / chunks;
    for (let i = 0; i < chunks; i++) {
      this.wallS += dt;
      this.timebase.advanceSlow(dt);
      if (this.hasGps) {
        this.gps.advance(dt);
        if (this.hasPps) this.timebase.advancePps(dt, this.gps.utcUnix() !== 0, this.gps.hasFix());
      }
      this.ppsLogPoll();
    }
    if (this.running) {
      const span = Math.min(
        dtReal * Math.min(this.timeScale, this.signalScaleMax),
        MAX_SIGNAL_SPAN_S,
      );
      this.advanceSignal(span);
    }
    this.logFlushPoll(now);
  }

  /**
   * With {@link autoAttach}, puts the watch that matches `mode` on the stand:
   * the quartz kind for a quartz mode, a mechanical watch for `mechanical`
   * (only when a quartz watch was attached, so `none` stays `none`). This is
   * what a user does with the real stand when they pick a mode.
   * @param mode Quartz mode just selected through the protocol.
   */
  private followMode(mode: QuartzMode): void {
    if (!this.autoAttach) return;
    if (mode !== 'mechanical') {
      this.attached = mode;
    } else if (this.attached === 'motor' || this.attached === 'lcd' || this.attached === 'fork') {
      this.attached = 'mechanical';
    }
  }

  private afterRunChange(): void {
    const run = this.running;
    if (run && !this.wasRunning) this.resetStream();
    this.wasRunning = run;
  }

  /** Capture restart: drops all stream-scoped analysis state. */
  private resetStream(): void {
    this.mechanical.reset();
    this.quartz.resetStream();
    this.dsp.reset();
    this.beats.clear();
    this.events.clear();
    // Subscriber baselines restart with the stream (beat seq restarts at 0).
    this.beatCursor = this.beats.total;
    this.eventCursor = this.events.total;
  }

  private sourceHz(): number {
    return this.faults.unsupportedRate ? 44100 : 48000;
  }

  private mechanicalConfig(): MechanicalConfig {
    const eff = this.timebase.effective(this.hasPps && this.hasGps);
    const st = this.state;
    const attached = this.attached === 'mechanical' && this.quartz.activeMode === 'mechanical';
    this.state.live.calPpm = eff.ppm;
    return {
      attached,
      sourceHz: this.sourceHz(),
      timebaseOk: !this.faults.timebaseUnverified,
      xtalPpm: this.timebase.xtalPpm,
      calPpm: eff.ppm,
      calSource: eff.source,
      liftAngleDeg: st.param('beatRate', 'liftAngle'),
      vph: st.param('beatRate', 'vph'),
      windowS: st.param('beatRate', 'windowS'),
      avgS: st.param('beatRate', 'avgS'),
      eventDetectEnabled: st.enabled('eventDetect'),
      prerollMs: st.param('eventDetect', 'prerollMs'),
      tailMs: st.param('eventDetect', 'tailMs'),
      threshold: st.param('eventDetect', 'threshold'),
      beatRateEnabled: st.enabled('beatRate'),
      noiseFloor: this.noiseFloor,
    };
  }

  private advanceSignal(spanS: number): void {
    let left = spanS;
    while (left > 1e-9) {
      const dt = Math.min(left, SIGNAL_STEP_S);
      left -= dt;
      const cfg = this.mechanicalConfig();
      const out = this.mechanical.advance(dt, cfg);
      for (const e of out.events) this.events.push(e);
      for (const b of out.beats) this.beats.push(b);
      const qctx = this.quartzContext();
      this.quartz.advance(dt, qctx);
      this.dsp.step(dt, this.signalInput(cfg, qctx), this.state);
    }
  }

  private signalInput(cfg: MechanicalConfig, qctx: QuartzContext): SignalInput {
    if (this.quartz.activeMode === 'mechanical') {
      return {
        active: cfg.attached,
        peak: this.mechanical.params.signalPeak,
        rate: this.mechanical.beatsPerSecond,
        sinceTickS: this.mechanical.sinceTickS,
        noise: this.noiseFloor,
        spectrumHz: [1850, 3200, 5400, 900, 7600, 12100],
      };
    }
    const active = qctx.attached === this.quartz.activeMode;
    return {
      active,
      peak: this.quartz.signalPeak(qctx),
      rate:
        this.quartz.activeMode === 'motor' ? 1 / Math.max(this.quartz.source.motorStepS, 0.1) : 0,
      sinceTickS: 0.1,
      noise: this.noiseFloor,
      spectrumHz:
        this.quartz.activeMode === 'fork' ? [this.quartz.settings().forkHz] : [420, 1300, 2600],
    };
  }

  private quartzBlocksWrites(): boolean {
    const q = this.quartz.state(this.quartzContext());
    return this.quartz.activeMode !== 'mechanical' && (q === 'acquiring' || q === 'measuring');
  }

  private flashOk(): boolean {
    return !this.faults.flashBusy && !this.faults.flashError;
  }

  /** PPS log policy (`pps_log_poll`): at most one evaluation per simulated second. */
  private ppsLogPoll(): void {
    if (!this.hasGps || !this.hasPps) return;
    if (this.wallS - this.lastPpsEvalS < 1) return;
    this.lastPpsEvalS = this.wallS;
    if (this.log.pending) return;
    const pps = this.timebase.pps();
    if (!pps.locked) return;
    const utc = this.gps.utcUnix();
    const entries = this.log.list();
    const d = ppsDecision(
      entries,
      {
        locked: pps.locked,
        window: pps.window,
        lockedSinceS: pps.lockedS,
        ppm: pps.ppm,
        utcNow: utc,
      },
      this.log.deltaPpm,
    );
    if (d === 'none') return;
    this.log.append({
      dateUnix: utc,
      ppm: pps.ppm,
      source: 'pps',
      durationS: pps.lockedS,
      reason: d,
    });
    this.log.markPending();
  }

  private logFlushPoll(nowMs: number): void {
    if (!this.log.pending) return;
    const blocked = this.usbStreaming || this.quartzBlocksWrites();
    const wrote = this.log.flush(nowMs, blocked, this.flashOk(), this.gps.utcUnix());
    if (wrote && this.running) this.resetStream();
  }

  /** Flash write that pauses and restarts capture (`flash_store_commit_paused`). */
  private pausedWrite(): void {
    if (this.running) this.resetStream();
  }

  // --- Notifications -------------------------------------------------------------

  /**
   * Handles `subscribe`'s baseline seeding (events, errors, pulses, beats).
   */
  private seedBaselines(): void {
    this.eventCursor = this.events.total;
    this.errorCursor = this.errors.total;
    this.beatCursor = this.beats.total;
    const q = this.quartz.snapshot(this.quartzContext());
    const newest = this.quartz.recentPulses(this.quartzContext(), 1)[0];
    if (newest) {
      this.pulseMeasurement = newest.measurementId;
      this.pulseNextSeq = newest.sequence + 1;
    } else {
      this.pulseMeasurement = q.measurementId;
      this.pulseNextSeq = 0;
    }
  }

  /**
   * Produces at most one notify, in firmware priority order.
   * @returns The message, or `null` when nothing is due.
   */
  pollNotify(): HidNotify | null {
    this.advance();
    if (this.pendingRelease !== null) {
      const to = this.pendingRelease;
      this.pendingRelease = null;
      return { v: 1, notify: true, op: 'controlReleased', data: { to } };
    }
    const now = this.clock();
    const kind = this.subscription.nextDue(now);
    if (kind !== null) {
      this.subscription.markSent(kind, now);
      const ctx = this.quartzContext();
      switch (kind) {
        case 'metrics':
          return { v: 1, notify: true, op: 'metrics', data: this.dsp.metrics(this.state) };
        case 'beat':
          return { v: 1, notify: true, op: 'beat', data: this.beatRate() };
        case 'timing':
          return {
            v: 1,
            notify: true,
            op: 'timing',
            data: this.dsp.timing(this.state, this.quartz.activeMode !== 'mechanical'),
          };
        case 'quartz':
          return { v: 1, notify: true, op: 'quartz', data: this.quartz.snapshot(ctx) };
      }
    }
    const f = this.subscription.flags;
    const ctx = this.quartzContext();
    if (f.quartzPulses && this.hasQuartz) {
      const id = this.quartz.currentMeasurementId;
      if (id !== this.pulseMeasurement) {
        this.pulseMeasurement = id;
        this.pulseNextSeq = 0;
      }
      const p = this.quartz.closedPulsesFrom(ctx, this.pulseNextSeq)[0];
      if (p) {
        this.pulseNextSeq = p.sequence + 1;
        return { v: 1, notify: true, op: 'quartzPulse', data: p };
      }
    }
    if (f.events) {
      // Oldest first, as many as fit one message; the rest follow in later notifies.
      const cand = this.events.since(this.eventCursor, 8).values;
      const n = fitCount(
        cand,
        HID_JSON_MAX - notifyEnvelopeBytes('event') - '{"events":[]}'.length,
      );
      if (n > 0) {
        const r = this.events.since(this.eventCursor, n);
        this.eventCursor = r.next;
        return { v: 1, notify: true, op: 'event', data: { events: r.values } };
      }
    }
    if (f.errors) {
      // Only the latest fault is pushed (older unsent ones are skipped), as the firmware does.
      const e = this.errors.newest(1)[0];
      if (e && this.errors.total > this.errorCursor) {
        this.errorCursor = this.errors.total;
        return { v: 1, notify: true, op: 'error', data: e };
      }
    }
    if (f.beatsPacked) {
      const cand = this.beats.since(this.beatCursor, PACKED_BATCH).values;
      if (cand.length > 0) {
        const { p, count } = packBeats(cand, this.sourceHz(), PACKED_BATCH);
        this.beatCursor = this.beats.since(this.beatCursor, count).next;
        return { v: 1, notify: true, op: 'beatsPacked', data: { p } };
      }
    } else if (f.beats) {
      const r = this.beats.since(this.beatCursor, 8);
      if (r.values.length > 0) {
        this.beatCursor = r.next;
        return { v: 1, notify: true, op: 'beats', data: { beats: r.values } };
      }
    }
    return null;
  }

  // --- Request dispatch ----------------------------------------------------------

  /**
   * Executes one request against the device state.
   * @param op Operation name.
   * @param body Request fields.
   * @returns The `result` payload.
   * @throws {DeviceError} with the firmware's code and message.
   */
  handle<O extends OpName>(op: O, body: RequestOf<O>): ResultOf<O> {
    this.advance();
    this.arbitrate(op, body);
    const inj = this.failure;
    if (inj && inj.remaining > 0 && (inj.op === undefined || inj.op === op)) {
      inj.remaining--;
      if (inj.remaining === 0) this.failure = null;
      throw new DeviceError(inj.code, inj.message, op);
    }
    if (!Object.hasOwn(this.handlers, op)) {
      throw new DeviceError('unknownOp', op, op);
    }
    const handler = this.handlers[op] as (b: RequestOf<O>) => ResultOf<O>;
    return handler(body);
  }

  private readonly handlers: { [O in OpName]: (body: RequestOf<O>) => ResultOf<O> } = {
    hello: (b) => this.hello(b),
    // `claim` itself is resolved in `arbitrate()`, which has already made this
    // link the owner (or thrown `linkBusy`) by the time the handler runs.
    claim: () => ({ owner: this.linkKind, previous: this.claimPrevious }),
    getLink: () => ({
      usbHid: { mounted: true },
      ...(this.hasBle ? { ble: this.bleStatus() } : {}),
      control: this.controlState(),
    }),
    getDiag: () => this.diag(),
    // `t` is echoed verbatim when it is an integer within int64, else treated as missing (0).
    ping: (b) => ({
      t: typeof b.t === 'number' && Number.isInteger(b.t) && Math.abs(b.t) < 2 ** 63 ? b.t : 0,
      uptimeMs: this.uptimeMs(),
    }),
    getState: () => this.state.getState(),
    patchState: (b) => {
      const patch: unknown = (b as { patch?: unknown }).patch;
      if (typeof patch !== 'object' || patch === null) {
        throw new DeviceError('badRequest', 'missing patch object', 'patchState');
      }
      this.state.applyPatch(b.patch);
      return this.state.getState();
    },
    getMetrics: () => this.dsp.metrics(this.state),
    getTiming: () => this.dsp.timing(this.state, this.quartz.activeMode !== 'mechanical'),
    resetTiming: () => {
      this.dsp.resetTiming();
      return { cleared: true };
    },
    getBeat: () => this.beatRate(),
    getSpectrum: () => this.dsp.spectrum(this.state, this.sourceHz()),
    getMatched: () => this.dsp.matched(this.state),
    getEvents: (b) => this.getEvents(b),
    getErrors: () => ({ errors: this.errors.newest(ERROR_RING) }),
    clearErrors: () => {
      this.errors.clear();
      this.errorCursor = this.errors.total;
      return { cleared: true };
    },
    subscribe: (b) => this.subscribe(b),
    getTime: () => ({ tUs: Math.floor(this.timebase.counter), uptimeMs: this.uptimeMs() }),
    getTimebase: () => this.timebaseResult(),
    setTimebase: (b) => this.setTimebase(b),
    saveTimebase: () => this.saveTimebase(),
    clearTimebase: () => {
      this.timebase.clear();
      return this.timebaseResult();
    },
    getQuartz: () => this.quartz.snapshot(this.quartzContext()),
    getQuartzPulses: (b) => ({
      pulses: this.quartz.recentPulses(
        this.quartzContext(),
        this.clampInt(b.max, 1, QUARTZ_PULSES_MAX, QUARTZ_PULSES_MAX),
      ),
    }),
    quartzRestart: () => {
      if (!this.hasQuartz) {
        throw new DeviceError(
          'badRequest',
          'quartz timing needs the PCM1808 source',
          'quartzRestart',
        );
      }
      if (!this.quartz.restart()) {
        throw new DeviceError(
          'badRequest',
          'quartzRestart needs motor, lcd or fork mode',
          'quartzRestart',
        );
      }
      return this.quartz.snapshot(this.quartzContext());
    },
    getDevice: () => this.status(),
    setDevice: (b) => this.setDevice(b.mode),
    start: () => {
      if (this.faults.backendUnhealthy) {
        throw new DeviceError('badRequest', 'capture backend error (stream state: error)', 'start');
      }
      this.runRequested = true;
      this.afterRunChange();
      return this.status();
    },
    stop: () => {
      this.runRequested = false;
      this.afterRunChange();
      return this.status();
    },
    getBeats: (b) => this.getBeats(b),
    getGps: () => this.getGps(),
    getTimebaseLog: (b) => this.timebaseLog(b),
    clearTimebaseLog: () => this.clearTimebaseLog(),
  };

  // --- Individual ops ------------------------------------------------------------

  private uptimeMs(): number {
    return Math.floor(this.clock() - this.bootMs);
  }

  private clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, Math.trunc(v)));
  }

  /**
   * `getBeats`: the newest beats, newest first, or with `packed` (and
   * `caps.beatsPacked`) one block, newest last. A block holds one grid, so
   * when the newest beats span a grid change the block is the newest run only.
   * An empty ring gives an empty block text.
   */
  private getBeats(b: RequestOf<'getBeats'>): DspBeats | DspBeatsPacked {
    const newest = this.beats.newest(this.clampInt(b.max, 1, BEATS_MAX, 8));
    if (b.packed !== true || !this.hasPackedBeats) return { beats: newest };
    let rest = newest.reverse();
    let last = '';
    while (rest.length > 0) {
      const { p, count } = packBeats(rest, this.sourceHz(), PACKED_BATCH);
      last = p;
      rest = rest.slice(count);
    }
    return { p: last };
  }

  /**
   * Handles `hello`. On a BLE build that accepts large frames, `frameMax`
   * sets the TX frame size for the rest of the connection:
   * `min(frameMax, 255, mtu - 3)`, never below 63 bytes.
   */
  private hello(b: RequestOf<'hello'>): HidHelloResult {
    if (this.linkKind === 'ble' && this.hasLargeFrames && typeof b.frameMax === 'number') {
      const want = Number.isFinite(b.frameMax) ? Math.trunc(b.frameMax) : DEFAULT_TX_FRAME;
      this.txFrame = Math.max(DEFAULT_TX_FRAME, Math.min(want, MAX_TX_FRAME, this.linkMtu - 3));
    }
    return {
      protocolVersion: 1,
      fwVersion: '0.2.0-sim',
      board: `${this.board} (virtual)`,
      source: 'PCM1808',
      vid: 51966,
      pid: 16387,
      caps: structuredClone(this.caps),
      link: this.helloLink(),
      control: this.controlState(),
    };
  }

  /** The `hello.link` object: kind, plus the MTU on BLE. */
  private helloLink(): HidHelloLink {
    if (this.linkKind !== 'ble') return { kind: 'usbHid' };
    return this.hasLargeFrames
      ? { kind: 'ble', mtu: this.linkMtu, frameMax: this.txFrame }
      : { kind: 'ble', mtu: this.linkMtu };
  }

  /**
   * The `getLink.ble` block of a BLE build. Only one link is active at a
   * time, so the radio is off when this device is reached over USB.
   */
  private bleStatus(): HidBleLinkStatus {
    const onBle = this.linkKind === 'ble';
    return {
      enabled: onBle,
      name: BLE_NAME,
      address: BLE_ADDRESS,
      advertising: false,
      connected: onBle,
      mtu: onBle ? this.linkMtu : BLE_DEFAULT_MTU,
      connIntervalUs: onBle ? BLE_CONN_INTERVAL_US : 0,
      connParamStep: onBle ? 1 : 0,
      connParamRejects: 0,
      rxFrames: 0,
      txFrames: 0,
      rxDropped: 0,
      rxInvalid: 0,
      txRetries: 0,
      disconnects: 0,
      lastDisconnectReason: 0,
      core: 0,
    };
  }

  /** Ownership as seen by the requesting link (`hello.control`, §4.6). */
  private controlState(): HidHelloControl {
    return { owner: this.owner, self: this.owner === this.linkKind, leaseMs: LEASE_MS };
  }

  /** Owner before the last `claim` (its `previous` result field). */
  private claimPrevious: HidLinkKind | null = null;

  /**
   * Applies the ownership table of §4.7 to one request arriving on this link.
   * `hello` is always answered; `ping` also refreshes the lease when this link
   * owns control. `claim` and every other op take control when it is free,
   * already ours or the lease has expired, and otherwise fail with `linkBusy`
   * (`claim` with `takeover: true` always succeeds).
   * @param op Requested op.
   * @param body Request fields (only `claim`'s `takeover` is read).
   * @throws {DeviceError} `linkBusy` while a foreign link holds control.
   */
  private arbitrate(op: OpName, body: object): void {
    const now = this.clock();
    if (op === 'hello') return;
    if (op === 'ping') {
      if (this.owner === this.linkKind) this.leaseDeadlineMs = now + LEASE_MS;
      return;
    }
    const foreign = this.owner !== null && this.owner !== this.linkKind;
    const held = foreign && now < this.leaseDeadlineMs;
    const takeover = op === 'claim' && (body as { takeover?: unknown }).takeover === true;
    if (held && !takeover) {
      throw new DeviceError('linkBusy', `control held by ${String(this.owner)}`, op);
    }
    if (foreign) this.subscription = new SubscriptionState(this.subscriptionCaps);
    this.claimPrevious = this.owner;
    this.owner = this.linkKind;
    this.leaseDeadlineMs = now + LEASE_MS;
  }

  /** `getDiag` result: the simulator has no fault counters, so every field is 0. */
  private diag(): HidDiag {
    return {
      usbEnumerationCount: 0,
      usbAudioStreamOpenCount: 0,
      usbAudioStreamCloseCount: 0,
      usbSuspendCount: 0,
      usbResumeCount: 0,
      boostOnCount: 0,
      boostOffCount: 0,
      preampSettleStartCount: 0,
      preampSettleDoneCount: 0,
      preampStartAbortedCount: 0,
      usbSuspendDurationMs: 0,
      adcTotalSampleCount: 0,
      adcConversionErrorCount: 0,
      dmaCompleteCount: 0,
      dmaOverrunCount: 0,
      pcmRingUnderrunCount: 0,
      pcmRingOverrunCount: 0,
      usbInPacketCount: 0,
      usbInSampleCount: 0,
      usbShortWriteCount: 0,
      ringMinOccupancy: 0,
      ringMaxOccupancy: 0,
      adcMinCode: 0,
      adcMaxCode: 0,
      adcMeanCodeAccum: 0,
      adcMeanCodeCount: 0,
      adcDcCounts: 0,
      adcAcPeakCounts: 0,
      adcPcmPeakAbs: 0,
      pcm1808ClockConfigOk: 0,
      pcm1808ClkSysHz: 0,
      pcm1808ClkUsbHz: 0,
      pcm1808MclkNominalHz: 0,
      pcm1808StartupWaitCount: 0,
      pcm1808DmaBlocks: 0,
      pcm1808StereoFramesReceived: 0,
      pcm1808MonoSamplesEmitted: 0,
      pcm1808DmaBlockOverruns: 0,
      pcm1808PioFifoStallOrOverflow: 0,
      pcm1808SamplePeakAbs: 0,
      pcm1808SaturatedCount: 0,
      pcm1808RawLeftPeakAbs: 0,
      pcm1808RawRightPeakAbs: 0,
      pcm1808FrameRateMhz: 0,
      pcm1808RateStatus: 0,
      pcm1808MclkRatio: 0,
      pcm1808Upsample: 0,
      pcm1808BlocksLost: 0,
    };
  }

  private beatRate(): DspBeatRate {
    return this.mechanical.snapshot(this.mechanicalConfig());
  }

  private subscribe(b: HidSubscribePatch): HidSubscription {
    const res = this.subscription.apply(b, this.clock());
    this.seedBaselines();
    return res;
  }

  private setDevice(name: string): DeviceStatus {
    const mode = parseDeviceMode(name);
    if (mode === null) {
      throw new DeviceError('badParam', 'device.mode must be usbMic or standalone', 'setDevice');
    }
    // Selecting the current mode is a no-op that never touches flash.
    if (mode === this.mode) return this.status();
    if (this.usbStreaming || this.faults.flashBusy) {
      throw new DeviceError('busy', 'close the audio stream before changing mode', 'setDevice');
    }
    if (this.faults.flashError)
      throw new DeviceError('flashError', 'flash write failed', 'setDevice');
    this.mode = mode;
    this.flashMode = mode;
    // Entering standalone sets the run latch; entering usbMic clears it.
    this.runRequested = mode === 'standalone';
    this.pausedWrite();
    this.afterRunChange();
    return this.status();
  }

  private timebaseResult(): Timebase {
    const eff = this.timebase.effective(this.hasPps && this.hasGps);
    const pps = this.timebase.pps();
    const g = this.gps;
    const enabled = this.hasGps;
    const cal = this.timebase.cal;
    this.state.live.calPpm = eff.ppm;
    return {
      ppm: eff.ppm,
      source: eff.source,
      calPpm: cal.ppm,
      calSource: cal.source,
      dateUnix: cal.dateUnix,
      durationS: cal.durationS,
      saved: this.timebase.saved,
      logDeltaPpm: this.log.deltaPpm,
      logPending: this.log.pending,
      pps: {
        enabled: this.hasPps,
        locked: this.hasPps && pps.locked,
        ppm: this.hasPps ? pps.ppm : 0,
        window: this.hasPps ? pps.window : 0,
        good: this.hasPps ? pps.good : 0,
        rejects: this.hasPps ? pps.rejects : 0,
        noFix: this.hasPps ? pps.noFix : 0,
      },
      gps: {
        enabled,
        fix: enabled && g.hasFix(),
        quality: enabled && g.hasFix() ? 1 : 0,
        sats: enabled ? g.satsUsed() : 0,
        hdop: enabled ? g.hdop() : 0,
        utcUnix: enabled ? g.utcUnix() : 0,
        ageMs: enabled ? g.ageMs() : -1,
        sentences: enabled ? g.sentences() : 0,
        errors: 0,
        overruns: 0,
      },
    };
  }

  private setTimebase(b: RequestOf<'setTimebase'>): Timebase {
    const raw = b as {
      ppm?: unknown;
      source?: unknown;
      dateUnix?: unknown;
      durationS?: unknown;
      logDeltaPpm?: unknown;
    };
    const hasPpm = typeof raw.ppm === 'number';
    const hasDelta = raw.logDeltaPpm !== undefined;
    if (!hasPpm && !hasDelta) throw new DeviceError('badRequest', 'missing ppm', 'setTimebase');
    const fail = (code: 'badParam' | 'busy', msg: string): DeviceError =>
      new DeviceError(code, msg, 'setTimebase');
    let delta: number | null = null;
    if (hasDelta) {
      const d = raw.logDeltaPpm;
      if (typeof d !== 'number' || !(d >= LOG_DELTA_RANGE.min && d <= LOG_DELTA_RANGE.max)) {
        throw fail('badParam', 'logDeltaPpm must be 0.05..10');
      }
      delta = d;
    }
    let src: 'manual' | 'ntp' | 'none' = 'manual';
    let ppm = 0;
    let date = 0;
    let dur = 0;
    if (hasPpm) {
      ppm = raw.ppm as number;
      if (raw.source !== undefined) {
        const name = typeof raw.source === 'string' ? raw.source.toLowerCase() : '';
        if (name !== 'manual' && name !== 'ntp' && name !== 'none')
          throw fail('badParam', 'source must be none, manual or ntp');
        src = name;
      }
      date = typeof raw.dateUnix === 'number' ? raw.dateUnix : 0;
      dur = typeof raw.durationS === 'number' ? raw.durationS : 0;
      if (
        !Number.isFinite(ppm) ||
        Math.abs(ppm) > 1000 ||
        date < 0 ||
        date > U32_MAX ||
        dur < 0 ||
        dur > U32_MAX
      ) {
        throw fail('badParam', 'ppm must be -1000..1000');
      }
    }
    // Only a changed logDeltaPpm is persisted (flash); RAM-only ppm never gets 'busy'.
    if (delta !== null && delta !== this.log.deltaPpm) {
      if (this.usbStreaming || this.faults.flashBusy) {
        throw fail('busy', 'close the audio stream before saving');
      }
      if (this.faults.flashError)
        throw new DeviceError('flashError', 'flash write failed', 'setTimebase');
    }
    if (hasPpm) {
      this.timebase.set(
        ppm,
        src,
        Math.trunc(date),
        Math.trunc(dur),
        this.hasGps ? this.gps.utcUnix() : 0,
      );
    }
    if (delta !== null) this.log.deltaPpm = delta;
    return this.timebaseResult();
  }

  private saveTimebase(): Timebase {
    if (this.usbStreaming || this.faults.flashBusy) {
      throw new DeviceError('busy', 'close the audio stream before saving', 'saveTimebase');
    }
    if (this.faults.flashError)
      throw new DeviceError('flashError', 'flash write failed', 'saveTimebase');
    const cal = this.timebase.cal;
    const utc = this.hasGps ? this.gps.utcUnix() : 0;
    // A source of 'none' is not representable in the log (manual | ntp | pps); skipped.
    if (cal.source !== 'none') {
      const entry: TimebaseLogEntry = {
        dateUnix: cal.dateUnix !== 0 ? cal.dateUnix : utc,
        ppm: cal.ppm,
        source: cal.source,
        durationS: cal.durationS,
        reason: 'save',
      };
      this.log.append(entry);
    }
    this.log.written(utc);
    this.timebase.commit();
    this.pausedWrite();
    return this.timebaseResult();
  }

  private getEvents(b: RequestOf<'getEvents'>): { events: DspEvent[] } {
    const limit = this.clampInt(b.limit, 1, EVENT_RING, 8);
    const all = this.events.newest(limit);
    const n = fitCount(all, HID_JSON_MAX - REPLY_ENVELOPE_BYTES - '{"events":[]}'.length);
    return { events: all.slice(0, Math.max(n, Math.min(1, all.length))) }; // always the newest
  }

  private timebaseLog(b: object): TimebaseLog {
    const raw = (b as { offset?: unknown }).offset;
    const offset = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return this.log.result(offset);
  }

  private clearTimebaseLog(): TimebaseLog {
    if (this.usbStreaming || this.faults.flashBusy) {
      throw new DeviceError('busy', 'close the audio stream before saving', 'clearTimebaseLog');
    }
    if (this.faults.flashError) {
      throw new DeviceError('flashError', 'flash write failed', 'clearTimebaseLog');
    }
    this.log.clear(this.hasGps ? this.gps.utcUnix() : 0);
    this.pausedWrite();
    return this.log.result(0);
  }

  private getGps(): GpsInfo {
    if (!this.hasGps) throw new DeviceError('badRequest', 'GPS not built in', 'getGps');
    return this.gps.info();
  }
}
