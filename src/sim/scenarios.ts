/**
 * Simulator control API: what the UI's Simulator panel drives.
 *
 * {@link SimulatorControl} edits the PHYSICAL world of the virtual device (the
 * watch on the stand, the crystal, the sky), injects faults and controls time.
 * It never bypasses the protocol for device settings (block enables, quartz
 * mode, ...): those are changed by the app through requests, except that
 * {@link SimulatorControl.applyPreset} may also select the matching quartz mode
 * for convenience.
 *
 * {@link getSimulatorControl} returns the control of the currently open
 * virtual device, or `undefined` when none is connected. The physical settings
 * are remembered across connections (see {@link SimulatorSettings}).
 */
import type { DeviceError } from '@/transport/Transport';
import type { DspBlockKey, DspFaultReason, QuartzMode } from '@/protocol/types';
import { measuredRate } from './mathutil';
import type { GpsSimParams } from './models/gps';
import type { MechanicalParams } from './models/mechanical';
import type { QuartzSourceParams, WatchKind } from './models/quartzTypes';
import type { TimebaseSimParams } from './models/timebase';
import type { FaultState, VirtualDevice, VirtualDeviceOptions } from './VirtualDevice';

/** Identifiers of the built-in presets. */
export type PresetId =
  'healthy' | 'worn' | 'quartzMotor' | 'lcd' | 'tuningFork' | 'noGps' | 'gpsColdStart';

/** A preset entry for the UI. */
export interface PresetInfo {
  /** Stable id. */
  id: PresetId;
  /** Short label. */
  label: string;
  /** One-sentence description. */
  description: string;
}

/** Firmware build options; take effect at the next connect (they are in `hello.caps`). */
export interface BuildOptions {
  /** Quartz engine present (`caps.quartz`). */
  quartz: boolean;
  /** GPS NMEA present (`caps.gps`). */
  gps: boolean;
  /** PPS input present (`caps.pps`). */
  pps: boolean;
}

/** Physical settings remembered between connections. */
export interface SimulatorSettings {
  attached: WatchKind;
  mechanical: MechanicalParams;
  quartzSource: QuartzSourceParams;
  gps: GpsSimParams;
  timebase: TimebaseSimParams;
  noiseFloor: number;
  timeScale: number;
  latencyMs: number;
  build: BuildOptions;
}

/** Read-only view of the model state, for display next to the measured values. */
export interface SimulatorSnapshot {
  /** A transport is open on this device. */
  connected: boolean;
  /** Capture runs. */
  running: boolean;
  /** Watch on the stand. */
  attached: WatchKind;
  /** Current quartz mode selected through the protocol. */
  quartzMode: QuartzMode;
  /** Simulated seconds since power-up. */
  simWallS: number;
  /** Time acceleration. */
  timeScale: number;
  /** True board crystal error now (ppm). */
  xtalPpm: number;
  /** Correction the device applies (ppm) and its source. */
  effectiveCalPpm: number;
  effectiveCalSource: string;
  /**
   * Rate the device SHOULD display for the attached mechanical watch given its
   * true rate, the crystal and the correction in effect (s/d).
   */
  expectedMechanicalRateSDay: number;
  /** GPS UTC (UNIX s), 0 = none. */
  gpsUtcUnix: number;
  /** GPS has a fix. */
  gpsFix: boolean;
}

/** Control surface for one virtual device. */
export interface SimulatorControl {
  /** Built-in presets. */
  readonly presets: readonly PresetInfo[];
  /**
   * Applies a preset (attached watch + physical parameters).
   * @param id Preset id.
   * @param options `selectMode` (default true) also selects the matching quartz mode.
   */
  applyPreset(id: PresetId, options?: { selectMode?: boolean }): void;

  /** @returns The mechanical watch parameters. */
  getMechanical(): MechanicalParams;
  /** Merges mechanical watch parameters. */
  setMechanical(patch: Partial<MechanicalParams>): void;
  /** @returns The quartz watch parameters. */
  getQuartzSource(): QuartzSourceParams;
  /** Merges quartz watch parameters. */
  setQuartzSource(patch: Partial<QuartzSourceParams>): void;
  /** @returns The GPS receiver parameters. */
  getGps(): GpsSimParams;
  /** Merges GPS receiver parameters. */
  setGps(patch: Partial<GpsSimParams>): void;
  /** Power-cycles the GPS receiver (and its PPS filter). */
  gpsColdStart(): void;
  /** @returns The crystal parameters. */
  getTimebase(): TimebaseSimParams;
  /** Merges crystal parameters. */
  setTimebase(patch: Partial<TimebaseSimParams>): void;
  /** @returns The watch on the stand. */
  getAttached(): WatchKind;
  /** Puts a different watch on the stand. */
  setAttached(kind: WatchKind): void;
  /** @returns The background noise floor (float full scale). */
  getNoiseFloor(): number;
  /** Sets the background noise floor. */
  setNoiseFloor(v: number): void;

  /** @returns The fault flags. */
  getFaults(): FaultState;
  /** Merges fault flags. */
  setFaults(patch: Partial<FaultState>): void;
  /** @returns `true` while the (simulated) USB host streams audio. */
  getUsbStreaming(): boolean;
  /** Opens / closes the simulated USB audio stream. */
  setUsbStreaming(on: boolean): void;
  /**
   * Makes the next `count` requests fail.
   * @param count Number of requests.
   * @param error Code / message to reply (default `internal` / "injected failure").
   * @param op Restrict to one op.
   */
  failNextRequests(
    count: number,
    error?: { code?: DeviceError['code']; message?: string },
    op?: string,
  ): void;
  /** Logs a DSP fault (and ejects the block) as the firmware does. */
  injectDspError(block: DspBlockKey, reason: DspFaultReason): void;
  /** Simulates a capture sample loss (restarts a running quartz measurement). */
  injectSampleLoss(): void;
  /** Drops the link: pending requests fail `disconnected` and listeners fire. */
  disconnect(reason?: string): void;

  /** @returns Simulated seconds per real second. */
  getTimeScale(): number;
  /** Sets time acceleration (slow processes run at `x`; signal models up to the device cap). */
  setTimeScale(x: number): void;
  /** @returns Request latency (ms). */
  getLatencyMs(): number;
  /** Sets request latency (ms). */
  setLatencyMs(ms: number): void;

  /** @returns Firmware build options for the NEXT connect. */
  getBuild(): BuildOptions;
  /** Sets firmware build options for the next connect. */
  setBuild(patch: Partial<BuildOptions>): void;

  /** @returns A snapshot of the model truth. */
  getSnapshot(): SimulatorSnapshot;
  /** Exports the physical settings (remembered across connections). */
  exportSettings(): SimulatorSettings;
  /**
   * Registers a change listener (fires after any control call).
   * @returns Unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}

/** Hooks the transport gives the control. */
export interface ControlHooks {
  /** Drops the link. */
  disconnect(reason?: string): void;
  /** Reads the request latency. */
  getLatencyMs(): number;
  /** Sets the request latency. */
  setLatencyMs(ms: number): void;
  /** Whether the transport is open. */
  isOpen(): boolean;
}

/** The built-in presets. */
export const PRESETS: readonly PresetInfo[] = [
  {
    id: 'healthy',
    label: 'Healthy 28800 watch',
    description: 'Mechanical 28800 A/h, +4 s/d, 285 degrees, 0.3 ms beat error.',
  },
  {
    id: 'worn',
    label: 'Worn watch',
    description: 'Low amplitude (195 degrees), 3 ms beat error, -12 s/d, noisy ticks.',
  },
  {
    id: 'quartzMotor',
    label: 'Quartz motor with inhibition',
    description: 'Analog quartz, 1 s steps, 60 s inhibition cycle with a 4-pulse jump.',
  },
  {
    id: 'lcd',
    label: 'LCD',
    description: 'LCD quartz watch with a 64 Hz pattern on the capacitive pickup.',
  },
  { id: 'tuningFork', label: 'Tuning fork', description: '360 Hz tuning-fork watch.' },
  {
    id: 'noGps',
    label: 'No GPS',
    description: 'Antenna without sky view: no satellites, no fix, no PPS.',
  },
  {
    id: 'gpsColdStart',
    label: 'GPS cold start',
    description: 'Receiver power-cycled: fix after 2 minutes, PPS lock later.',
  },
];

/** Default settings used before anything was configured. */
export function defaultBuild(): BuildOptions {
  return { quartz: true, gps: true, pps: true };
}

let active: SimulatorControl | undefined;
let persisted: SimulatorSettings | undefined;

/** @returns The control of the active virtual device, or `undefined` when none is open. */
export function getSimulatorControl(): SimulatorControl | undefined {
  return active;
}

/**
 * Makes a control the active one (called by the transport).
 * @param control The control.
 */
export function registerSimulatorControl(control: SimulatorControl): void {
  active = control;
}

/**
 * Clears the active control if it is the given one, remembering its settings.
 * @param control The control being released.
 */
export function releaseSimulatorControl(control: SimulatorControl): void {
  if (active === control) {
    persisted = control.exportSettings();
    active = undefined;
  }
}

/** @returns The remembered settings, if any. */
export function getPersistedSettings(): SimulatorSettings | undefined {
  return persisted;
}

/**
 * Turns remembered settings into device options.
 * @param s Settings.
 */
export function settingsToOptions(s: SimulatorSettings): VirtualDeviceOptions {
  return {
    attached: s.attached,
    mechanical: s.mechanical,
    quartzSource: s.quartzSource,
    gpsParams: s.gps,
    timebase: s.timebase,
    noiseFloor: s.noiseFloor,
    timeScale: s.timeScale,
    quartz: s.build.quartz,
    gps: s.build.gps,
    pps: s.build.pps,
  };
}

/** Forgets remembered settings (tests). */
export function clearPersistedSettings(): void {
  persisted = undefined;
}

/**
 * Builds the control for a device.
 * @param device The device.
 * @param hooks Transport hooks.
 * @param build Build options of this device (for {@link SimulatorControl.getBuild}).
 * @param latencyMs Initial latency, remembered for export.
 */
export function createSimulatorControl(
  device: VirtualDevice,
  hooks: ControlHooks,
  build: BuildOptions,
): SimulatorControl {
  const listeners = new Set<() => void>();
  const nextBuild: BuildOptions = { ...build };
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  const changed = <T>(fn: () => T): T => {
    const r = fn();
    emit();
    return r;
  };

  const control: SimulatorControl = {
    presets: PRESETS,
    applyPreset(id, options) {
      changed(() => {
        const select = options?.selectMode ?? true;
        const mode = (m: QuartzMode): void => {
          if (select) device.quartz.setMode(m);
        };
        switch (id) {
          case 'healthy':
            device.attached = 'mechanical';
            device.mechanical.params = { ...device.mechanical.params, ...HEALTHY };
            mode('mechanical');
            break;
          case 'worn':
            device.attached = 'mechanical';
            device.mechanical.params = { ...device.mechanical.params, ...WORN };
            mode('mechanical');
            break;
          case 'quartzMotor':
            device.attached = 'motor';
            device.quartz.source = {
              ...device.quartz.source,
              motorStepS: 1,
              inhibitionPeriodS: 60,
              inhibitionJumpUs: 488.28,
              motorSnr: 15.8,
            };
            mode('motor');
            break;
          case 'lcd':
            device.attached = 'lcd';
            device.quartz.source = {
              ...device.quartz.source,
              lcdNoPattern: false,
              lcdPatternHz: 64,
            };
            mode('lcd');
            break;
          case 'tuningFork':
            device.attached = 'fork';
            mode('fork');
            break;
          case 'noGps':
            device.gps.params = { ...device.gps.params, antenna: false };
            break;
          case 'gpsColdStart':
            device.gps.params = {
              ...device.gps.params,
              antenna: true,
              fixAfterS: 120,
              firstSentenceS: 8,
            };
            device.gps.restartCold();
            device.timebase.resetPps();
            break;
        }
        device.syncFaults();
      });
    },
    getMechanical: () => ({ ...device.mechanical.params }),
    setMechanical: (p) => {
      changed(() => void (device.mechanical.params = { ...device.mechanical.params, ...p }));
    },
    getQuartzSource: () => ({ ...device.quartz.source }),
    setQuartzSource: (p) => {
      changed(() => void (device.quartz.source = { ...device.quartz.source, ...p }));
    },
    getGps: () => ({ ...device.gps.params }),
    setGps: (p) => {
      changed(() => void (device.gps.params = { ...device.gps.params, ...p }));
    },
    gpsColdStart: () => {
      changed(() => {
        device.gps.restartCold();
        device.timebase.resetPps();
      });
    },
    getTimebase: () => ({ ...device.timebase.params }),
    setTimebase: (p) => {
      changed(() => void (device.timebase.params = { ...device.timebase.params, ...p }));
    },
    getAttached: () => device.attached,
    setAttached: (k) => {
      changed(() => void (device.attached = k));
    },
    getNoiseFloor: () => device.noiseFloor,
    setNoiseFloor: (v) => {
      changed(() => void (device.noiseFloor = Math.max(1e-7, v)));
    },
    getFaults: () => ({ ...device.faults }),
    setFaults: (p) => {
      changed(() => {
        Object.assign(device.faults, p);
        device.syncFaults();
      });
    },
    getUsbStreaming: () => device.status().usbStreaming,
    setUsbStreaming: (on) => {
      changed(() => {
        device.setUsbStreaming(on);
      });
    },
    failNextRequests: (count, error, op) => {
      changed(() => {
        device.failNextRequests(
          count > 0
            ? {
                remaining: count,
                code: error?.code ?? 'internal',
                message: error?.message ?? 'injected failure',
                ...(op !== undefined ? { op } : {}),
              }
            : null,
        );
      });
    },
    injectDspError: (block, reason) => {
      changed(() => {
        device.injectError(block, reason);
      });
    },
    injectSampleLoss: () => {
      changed(() => {
        device.injectSampleLoss();
      });
    },
    disconnect: (reason) => {
      hooks.disconnect(reason);
    },
    getTimeScale: () => device.timeScale,
    setTimeScale: (x) => {
      changed(() => {
        device.advance();
        device.timeScale = Math.min(1e6, Math.max(0.01, x));
      });
    },
    getLatencyMs: () => hooks.getLatencyMs(),
    setLatencyMs: (ms) => {
      changed(() => {
        hooks.setLatencyMs(Math.max(0, ms));
      });
    },
    getBuild: () => ({ ...nextBuild }),
    setBuild: (p) => {
      changed(() => void Object.assign(nextBuild, p));
    },
    getSnapshot: () => {
      device.advance();
      const eff = device.quartzContext();
      const gpsOn = device.caps.gps === true;
      return {
        connected: hooks.isOpen(),
        running: device.running,
        attached: device.attached,
        quartzMode: device.quartz.activeMode,
        simWallS: device.simWallS,
        timeScale: device.timeScale,
        xtalPpm: device.timebase.xtalPpm,
        effectiveCalPpm: eff.calPpm,
        effectiveCalSource: eff.calSource,
        expectedMechanicalRateSDay: measuredRate(
          device.mechanical.params.rateSDay,
          eff.xtalPpm,
          eff.calPpm,
        ),
        gpsUtcUnix: gpsOn ? device.gps.utcUnix() : 0,
        gpsFix: gpsOn && device.gps.hasFix(),
      };
    },
    exportSettings: () => ({
      attached: device.attached,
      mechanical: { ...device.mechanical.params },
      quartzSource: { ...device.quartz.source },
      gps: { ...device.gps.params },
      timebase: { ...device.timebase.params },
      noiseFloor: device.noiseFloor,
      timeScale: device.timeScale,
      latencyMs: hooks.getLatencyMs(),
      build: { ...nextBuild },
    }),
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  return control;
}

const HEALTHY: Partial<MechanicalParams> = {
  vph: 28800,
  rateSDay: 4,
  beatErrorMs: 0.3,
  amplitudeDeg: 285,
  liftAngleDeg: 51,
  jitterUs: 25,
  missedBeatProb: 0,
  spuriousProb: 0,
  amplitudeJitterDeg: 3,
};

const WORN: Partial<MechanicalParams> = {
  vph: 28800,
  rateSDay: -12,
  beatErrorMs: 3,
  amplitudeDeg: 195,
  liftAngleDeg: 51,
  jitterUs: 90,
  missedBeatProb: 0.01,
  spuriousProb: 0.01,
  amplitudeJitterDeg: 9,
  rateWanderSDay: 2,
};
