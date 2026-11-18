/**
 * Quartz timing engine model (`quartz_engine.cpp`): mode and settings, the
 * measurement lifecycle (restart rules, `measurementId`, gate / freeze) and
 * the `DspQuartz` snapshot, delegating the per-mode signal work to
 * {@link MotorModel}, {@link LcdModel} and {@link ForkModel}.
 *
 * State progression (HID_CONTROL_PLANE.md 5.3): `idle` (mechanical mode),
 * `waitTimebase`, `unsupportedRate`, `acquiring`, `measuring`, `done`.
 * A frozen (`done`) result keeps the correction it was frozen with and the
 * elapsed time it reached.
 */
import type {
  DspQuartz,
  DspQuartzPulse,
  QuartzMode,
  QuartzState,
  QuartzStateName,
  QuartzTsMethod,
} from '@/protocol/types';
import type { Rng } from '../rng';
import { MotorModel, type MotorAnalysis } from './quartzMotor';
import { ForkModel, LcdModel } from './quartzTone';
import {
  DEFAULT_QUARTZ_SOURCE,
  QUARTZ_LIMITS,
  type QuartzContext,
  type QuartzSourceParams,
} from './quartzTypes';

/** Result of {@link QuartzEngine.setParam}. */
export type QuartzParamResult = 'ok' | 'outOfRange' | 'unknownName';

/** Parameter names accepted by {@link QuartzEngine.setParam}. */
export type QuartzParamName = 'gate' | 'forkHz' | 'tsMethod' | 'kSigma';

/** Quartz engine: settings, measurement lifecycle and snapshots. */
export class QuartzEngine {
  /** Physical description of the quartz watch (mutable by scenarios). */
  source: QuartzSourceParams;

  private readonly motor: MotorModel;
  private readonly lcd: LcdModel;
  private readonly fork: ForkModel;

  private mode: QuartzMode = 'mechanical';
  private gateS = 0;
  private forkHz = 360;
  private ts: QuartzTsMethod = 'threshold';
  private kSigma = 8;

  private measurementId = 0;
  private sampleLossRestarts = 0;
  private elapsed = 0;
  private boardClock = 0;
  private trueClock = 0;
  private done = false;
  private doneReason = '';
  private frozenCal: { ppm: number; source: DspQuartz['calSource'] } | null = null;
  private observedHz: number | null = null;
  private observedOk: boolean | null = null;

  /**
   * @param rng Random source.
   * @param source Initial physical parameters.
   */
  constructor(rng: Rng, source: QuartzSourceParams = DEFAULT_QUARTZ_SOURCE) {
    this.source = { ...source };
    this.motor = new MotorModel(rng);
    this.lcd = new LcdModel(rng);
    this.fork = new ForkModel(rng);
    this.restartMeasurement();
  }

  /** @returns The current settings (`getState.quartz`). */
  settings(): QuartzState {
    return {
      mode: this.mode,
      gateS: this.gateS,
      forkHz: this.forkHz,
      tsMethod: this.ts,
      kSigma: this.kSigma,
    };
  }

  /** @returns The active mode. */
  get activeMode(): QuartzMode {
    return this.mode;
  }

  /** @returns The current measurement id. */
  get currentMeasurementId(): number {
    return this.measurementId;
  }

  /**
   * Selects a mode. Selecting the current mode is a no-op; a different mode
   * starts a new measurement and clears the sample-loss counter.
   * @param mode New mode.
   */
  setMode(mode: QuartzMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.sampleLossRestarts = 0;
    this.restartMeasurement();
  }

  /**
   * Sets one quartz parameter with the firmware's validation. A changed value
   * restarts the measurement when the active mode uses it.
   * @param name Parameter name.
   * @param value New value.
   */
  setParam(name: string, value: number): QuartzParamResult {
    const finite = Number.isFinite(value);
    switch (name) {
      case 'gate': {
        const ok =
          finite &&
          (value === 0 || (value >= QUARTZ_LIMITS.gateMinS && value <= QUARTZ_LIMITS.gateMaxS));
        if (!ok) return 'outOfRange';
        if (value !== this.gateS) {
          this.gateS = value;
          if (this.mode === 'motor') this.restartMeasurement();
        }
        return 'ok';
      }
      case 'forkHz': {
        const match = finite
          ? QUARTZ_LIMITS.forkHz.find((f) => Math.abs(f - value) <= 0.01)
          : undefined;
        if (match === undefined) return 'outOfRange';
        if (match !== this.forkHz) {
          this.forkHz = match;
          if (this.mode === 'fork') this.restartMeasurement();
        }
        return 'ok';
      }
      case 'tsMethod': {
        if (value !== 0 && value !== 1) return 'outOfRange';
        const ts: QuartzTsMethod = value === 1 ? 'xcorr' : 'threshold';
        if (ts !== this.ts) {
          this.ts = ts;
          if (this.mode === 'motor') this.restartMeasurement();
        }
        return 'ok';
      }
      case 'kSigma': {
        if (!finite || value < QUARTZ_LIMITS.kSigmaMin || value > QUARTZ_LIMITS.kSigmaMax) {
          return 'outOfRange';
        }
        if (value !== this.kSigma) {
          this.kSigma = value;
          if (this.mode === 'motor') this.restartMeasurement();
        }
        return 'ok';
      }
      default:
        return 'unknownName';
    }
  }

  /**
   * Starts a new measurement in the active mode (also leaves `done`).
   * @returns `false` in mechanical mode.
   */
  restart(): boolean {
    if (this.mode === 'mechanical') return false;
    this.restartMeasurement();
    return true;
  }

  /** Capture stream reset: a new measurement starts. */
  resetStream(): void {
    this.restartMeasurement();
  }

  /** Records a capture sample-loss event (restarts a running measurement). */
  noteSampleLoss(): void {
    if (this.done || this.mode === 'mechanical') return;
    this.sampleLossRestarts++;
    this.restartMeasurement();
  }

  /**
   * Computes the engine state for a context.
   * @param ctx Environment.
   */
  state(ctx: QuartzContext): QuartzStateName {
    if (this.mode === 'mechanical') return 'idle';
    if (!ctx.timebaseOk) return 'waitTimebase';
    if (ctx.sourceHz !== 48000) return 'unsupportedRate';
    if (this.done) return 'done';
    return this.haveRate(ctx) ? 'measuring' : 'acquiring';
  }

  /**
   * Tells the engine the capture rate / timebase verification (a change
   * restarts the measurement, as `set_source_rate` / `set_timebase` do).
   * @param ctx Environment.
   */
  observe(ctx: QuartzContext): void {
    if (this.observedHz !== null && this.observedHz !== ctx.sourceHz) this.restartMeasurement();
    if (this.observedOk !== null && this.observedOk !== ctx.timebaseOk) this.restartMeasurement();
    this.observedHz = ctx.sourceHz;
    this.observedOk = ctx.timebaseOk;
  }

  /**
   * Advances the measurement by signal time (only call while capture runs).
   * @param dtS True signal seconds.
   * @param ctx Environment.
   */
  advance(dtS: number, ctx: QuartzContext): void {
    this.observe(ctx);
    if (this.mode === 'mechanical' || !ctx.timebaseOk || ctx.sourceHz !== 48000 || this.done)
      return;
    const x = 1 + ctx.xtalPpm * 1e-6;
    this.trueClock += dtS;
    this.boardClock += dtS * x;
    this.elapsed += dtS * x;
    const timed = this.gateS > 0;
    if (timed && this.elapsed > this.gateS) this.elapsed = this.gateS;
    switch (this.mode) {
      case 'motor':
        this.motor.advance(
          this.boardClock,
          this.trueClock,
          ctx.xtalPpm,
          this.source,
          this.kSigma,
          ctx.attached === 'motor',
          timed ? this.gateS : null,
        );
        break;
      case 'lcd':
        this.lcd.advance(dtS * x);
        break;
      case 'fork':
        this.fork.advance(dtS * x);
        break;
      default:
        break;
    }
    if (this.mode === 'motor') {
      if (timed && this.elapsed >= this.gateS) {
        const a = this.analyseMotor(ctx);
        this.freeze(a.valid ? 'gate reached' : 'gate reached before 3 pulses', ctx);
      } else if (!timed && this.analyseMotor(ctx).twoEventsDone) {
        this.freeze('two inhibition events seen', ctx);
      }
    }
  }

  /**
   * Builds the `getQuartz` / `quartz` notify snapshot.
   * @param ctx Environment.
   */
  snapshot(ctx: QuartzContext): DspQuartz {
    const state = this.state(ctx);
    const cal =
      this.done && this.frozenCal ? this.frozenCal : { ppm: ctx.calPpm, source: ctx.calSource };
    const out: DspQuartz = {
      mode: this.mode,
      state,
      measurementId: this.measurementId,
      reason: '',
      sourceHz: ctx.sourceHz,
      timebaseOk: ctx.timebaseOk,
      elapsedS: 0,
      gateS: this.gateS,
      forkHz: this.forkHz,
      tsMethod: this.ts,
      kSigma: this.kSigma,
      sampleLossRestarts: this.sampleLossRestarts,
      rateSDay: 0,
      rateValid: false,
      calPpm: cal.ppm,
      calSource: cal.source,
      calibrated: cal.source !== 'none',
      motor: null,
      lcd: null,
      fork: null,
    };
    if (this.mode === 'mechanical') {
      out.reason = 'mechanical mode';
      return out;
    }
    if (state === 'waitTimebase') {
      out.reason = 'capture rate not verified';
      this.fillDetail(out, ctx, cal.ppm);
      return out;
    }
    if (state === 'unsupportedRate') {
      out.reason = 'quartz timing needs a 48 kHz capture rate';
      this.fillDetail(out, ctx, cal.ppm);
      return out;
    }
    out.elapsedS = this.elapsed;
    this.fillDetail(out, ctx, cal.ppm);
    out.rateValid = this.detailValid(out);
    if (state === 'done') {
      out.reason = this.doneReason;
    } else if (state === 'acquiring') {
      out.reason = this.acquiringReason(out);
    }
    out.rateSDay = this.headline(out);
    return out;
  }

  /**
   * Recent motor pulses, newest first (empty outside motor mode).
   * @param ctx Environment.
   * @param max Maximum count.
   */
  recentPulses(ctx: QuartzContext, max: number): DspQuartzPulse[] {
    if (this.mode !== 'motor' || this.state(ctx) === 'idle') return [];
    return this.motor.recent(this.measurementId, this.elapsed, max);
  }

  /**
   * Closed pulses at or after a sequence number, oldest first (notify feed).
   * @param ctx Environment.
   * @param fromSeq First sequence wanted.
   */
  closedPulsesFrom(ctx: QuartzContext, fromSeq: number): DspQuartzPulse[] {
    if (this.mode !== 'motor' || this.state(ctx) === 'idle') return [];
    return this.motor.closedFrom(this.measurementId, this.elapsed, fromSeq);
  }

  /** @returns Signal peak (float full scale) of the attached quartz watch, for the level meters. */
  signalPeak(ctx: QuartzContext): number {
    return this.mode !== 'mechanical' && ctx.attached === this.mode ? this.source.signalPeak : 0;
  }

  private restartMeasurement(): void {
    this.measurementId = (this.measurementId + 1) >>> 0;
    this.elapsed = 0;
    this.boardClock = 0;
    this.trueClock = 0;
    this.done = false;
    this.doneReason = '';
    this.frozenCal = null;
    this.motor.restart(0);
    this.lcd.restart();
    this.fork.restart();
  }

  private freeze(reason: string, ctx: QuartzContext): void {
    this.done = true;
    this.doneReason = reason;
    this.frozenCal = { ppm: ctx.calPpm, source: ctx.calSource };
  }

  private analyseMotor(ctx: QuartzContext, calPpm = ctx.calPpm): MotorAnalysis {
    return this.motor.analyse(this.source, this.kSigma, calPpm, this.elapsed, this.gateS);
  }

  private fillDetail(out: DspQuartz, ctx: QuartzContext, calPpm: number): void {
    switch (this.mode) {
      case 'motor':
        out.motor = this.analyseMotor(ctx, calPpm).motor;
        break;
      case 'lcd':
        out.lcd = this.lcd.snapshot(this.source, ctx.attached === 'lcd', ctx.xtalPpm, calPpm);
        break;
      case 'fork':
        out.fork = this.fork.snapshot(
          this.source,
          ctx.attached === 'fork',
          this.forkHz,
          ctx.xtalPpm,
          calPpm,
        );
        break;
      default:
        break;
    }
  }

  private detailValid(q: DspQuartz): boolean {
    return (q.motor?.valid ?? q.lcd?.valid ?? q.fork?.valid) === true;
  }

  private haveRate(ctx: QuartzContext): boolean {
    switch (this.mode) {
      case 'motor':
        return this.analyseMotor(ctx).valid;
      case 'lcd':
        return this.lcd.snapshot(this.source, ctx.attached === 'lcd', 0, 0).valid;
      case 'fork':
        return this.fork.snapshot(this.source, ctx.attached === 'fork', this.forkHz, 0, 0).valid;
      default:
        return false;
    }
  }

  private headline(q: DspQuartz): number {
    return q.motor?.rateWithSDay ?? q.lcd?.rateSDay ?? q.fork?.rateSDay ?? 0;
  }

  private acquiringReason(q: DspQuartz): string {
    if (this.elapsed === 0) return 'waiting for audio stream';
    switch (this.mode) {
      case 'motor':
        return 'waiting for 3 pulses';
      case 'lcd':
        if (q.lcd?.status === 'tracking') return 'collecting phase blocks';
        return (q.lcd?.retries ?? 0) > 0
          ? 'no LCD pattern yet; retrying'
          : 'detecting LCD pattern rate';
      case 'fork':
        return 'collecting phase blocks';
      default:
        return '';
    }
  }
}

/**
 * Parses a quartz mode name case-insensitively.
 * @param name Candidate name.
 * @returns The mode, or `null` when unknown.
 */
export function parseQuartzMode(name: string): QuartzMode | null {
  const n = name.toLowerCase();
  return n === 'mechanical' || n === 'motor' || n === 'lcd' || n === 'fork' ? n : null;
}

/**
 * Parses a timestamp-method name or number.
 * @param v `"threshold"` / `"xcorr"` (any case) or `0` / `1`.
 * @returns 0 / 1, or `null` when invalid.
 */
export function parseTsMethod(v: unknown): 0 | 1 | null {
  if (v === 0 || v === 1) return v;
  if (typeof v === 'string') {
    const n = v.toLowerCase();
    if (n === 'threshold') return 0;
    if (n === 'xcorr') return 1;
  }
  return null;
}
