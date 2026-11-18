/**
 * Mechanical watch model.
 *
 * Generates the tick stream of a watch on the stand and runs the same
 * analysis the firmware's `beat_analysis` / `beat_fit` run on it:
 *
 *  - one {@link DspEvent} per tick (when the event detector is enabled),
 *  - one {@link DspBeat} per tick handed to the beat fit once the A/h lock is
 *    established (none while unlocked),
 *  - a least-squares fit `u = a + d*k + c*(-1)^k` over the last `windowS`
 *    seconds giving rate (`-d/nominal*86400`), beat error (`2|c|`) and the
 *    RMS scatter, plus rolling 1 s / `avgS` means (the {@link DspBeatRate}).
 *
 * Sign conventions follow `include/dsp_types.h`: `u` is the tick arrival minus
 * the nominal grid slot, so a gaining watch has `u` DECREASING with slope
 * `-rate/86400 * nominalUs` per beat; the even-k and odd-k clouds sit `BE`
 * apart (even beats +BE/2, odd beats -BE/2).
 *
 * Time runs in "board seconds" (what the sample counter measures): true
 * intervals are scaled by `1 + xtalPpm*1e-6`, and the firmware-style
 * correction `1/(1 + calPpm*1e-6)` is applied when computing `u` and rates, so
 * a perfectly calibrated device reports the configured rate.
 */
import type {
  DspBeat,
  DspBeatRate,
  DspBeatTimingWindow,
  DspEvent,
  TimebaseSource,
} from '@/protocol/types';
import { clamp, mean, median } from '../mathutil';
import type { Rng } from '../rng';

/** Physical description of the watch on the stand. */
export interface MechanicalParams {
  /** Beats (half-oscillations) per hour of the escapement. */
  vph: number;
  /** True rate (s/d, + = gaining). */
  rateSDay: number;
  /** Beat error (ms): separation of the tick and tock clouds. */
  beatErrorMs: number;
  /** True balance amplitude (degrees). */
  amplitudeDeg: number;
  /** True lift angle of the escapement (degrees). */
  liftAngleDeg: number;
  /** RMS timing jitter of individual ticks (µs). */
  jitterUs: number;
  /** Probability that a beat is not detected at all. */
  missedBeatProb: number;
  /** Probability that a spurious off-grid tick is detected after a beat. */
  spuriousProb: number;
  /** Peak-to-peak-ish amplitude of the slow rate wander (s/d). */
  rateWanderSDay: number;
  /** Period of the rate wander (s of signal time). */
  rateWanderPeriodS: number;
  /** Per-beat amplitude jitter, 1 sigma (degrees). */
  amplitudeJitterDeg: number;
  /** Tick peak level (float full scale). */
  signalPeak: number;
  /** Seconds of signal before the beat fit locks onto the A/h. */
  acquireS: number;
}

/** Defaults: a healthy 28800 A/h watch. */
export const DEFAULT_MECHANICAL: MechanicalParams = {
  vph: 28800,
  rateSDay: 4,
  beatErrorMs: 0.3,
  amplitudeDeg: 285,
  liftAngleDeg: 51,
  jitterUs: 25,
  missedBeatProb: 0,
  spuriousProb: 0,
  rateWanderSDay: 0.6,
  rateWanderPeriodS: 240,
  amplitudeJitterDeg: 3,
  signalPeak: 0.3,
  acquireS: 3,
};

/** Device-side settings and environment the model reads on each step. */
export interface MechanicalConfig {
  /** A mechanical watch is on the stand (else only noise: no ticks). */
  attached: boolean;
  /** Analysis sample rate (Hz). */
  sourceHz: number;
  /** Capture rate verified; false disables lock and timing. */
  timebaseOk: boolean;
  /** Board crystal error (ppm, + = fast). */
  xtalPpm: number;
  /** Correction in effect (ppm, + = board fast). */
  calPpm: number;
  /** Where the correction came from. */
  calSource: TimebaseSource;
  /** `beatRate.liftAngle` (degrees), used to turn lift time into amplitude. */
  liftAngleDeg: number;
  /** `beatRate.vph`; 0 = auto nearest common rate. */
  vph: number;
  /** `beatRate.windowS` (s). */
  windowS: number;
  /** `beatRate.avgS` (s). */
  avgS: number;
  /** `eventDetect.enabled`. */
  eventDetectEnabled: boolean;
  /** `eventDetect.prerollMs`. */
  prerollMs: number;
  /** `eventDetect.tailMs`. */
  tailMs: number;
  /** `eventDetect.threshold` (x noise floor). */
  threshold: number;
  /** `beatRate.enabled`. */
  beatRateEnabled: boolean;
  /** Noise floor (float full scale). */
  noiseFloor: number;
}

/** Output of one {@link MechanicalModel.advance}. */
export interface MechanicalOutput {
  /** New beat records, oldest first. */
  beats: DspBeat[];
  /** New events, oldest first. */
  events: DspEvent[];
}

/** Nominal A/h list of `beat_analysis.cpp` (`kCommonVph`). */
export const COMMON_VPH: readonly number[] = [
  14400, 16200, 18000, 19800, 21600, 25200, 28800, 36000, 43200, 57600,
];

const BEAT_FIT_MIN_POINTS = 8;
const BEAT_FIT_MAX_GAP = 8;
const BEAT_FIT_MAX_GRID_ERR = 0.3;
const BEAT_FIT_MAX_REJECTS = 4;
const INTERVAL_HIST = 16;
const AMP_HIST = 8;
const EVENT_LOG_CAP = 32;

interface FitPoint {
  /** Absolute grid index. */
  k: number;
  /** Residual in the BOARD domain (µs), uncorrected. */
  ub: number;
  /** Board time of the tick (s). */
  t: number;
}

interface AvgSample {
  t: number;
  rate: number;
  be: number;
  amp: number;
  rateOk: boolean;
  beOk: boolean;
  ampOk: boolean;
}

interface FitResult {
  rateSDay: number;
  beatErrorMs: number;
  beatErrorValid: boolean;
  jitterUs: number;
  points: number;
}

const EMPTY_WINDOW: DspBeatTimingWindow = {
  rateSDay: 0,
  beatErrorMs: 0,
  amplitudeDeg: 0,
  samples: 0,
  rateValid: false,
  beatErrorValid: false,
  amplitudeValid: false,
};

/**
 * Amplitude from lift time as the firmware computes it (Witschi):
 * `A = lambda / (2 sin(pi f t))`, `f = vph / 7200`.
 * @param liftS Lift time (s).
 * @param vph Nominal A/h.
 * @param liftAngleDeg Lift angle lambda (degrees).
 * @returns Amplitude in degrees, 0 when outside the model.
 */
export function amplitudeFromLift(liftS: number, vph: number, liftAngleDeg: number): number {
  if (liftS < 5e-4 || vph === 0 || liftAngleDeg < 1) return 0;
  const arg = Math.PI * (vph / 7200) * liftS;
  if (arg >= 1) return 0;
  let s = Math.sin(arg);
  if (s < 1e-4) s = arg;
  return liftAngleDeg / (2 * s);
}

/**
 * Inverse of {@link amplitudeFromLift}: the lift time a watch with a given
 * amplitude and (physical) lift angle produces.
 * @param amplitudeDeg Amplitude (degrees).
 * @param vph A/h.
 * @param liftAngleDeg Physical lift angle (degrees).
 * @returns Lift time in seconds.
 */
export function liftTimeFromAmplitude(
  amplitudeDeg: number,
  vph: number,
  liftAngleDeg: number,
): number {
  const f = vph / 7200;
  const ratio = clamp(liftAngleDeg / (2 * Math.max(amplitudeDeg, 1)), 0, 1);
  return Math.asin(ratio) / (Math.PI * f);
}

/** Simulated mechanical watch plus the firmware's beat analysis. */
export class MechanicalModel {
  /** Physical parameters; mutate freely between advances. */
  params: MechanicalParams;

  private readonly rng: Rng;
  private readonly phaseOffset: number;

  private boardT = 0;
  private trueT = 0;
  private physIdx = 0;
  private nextRegular = 0;
  private nextArrival = 0;
  private nextMissed = false;
  private scheduled = false;

  private seq = 0;
  private gridId = 0;
  private eventCount = 0;
  private firstEventT = -1;
  private lastEventT = -1;
  private intervals: number[] = [];
  private locked = false;
  private vphNearest = 0;
  private vphRaw = 0;
  private confidence = 0;

  private grid: { origin: number; nominalUs: number; lastK: number; lastT: number } | null = null;
  private rejects = 0;
  private fit: FitPoint[] = [];
  private amps: number[] = [];
  private lastFit: FitResult | null = null;
  private avg: AvgSample[] = [];
  private liftTimeMs = 0;
  private instant: DspBeatTimingWindow = { ...EMPTY_WINDOW };
  private lastTickTrueT = -1;

  /**
   * @param rng Random source (jitter, missed beats, amplitude scatter).
   * @param params Initial physical parameters (defaults to {@link DEFAULT_MECHANICAL}).
   */
  constructor(rng: Rng, params: MechanicalParams = DEFAULT_MECHANICAL) {
    this.rng = rng;
    this.params = { ...params };
    this.phaseOffset = rng.next() * 2 * Math.PI;
  }

  /** Stream reset (capture restarted): drops all analysis state, `seq` restarts at 0. */
  reset(): void {
    this.boardT = 0;
    this.trueT = 0;
    this.physIdx = 0;
    this.scheduled = false;
    this.seq = 0;
    this.gridId = 0;
    this.eventCount = 0;
    this.firstEventT = -1;
    this.lastEventT = -1;
    this.intervals = [];
    this.dropLock();
    this.amps = [];
    this.avg = [];
    this.liftTimeMs = 0;
    this.instant = { ...EMPTY_WINDOW };
    this.lastTickTrueT = -1;
  }

  /** @returns Seconds of signal time since the last tick (large when none yet). */
  get sinceTickS(): number {
    return this.lastTickTrueT < 0 ? 1e9 : this.trueT - this.lastTickTrueT;
  }

  /** @returns Beats per second of the configured escapement. */
  get beatsPerSecond(): number {
    return this.params.vph / 3600;
  }

  /**
   * Advances signal time and analyses any ticks that arrive.
   * @param dtS Signal seconds elapsed (true time).
   * @param cfg Current device settings.
   * @returns Beats and events produced during the step.
   */
  advance(dtS: number, cfg: MechanicalConfig): MechanicalOutput {
    const out: MechanicalOutput = { beats: [], events: [] };
    this.trueT += dtS;
    this.boardT += dtS * (1 + cfg.xtalPpm * 1e-6);
    if (!cfg.attached) {
      this.scheduled = false;
      return out;
    }
    if (!this.scheduled) this.scheduleFirst(cfg);
    let guard = 0;
    while (this.nextArrival <= this.boardT && guard++ < 20000) {
      if (!this.nextMissed) this.tick(this.nextArrival, cfg, out);
      this.scheduleNext(cfg);
    }
    return out;
  }

  /**
   * Builds the `getBeat` / `beat` notify snapshot.
   * @param cfg Current device settings.
   * @returns The beat-rate snapshot.
   */
  snapshot(cfg: MechanicalConfig): DspBeatRate {
    const nowT = this.trueT;
    const w1 = this.windowMean(nowT, 1);
    const wl = this.windowMean(nowT, cfg.avgS);
    const fit = this.locked && cfg.timebaseOk ? this.lastFit : null;
    const inst = this.locked && cfg.timebaseOk ? this.instant : EMPTY_WINDOW;
    const medianIv = median(this.intervals);
    return {
      vphRaw: this.vphRaw,
      vphNearest: this.locked ? this.vphNearest : 0,
      confidence: this.locked ? this.confidence : 0,
      locked: this.locked && cfg.timebaseOk,
      intervalSamples: Math.round(medianIv * cfg.sourceHz),
      eventsSeen: Math.min(EVENT_LOG_CAP, this.eventCount),
      intervalsHeld: this.intervals.length,
      sourceHz: cfg.sourceHz,
      sourceHzMeasured: cfg.sourceHz * (1 + cfg.xtalPpm * 1e-6),
      timebaseOk: cfg.timebaseOk,
      ratePoints: fit?.points ?? 0,
      jitterUs: fit?.jitterUs ?? 0,
      calPpm: cfg.calPpm,
      calSource: cfg.calSource,
      rateSDay: inst.rateSDay,
      beatErrorMs: inst.beatErrorMs,
      amplitudeDeg: inst.amplitudeDeg,
      liftAngleDeg: cfg.liftAngleDeg,
      liftTimeMs: this.liftTimeMs,
      rateValid: inst.rateValid,
      beatErrorValid: inst.beatErrorValid,
      amplitudeValid: inst.amplitudeValid,
      instant: { ...inst },
      avg1s: w1,
      avgS: cfg.avgS,
      avgLong: wl,
    };
  }

  /** Clears the rolling averages (a `liftAngle` / `vph` change does this in the firmware). */
  clearAverages(): void {
    this.avg = [];
    this.amps = [];
    this.liftTimeMs = 0;
  }

  /** Drops lock / grid / fit (events keep counting). */
  private dropLock(): void {
    this.locked = false;
    this.vphNearest = 0;
    this.vphRaw = 0;
    this.confidence = 0;
    this.grid = null;
    this.rejects = 0;
    this.fit = [];
    this.lastFit = null;
  }

  private wander(): number {
    const p = this.params;
    if (p.rateWanderSDay === 0 || p.rateWanderPeriodS <= 0) return 0;
    return (
      p.rateWanderSDay *
      Math.sin((2 * Math.PI * this.trueT) / p.rateWanderPeriodS + this.phaseOffset)
    );
  }

  /** Board-time length of one regular half-period right now. */
  private boardInterval(cfg: MechanicalConfig): number {
    const g = 1 + (this.params.rateSDay + this.wander()) / 86400;
    return (3600 / this.params.vph / g) * (1 + cfg.xtalPpm * 1e-6);
  }

  private scheduleFirst(cfg: MechanicalConfig): void {
    this.scheduled = true;
    this.nextRegular = this.boardT + this.rng.next() * this.boardInterval(cfg);
    this.prepareNext();
  }

  private scheduleNext(cfg: MechanicalConfig): void {
    this.physIdx++;
    this.nextRegular += this.boardInterval(cfg);
    this.prepareNext();
  }

  /** Decides arrival (BE offset, jitter) and miss status of the next tick. */
  private prepareNext(): void {
    const p = this.params;
    const sign = (this.physIdx & 1) === 0 ? 1 : -1;
    this.nextArrival =
      this.nextRegular + (sign * p.beatErrorMs) / 2000 + (this.rng.gaussian() * p.jitterUs) / 1e6;
    this.nextMissed = this.rng.chance(p.missedBeatProb);
  }

  private tick(ta: number, cfg: MechanicalConfig, out: MechanicalOutput): void {
    this.lastTickTrueT = this.trueT;
    const p = this.params;
    const liftS = liftTimeFromAmplitude(
      Math.max(50, p.amplitudeDeg + this.rng.gaussian() * p.amplitudeJitterDeg),
      p.vph,
      p.liftAngleDeg,
    );
    if (!cfg.eventDetectEnabled) return;
    out.events.push(this.makeEvent(ta, liftS, cfg));
    this.eventCount++;
    this.analyse(ta, liftS, cfg, out);
    if (this.rng.chance(p.spuriousProb) && this.locked && this.grid !== null) {
      this.spurious(ta, cfg, out);
    }
  }

  private makeEvent(ta: number, liftS: number, cfg: MechanicalConfig): DspEvent {
    const fs = cfg.sourceHz;
    const unlockExact = ta * fs;
    const unlock = Math.floor(unlockExact);
    const liftSamples = Math.round(liftS * fs);
    const preroll = Math.round((cfg.prerollMs / 1000) * fs);
    const tail = Math.round((cfg.tailMs / 1000) * fs);
    const peak = this.params.signalPeak * (1 + this.rng.gaussian() * 0.05);
    const noise = Math.max(cfg.noiseFloor, 1e-9);
    const dur = preroll + liftSamples + tail + Math.round(0.004 * fs);
    return {
      startSample: String(Math.max(0, unlock - preroll)),
      peakSample: String(unlock + liftSamples),
      unlockSample: String(unlock),
      dropSample: String(unlock + liftSamples),
      durationSamples: dur,
      riseSamples: preroll + liftSamples,
      liftSamples,
      peakAbs: peak,
      noiseFloor: noise,
      snrDb: 20 * Math.log10(Math.max(peak, 1e-9) / noise),
      energy: peak * peak * dur * 0.02,
      confidence: clamp(peak / (noise * cfg.threshold) / 20, 0, 1),
    };
  }

  /** Beat analysis of one tick (firmware `beat_analysis_on_event`). */
  private analyse(ta: number, liftS: number, cfg: MechanicalConfig, out: MechanicalOutput): void {
    if (this.lastEventT >= 0) {
      const iv = ta - this.lastEventT;
      if (iv > 1 / 40 && iv < 1) {
        this.intervals.push(iv);
        if (this.intervals.length > INTERVAL_HIST) this.intervals.shift();
      }
    }
    if (this.firstEventT < 0) this.firstEventT = this.trueT;
    this.lastEventT = ta;

    if (this.intervals.length < 4 || !cfg.beatRateEnabled || !cfg.timebaseOk) {
      this.dropLock();
      this.updateRaw();
      this.pushAvg(false);
      return;
    }
    this.updateRaw();
    const nearest = cfg.vph !== 0 ? cfg.vph : this.nearestCommon();
    const best = Math.abs(this.vphRaw - nearest);
    const tol = 0.04 * nearest;
    const acquired = this.trueT - this.firstEventT >= this.params.acquireS;
    const lockNow = nearest !== 0 && best <= tol && acquired;
    this.vphNearest = lockNow ? nearest : 0;
    this.confidence = lockNow ? Math.max(0, 1 - best / (tol + 1)) : 0;
    if (!lockNow) {
      this.dropLock();
      this.vphRaw = 3600 / Math.max(median(this.intervals), 1e-9);
      this.pushAvg(false);
      return;
    }
    this.locked = true;
    this.fitTick(ta, liftS, cfg, out);
  }

  private updateRaw(): void {
    const m = median(this.intervals);
    this.vphRaw = m > 0 ? 3600 / m : 0;
  }

  private nearestCommon(): number {
    let best = Infinity;
    let nearest = 0;
    for (const c of COMMON_VPH) {
      const d = Math.abs(this.vphRaw - c);
      if (d < best) {
        best = d;
        nearest = c;
      }
    }
    return nearest;
  }

  /** Grid push + solve + beat record (firmware `beat_fit_push`). */
  private fitTick(ta: number, liftS: number, cfg: MechanicalConfig, out: MechanicalOutput): void {
    const nominalUs = 3.6e9 / this.vphNearest;
    const nominalS = nominalUs / 1e6;
    let status: DspBeat['status'] = 'accepted';
    let k = 0;
    let started = false;
    const g = this.grid;
    if (g === null || g.nominalUs !== nominalUs) {
      started = true;
    } else {
      const steps = (ta - g.lastT) / nominalS;
      const whole = Math.floor(steps + 0.5);
      const gridErr = Math.abs(steps - whole);
      if (whole > BEAT_FIT_MAX_GAP) {
        started = true;
      } else if (whole < 1 || gridErr > BEAT_FIT_MAX_GRID_ERR) {
        if (++this.rejects >= BEAT_FIT_MAX_REJECTS) {
          started = true;
        } else {
          out.beats.push(
            this.makeBeat(ta, g.lastK + whole, 'rejected', liftS, cfg, g.origin, nominalUs),
          );
          return;
        }
      } else {
        k = g.lastK + whole;
      }
    }
    if (started) {
      this.grid = { origin: ta, nominalUs, lastK: 0, lastT: ta };
      this.gridId++;
      this.fit = [];
      this.rejects = 0;
      status = 'started';
      k = 0;
    } else if (this.grid !== null) {
      this.rejects = 0;
      this.grid.lastK = k;
      this.grid.lastT = ta;
    }
    const grid = this.grid;
    if (grid === null) return;
    this.fit.push({ k, ub: (ta - grid.origin) * 1e6 - k * nominalUs, t: ta });
    while (this.fit.length > 1 && ta - (this.fit[0]?.t ?? ta) > cfg.windowS) this.fit.shift();
    this.solve(nominalUs, cfg);
    const beat = this.makeBeat(ta, k, status, liftS, cfg, grid.origin, nominalUs);
    out.beats.push(beat);
    this.updateAmplitude(beat);
  }

  private makeBeat(
    ta: number,
    k: number,
    status: DspBeat['status'],
    liftS: number,
    cfg: MechanicalConfig,
    origin: number,
    nominalUs: number,
  ): DspBeat {
    const u =
      status === 'started' ? 0 : ((ta - origin) * 1e6) / (1 + cfg.calPpm * 1e-6) - k * nominalUs;
    const amp = amplitudeFromLift(liftS, this.vphNearest, cfg.liftAngleDeg);
    const ampValid = amp > 50 && amp < 400;
    return {
      seq: this.seq++,
      gridId: this.gridId,
      sampleIndex: String(Math.floor(ta * cfg.sourceHz)),
      tS: ta,
      k,
      parity: (k & 1) === 0 ? 0 : 1,
      uUs: u,
      nominalUs,
      amplitudeDeg: ampValid ? amp : 0,
      amplitudeValid: ampValid,
      liftMs: liftS * 1000,
      status,
    };
  }

  /** Off-grid junk tick recorded as `rejected` (not part of the fit). */
  private spurious(ta: number, cfg: MechanicalConfig, out: MechanicalOutput): void {
    const g = this.grid;
    if (g === null) return;
    const t = ta + this.rng.range(0.25, 0.75) * (g.nominalUs / 1e6);
    const steps = (t - g.lastT) / (g.nominalUs / 1e6);
    out.beats.push(
      this.makeBeat(
        t,
        g.lastK + Math.floor(steps + 0.5),
        'rejected',
        0,
        cfg,
        g.origin,
        g.nominalUs,
      ),
    );
  }

  /** Least-squares fit `u = a + d k + c s` over the window. */
  private solve(nominalUs: number, cfg: MechanicalConfig): void {
    const pts = this.fit;
    const m = pts.length;
    if (m < BEAT_FIT_MIN_POINTS) {
      this.lastFit = null;
      this.instant = { ...EMPTY_WINDOW };
      this.pushAvg(false);
      return;
    }
    let kbar = 0;
    let sbar = 0;
    let ubar = 0;
    for (const p of pts) {
      kbar += p.k;
      sbar += (p.k & 1) === 0 ? 1 : -1;
      ubar += p.ub;
    }
    kbar /= m;
    sbar /= m;
    ubar /= m;
    let skk = 0;
    let sks = 0;
    let sss = 0;
    let sku = 0;
    let ssu = 0;
    for (const p of pts) {
      const dk = p.k - kbar;
      const ds = ((p.k & 1) === 0 ? 1 : -1) - sbar;
      const du = p.ub - ubar;
      skk += dk * dk;
      sks += dk * ds;
      sss += ds * ds;
      sku += dk * du;
      ssu += ds * du;
    }
    let d: number;
    let c = 0;
    let alt = false;
    const det = skk * sss - sks * sks;
    if (sss > 0.1 * m && det > 1e-6 * skk * sss) {
      d = (sku * sss - ssu * sks) / det;
      c = (ssu * skk - sku * sks) / det;
      alt = true;
    } else {
      d = skk > 0 ? sku / skk : 0;
    }
    let ss = 0;
    for (const p of pts) {
      const s = (p.k & 1) === 0 ? 1 : -1;
      const r = p.ub - ubar - d * (p.k - kbar) - c * (s - sbar);
      ss += r * r;
    }
    const corr = 1 + cfg.calPpm * 1e-6;
    const trueHalfUs = (nominalUs + d) / corr;
    const rate = (1 - trueHalfUs / nominalUs) * 86400;
    this.lastFit = {
      rateSDay: rate,
      beatErrorMs: (2 * Math.abs(c)) / corr / 1000,
      beatErrorValid: alt,
      jitterUs: Math.sqrt(ss / m) / corr,
      points: m,
    };
  }

  private updateAmplitude(beat: DspBeat): void {
    if (beat.amplitudeValid) {
      this.amps.push(beat.amplitudeDeg);
      if (this.amps.length > AMP_HIST) this.amps.shift();
      this.liftTimeMs = beat.liftMs;
    }
    const f = this.lastFit;
    const ampOk = this.amps.length >= 2;
    this.instant = {
      rateSDay: f?.rateSDay ?? 0,
      beatErrorMs: f?.beatErrorValid === true ? f.beatErrorMs : 0,
      amplitudeDeg: ampOk ? median(this.amps) : 0,
      samples: f === null ? 0 : 1,
      rateValid: f !== null,
      beatErrorValid: f?.beatErrorValid === true,
      amplitudeValid: ampOk,
    };
    this.pushAvg(f !== null);
  }

  private pushAvg(push: boolean): void {
    if (!push) return;
    const i = this.instant;
    this.avg.push({
      t: this.trueT,
      rate: i.rateSDay,
      be: i.beatErrorMs,
      amp: i.amplitudeDeg,
      rateOk: i.rateValid,
      beOk: i.beatErrorValid,
      ampOk: i.amplitudeValid,
    });
    const cutoff = this.trueT - 61;
    while (this.avg.length > 0 && (this.avg[0]?.t ?? cutoff) < cutoff) this.avg.shift();
  }

  /** Rolling arithmetic mean of the instant values over the last `spanS` seconds. */
  private windowMean(nowT: number, spanS: number): DspBeatTimingWindow {
    const sel = this.avg.filter((a) => nowT - a.t <= spanS);
    const r = sel.filter((a) => a.rateOk);
    const b = sel.filter((a) => a.beOk);
    const a = sel.filter((x) => x.ampOk);
    return {
      rateSDay: mean(r.map((x) => x.rate)),
      beatErrorMs: mean(b.map((x) => x.be)),
      amplitudeDeg: mean(a.map((x) => x.amp)),
      samples: Math.max(r.length, b.length, a.length),
      rateValid: r.length >= 2,
      beatErrorValid: b.length >= 2,
      amplitudeValid: a.length >= 2,
    };
  }
}
