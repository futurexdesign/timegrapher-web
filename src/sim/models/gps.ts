/**
 * GPS receiver model: a constellation of ~16 satellites across GP / GL / GA /
 * BD that move slowly over the sky, per-satellite SNRs, fix acquisition after
 * a configurable time and a UTC clock that starts once the first sentence is
 * parsed. Produces the `getGps` payload and the `Timebase.gps` fields.
 *
 * All times are receiver time in seconds since power-up (the simulator feeds
 * it accelerated wall time).
 */
import type { GpsInfo, GpsSat, GpsSystem } from '@/protocol/types';
import { clamp } from '../mathutil';
import type { Rng } from '../rng';

/** Receiver / environment parameters. */
export interface GpsSimParams {
  /** Antenna has a sky view; false means no satellites and no fix. */
  antenna: boolean;
  /** Seconds from power-up (or {@link GpsModel.restartCold}) to a position fix. */
  fixAfterS: number;
  /** Seconds until the first sentence gives UTC. */
  firstSentenceS: number;
  /** UTC (UNIX s) at receiver time 0. */
  utcEpochUnix: number;
  /** Latitude (degrees). */
  lat: number;
  /** Longitude (degrees). */
  lon: number;
  /** Altitude (m). */
  altM: number;
  /** Number of satellites above the horizon in the constellation (max 16). */
  satCount: number;
}

/** Defaults: warm sky view, fix after 25 s. */
export const DEFAULT_GPS: GpsSimParams = {
  antenna: true,
  fixAfterS: 25,
  firstSentenceS: 2,
  utcEpochUnix: 1_780_000_000,
  lat: 47.6062,
  lon: -122.3321,
  altM: 56,
  satCount: 16,
};

interface Sat {
  sys: GpsSystem;
  prn: number;
  az0: number;
  azRateDegS: number;
  elBase: number;
  elAmp: number;
  elPeriodS: number;
  phase: number;
  snrBase: number;
  acqS: number;
}

const CONSTELLATION: readonly { sys: GpsSystem; prns: readonly number[] }[] = [
  { sys: 'GP', prns: [2, 5, 12, 13, 15, 20, 25, 29] },
  { sys: 'GL', prns: [3, 12, 18, 21] },
  { sys: 'GA', prns: [4, 11] },
  { sys: 'BD', prns: [6, 19] },
];

/** Simulated GNSS receiver. */
export class GpsModel {
  /** Receiver parameters; mutate between advances. */
  params: GpsSimParams;

  private readonly sats: Sat[] = [];
  private t = 0;

  /**
   * @param rng Random source for the constellation geometry.
   * @param params Initial parameters.
   */
  constructor(rng: Rng, params: GpsSimParams = DEFAULT_GPS) {
    this.params = { ...params };
    for (const c of CONSTELLATION) {
      for (const prn of c.prns) {
        this.sats.push({
          sys: c.sys,
          prn,
          az0: rng.range(0, 360),
          azRateDegS: rng.range(0.004, 0.011) * (rng.chance(0.5) ? 1 : -1),
          elBase: rng.range(25, 65),
          elAmp: rng.range(10, 25),
          elPeriodS: rng.range(6000, 14000),
          phase: rng.range(0, 2 * Math.PI),
          snrBase: rng.range(32, 44),
          acqS: rng.range(1, Math.max(2, this.params.fixAfterS * 0.8)),
        });
      }
    }
  }

  /** @returns Receiver time since power-up (s). */
  get time(): number {
    return this.t;
  }

  /**
   * Advances receiver time.
   * @param dtS Seconds.
   */
  advance(dtS: number): void {
    this.t += dtS;
  }

  /** Cold start: forgets everything, as after a power cycle. */
  restartCold(): void {
    this.t = 0;
  }

  /** @returns `true` once a position fix exists. */
  hasFix(): boolean {
    return this.params.antenna && this.t >= this.params.fixAfterS && this.usedCount() >= 4;
  }

  /** @returns Current UTC (UNIX s), 0 until the first sentence. */
  utcUnix(): number {
    if (!this.params.antenna || this.t < this.params.firstSentenceS) return 0;
    return Math.floor(this.params.utcEpochUnix + this.t);
  }

  /** @returns Milliseconds since the last RMC sentence, -1 = never. */
  ageMs(): number {
    if (!this.params.antenna || this.t < this.params.firstSentenceS) return -1;
    return Math.floor((this.t % 1) * 1000);
  }

  /** @returns Sentences parsed so far (about 8 per second). */
  sentences(): number {
    return this.params.antenna ? Math.floor(Math.max(0, this.t - 0.5) * 8) : 0;
  }

  /** @returns Satellites used in the fix (0 without a fix). */
  satsUsed(): number {
    return this.hasFix() ? this.usedCount() : 0;
  }

  /** @returns Current HDOP (0 = unknown). */
  hdop(): number {
    const n = this.satsUsed();
    return n === 0 ? 0 : Math.round((0.7 + 5 / n) * 100) / 100;
  }

  /** Builds the `getGps` payload. */
  info(): GpsInfo {
    const fix = this.hasFix();
    const used = fix ? this.usedSet() : new Set<Sat>();
    const sats: GpsSat[] = [];
    for (const s of this.activeSats()) {
      const v = this.state(s);
      if (!v.visible) continue;
      sats.push([
        s.sys,
        s.prn,
        Math.round(v.el),
        Math.round(v.az),
        v.tracked ? Math.round(v.snr) : -1,
        used.has(s) ? 1 : 0,
      ]);
    }
    const n = used.size;
    const hdop = this.hdop();
    return {
      fix,
      quality: fix ? 1 : 0,
      utcUnix: this.utcUnix(),
      ageMs: this.ageMs(),
      satsUsed: n,
      hdop,
      pdop: n === 0 ? 0 : Math.round(hdop * 1.4 * 100) / 100,
      vdop: n === 0 ? 0 : Math.round(hdop * 1.1 * 100) / 100,
      lat: fix ? this.params.lat : 0,
      lon: fix ? this.params.lon : 0,
      altM: fix ? this.params.altM : 0,
      posValid: fix,
      satCols: ['sys', 'prn', 'el', 'az', 'snr', 'used'],
      sats: sats.slice(0, 32),
    };
  }

  private activeSats(): Sat[] {
    return this.sats.slice(0, clamp(this.params.satCount, 0, this.sats.length));
  }

  private state(s: Sat): {
    visible: boolean;
    tracked: boolean;
    el: number;
    az: number;
    snr: number;
  } {
    if (!this.params.antenna) return { visible: false, tracked: false, el: -1, az: -1, snr: -1 };
    const el = s.elBase + s.elAmp * Math.sin((2 * Math.PI * this.t) / s.elPeriodS + s.phase);
    const az = (((s.az0 + s.azRateDegS * this.t) % 360) + 360) % 360;
    const visible = el >= 5 && this.t >= 0.5;
    const tracked = visible && this.t >= s.acqS;
    const snr = clamp(s.snrBase + 0.15 * (el - 45) + 1.5 * Math.sin(this.t / 17 + s.phase), 14, 52);
    return { visible, tracked, el, az, snr };
  }

  private usedSet(): Set<Sat> {
    const cand = this.activeSats()
      .map((s) => ({ s, v: this.state(s) }))
      .filter((x) => x.v.tracked && x.v.snr >= 28 && x.v.el >= 10)
      .sort((a, b) => b.v.snr - a.v.snr)
      .slice(0, 12);
    return new Set(cand.map((x) => x.s));
  }

  private usedCount(): number {
    return this.usedSet().size;
  }
}
