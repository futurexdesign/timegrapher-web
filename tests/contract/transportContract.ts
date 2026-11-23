/**
 * Transport contract suite.
 *
 * Written against the {@link Transport} interface only: run it with a
 * {@link ContractHarness} for the simulator (default) or for real hardware.
 * Covers hello / caps, getState / patchState semantics and error codes,
 * subscribe clamping and cadence, run control and device mode, beat ordering
 * and the slope / parity relationships, quartz mode switching and restart,
 * the timebase (set / save / clear / busy), the timebase log (paging), GPS and
 * `getTime`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beatsOfResult, decodeBeatsPacked } from '@/protocol/beatsPacked';
import type {
  DspBeat,
  HidNotify,
  OpName,
  RequestOf,
  ResultOf,
  TimebaseLog,
} from '@/protocol/types';
import { DeviceError, type Transport } from '@/transport/Transport';
import type { ContractHarness } from './harness';

/** Reads the error of a rejected promise. */
async function errorOf(p: Promise<unknown>): Promise<DeviceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DeviceError) return e;
    throw e;
  }
  throw new Error('expected the request to fail');
}

/**
 * Registers the contract tests.
 * @param make Creates a harness (called once per test).
 */
export function runTransportContract(make: () => ContractHarness): void {
  describe(`transport contract (${make().name})`, () => {
    let h: ContractHarness;
    let t: Transport;
    let notifies: HidNotify[];

    const req = <O extends OpName>(op: O, body?: RequestOf<O>): Promise<ResultOf<O>> =>
      h.run(t.request(op, body));
    const logReq = (offset?: number): Promise<TimebaseLog> =>
      req('getTimebaseLog', offset === undefined ? {} : { offset });

    beforeEach(async () => {
      h = make();
      t = await h.create();
      notifies = [];
      t.onNotify((n) => notifies.push(n));
    });
    afterEach(async () => {
      await h.dispose();
    });

    describe('hello / caps', () => {
      it('reports identity and capabilities', async () => {
        const hello = await req('hello');
        expect(hello.protocolVersion).toBe(1);
        const c = hello.caps;
        expect(c.maxJsonBytes).toBe(2048);
        expect(c.metricsHzMax).toBe(20);
        expect(c.beatHzMax).toBe(5);
        expect(c.blocks).toContain('beatRate');
        expect(c.blocks).not.toContain('bypass' as never);
        expect(c.beatsMax).toBe(8);
        expect(c.timebaseLogMax).toBe(24);
      });

      it('advertises the real pipeline order', async () => {
        const { caps } = await req('hello');
        const nodes = caps.pipeline ?? [];
        const by = new Map(nodes.map((n) => [n.key, n]));
        const chain = [
          'input',
          'notch',
          'filterBank',
          'firBank',
          'softGate',
          'gain',
          'agc',
          'limiter',
          'pcm24',
          'usb',
        ];
        for (let i = 1; i < chain.length; i++) {
          expect(by.get(chain[i] ?? '')?.inputs).toEqual([chain[i - 1]]);
        }
        expect(by.get('levelMeter')?.inputs).toEqual(['input', 'limiter']);
        expect(by.get('eventDetect')?.inputs).toEqual(['input', 'noiseFloor', 'matchedFilter']);
        expect(by.get('eventLog')?.inputs).toEqual(['eventDetect']);
        expect(by.get('beatRate')?.inputs).toEqual(['eventDetect']);
        if (caps.quartz) expect(by.get('quartz')?.inputs).toEqual(['input']);
      });

      it('rejects unknown ops', async () => {
        const e = await errorOf(req('nonexistent' as OpName));
        expect(e.code).toBe('unknownOp');
      });
    });

    describe('state', () => {
      it('has the documented defaults', async () => {
        const s = await req('getState');
        expect(s.bypass).toBe(true);
        expect(s.blocks.notch?.params.hz).toBe(60);
        expect(s.blocks.eventDetect?.params).toEqual({ threshold: 6, prerollMs: 25, tailMs: 25 });
        expect(s.blocks.beatRate?.params.liftAngle).toBe(51);
        if ((await req('hello')).caps.quartz) expect(s.quartz?.mode).toBe('mechanical');
      });

      it('enabling a process block clears bypass', async () => {
        const s = await req('patchState', { patch: { blocks: { notch: { enabled: true } } } });
        expect(s.bypass).toBe(false);
        expect(s.blocks.notch?.enabled).toBe(true);
      });

      it('writing gain.db enables gain and clears bypass', async () => {
        const s = await req('patchState', { patch: { blocks: { gain: { params: { db: 6 } } } } });
        expect(s.blocks.gain).toEqual({ enabled: true, params: { db: 6 } });
        expect(s.bypass).toBe(false);
      });

      it('ignores read-only params', async () => {
        const s = await req('patchState', {
          patch: {
            blocks: { agc: { params: { gainDb: 9 } }, beatRate: { params: { calPpm: 99 } } },
          },
        });
        expect(s.blocks.agc?.params.gainDb).toBe(0);
        expect(s.blocks.beatRate?.params.calPpm).toBe(0);
      });

      it('replies badParam on a range error without rolling back', async () => {
        const e = await errorOf(
          req('patchState', { patch: { bypass: false, blocks: { gain: { params: { db: 99 } } } } }),
        );
        expect(e.code).toBe('badParam');
        expect(e.message).toBe('patch rejected');
        expect((await req('getState')).bypass).toBe(false);
      });

      it('validates notch hz and quartz fields with named messages', async () => {
        const hz = await errorOf(
          req('patchState', { patch: { blocks: { notch: { params: { hz: 55 as 50 } } } } }),
        );
        expect(hz.code).toBe('badParam');
        if (!(await req('hello')).caps.quartz) return;
        const k = await errorOf(req('patchState', { patch: { quartz: { kSigma: 99 } } }));
        expect(k.message).toBe('quartz.kSigma must be 4..20');
        const g = await errorOf(req('patchState', { patch: { quartz: { gateS: 1 } } }));
        expect(g.message).toBe('quartz.gateS must be 0 or 3..960');
        const m = await errorOf(
          req('patchState', { patch: { quartz: { mode: 'bogus' as 'motor' } } }),
        );
        expect(m.message).toBe('quartz.mode must be mechanical, motor, lcd or fork');
      });

      it('echoing getState back is a no-op that does not restart quartz', async () => {
        const hello = await req('hello');
        if (!hello.caps.quartz) return;
        await req('patchState', { patch: { quartz: { mode: 'motor' } } });
        const before = await req('getQuartz');
        const state = await req('getState');
        await req('patchState', { patch: { quartz: state.quartz ?? {} } });
        expect((await req('getQuartz')).measurementId).toBe(before.measurementId);
      });

      it('requires a patch object', async () => {
        const e = await errorOf(req('patchState', {} as RequestOf<'patchState'>));
        expect(e.code).toBe('badRequest');
      });
    });

    describe('subscribe', () => {
      it('clamps rates and keeps omitted fields', async () => {
        const a = await req('subscribe', {
          metricsHz: 99,
          beatHz: 99,
          timingHz: -3,
          quartzHz: 99,
          events: true,
        });
        expect(a.metricsHz).toBe(20);
        expect(a.beatHz).toBe(5);
        expect(a.timingHz).toBe(0);
        expect(a.quartzHz).toBeLessThanOrEqual(5);
        const b = await req('subscribe', { errors: true });
        expect(b.metricsHz).toBe(20);
        expect(b.events).toBe(true);
        expect(b.errors).toBe(true);
      });

      it('pushes metrics at the requested cadence and nothing else', async () => {
        await req('subscribe', { metricsHz: 10 });
        notifies.length = 0;
        await h.advance(2000);
        const n = notifies.filter((x) => x.op === 'metrics').length;
        expect(n).toBeGreaterThanOrEqual(17);
        expect(n).toBeLessThanOrEqual(21);
        expect(notifies.every((x) => x.op === 'metrics')).toBe(true);
      });

      it('does not replay history on subscribe', async () => {
        await req('start');
        await h.advance(3000);
        expect((await req('getEvents', { limit: 32 })).events.length).toBeGreaterThan(5);
        await req('subscribe', { events: true });
        notifies.length = 0;
        await h.advance(30);
        const replayed = notifies.flatMap((x) => (x.op === 'event' ? x.data.events : []));
        expect(replayed.length).toBeLessThanOrEqual(1);
      });
    });

    describe('run control and device mode', () => {
      it('start / stop toggle runRequested', async () => {
        const a = await req('start');
        expect(a.runRequested).toBe(true);
        expect(a.running).toBe(true);
        const b = await req('stop');
        expect(b.runRequested).toBe(false);
      });

      it('rejects a bad mode and persists a good one', async () => {
        const e = await errorOf(req('setDevice', { mode: 'nope' as 'usbMic' }));
        expect(e.code).toBe('badParam');
        expect(e.message).toBe('device.mode must be usbMic or standalone');
        const s = await req('setDevice', { mode: 'standalone' });
        expect(s.mode).toBe('standalone');
        expect(s.saved).toBe(true);
        expect(s.runRequested).toBe(true);
      });

      it('replies busy to setDevice while the stream is open', async () => {
        if (!h.setUsbStreaming) return;
        h.setUsbStreaming(true);
        const e = await errorOf(req('setDevice', { mode: 'standalone' }));
        expect(e.code).toBe('busy');
        expect(e.message).toBe('close the audio stream before changing mode');
        const s = await req('stop');
        expect(s.running).toBe(true);
      });

      it('freezes measurements while stopped', async () => {
        await req('start');
        await h.advance(4000);
        await req('stop');
        const a = beatsOfResult(await req('getBeats', { max: 1 }))[0];
        await h.advance(4000);
        const b = beatsOfResult(await req('getBeats', { max: 1 }))[0];
        expect(b?.seq).toBe(a?.seq);
      });
    });

    describe('beats', () => {
      /** Collects beats through the subscription for `ms`. */
      async function collect(ms: number): Promise<DspBeat[]> {
        await req('setTimebase', { ppm: h.expected?.calPpm ?? 0 });
        await req('subscribe', { beats: true });
        await req('start');
        notifies.length = 0;
        await h.advance(ms);
        return notifies.flatMap((x) => (x.op === 'beats' ? x.data.beats : []));
      }

      it('numbers beats in order with alternating parity', async () => {
        const beats = await collect(12000);
        expect(beats.length).toBeGreaterThan(20);
        for (let i = 1; i < beats.length; i++) {
          const a = beats[i - 1] as DspBeat;
          const b = beats[i] as DspBeat;
          expect(b.seq).toBe(a.seq + 1);
          expect(b.tS).toBeGreaterThan(a.tS);
          if (a.gridId === b.gridId && b.status === 'accepted') {
            expect(b.parity).toBe(b.k & 1);
            expect(b.k).toBeGreaterThan(a.k);
          }
        }
        expect(beats[0]?.status).toBe('started');
      });

      it('caps a notify at 8 beats and getBeats at 8 (newest first)', async () => {
        await collect(12000);
        for (const n of notifies)
          if (n.op === 'beats') expect(n.data.beats.length).toBeLessThanOrEqual(8);
        const beats = beatsOfResult(await req('getBeats', { max: 99 }));
        expect(beats.length).toBeLessThanOrEqual(8);
        for (let i = 1; i < beats.length; i++) {
          expect((beats[i] as DspBeat).seq).toBeLessThan((beats[i - 1] as DspBeat).seq);
        }
      });

      it('PK-30 delivers packed beats in seq order when caps.beatsPacked is set', async () => {
        if ((await req('hello')).caps.beatsPacked === undefined) return;
        await req('setTimebase', { ppm: h.expected?.calPpm ?? 0 });
        await req('subscribe', { beatsPacked: true });
        await req('start');
        notifies.length = 0;
        await h.advance(12000);
        expect(notifies.some((n) => n.op === 'beats')).toBe(false);
        const beats = notifies.flatMap((n) =>
          n.op === 'beatsPacked' ? decodeBeatsPacked(n.data.p, 48000) : [],
        );
        expect(beats.length).toBeGreaterThan(20);
        for (let i = 1; i < beats.length; i++) {
          const a = beats[i - 1] as DspBeat;
          const b = beats[i] as DspBeat;
          expect(b.seq).toBe(a.seq + 1);
          expect(b.tS).toBeGreaterThan(a.tS);
        }
        expect(beats[0]?.status).toBe('started');
      });

      it('PK-31 getBeats {packed: true} returns the newest beats, newest last', async () => {
        if ((await req('hello')).caps.beatsPacked === undefined) return;
        await collect(12000);
        const r = await req('getBeats', { max: 8, packed: true });
        expect(r).toHaveProperty('p');
        const beats = beatsOfResult(r, 48000);
        const plain = beatsOfResult(await req('getBeats', { max: 8 }));
        expect(beats.at(-1)?.seq).toBe(plain[0]?.seq);
        for (let i = 1; i < beats.length; i++) {
          expect((beats[i] as DspBeat).seq).toBeGreaterThan((beats[i - 1] as DspBeat).seq);
        }
      });

      it('fits the configured rate and beat error from u over time', async () => {
        const exp = h.expected;
        if (!exp) return;
        const all = await collect(40000);
        const grid = all.at(-1)?.gridId;
        const pts = all.filter((b) => b.gridId === grid && b.status !== 'rejected');
        expect(pts.length).toBeGreaterThan(100);
        // LS u = a + d k + c s
        const n = pts.length;
        const kbar = pts.reduce((s, b) => s + b.k, 0) / n;
        const sbar = pts.reduce((s, b) => s + (b.parity === 0 ? 1 : -1), 0) / n;
        const ubar = pts.reduce((s, b) => s + b.uUs, 0) / n;
        let skk = 0,
          sks = 0,
          sss = 0,
          sku = 0,
          ssu = 0;
        for (const b of pts) {
          const dk = b.k - kbar;
          const ds = (b.parity === 0 ? 1 : -1) - sbar;
          const du = b.uUs - ubar;
          skk += dk * dk;
          sks += dk * ds;
          sss += ds * ds;
          sku += dk * du;
          ssu += ds * du;
        }
        const det = skk * sss - sks * sks;
        const d = (sku * sss - ssu * sks) / det;
        const c = (ssu * skk - sku * sks) / det;
        const rate = (-d / exp.nominalUs) * 86400;
        expect(Math.abs(rate - exp.rateSDay)).toBeLessThan(0.3);
        expect(Math.abs(2 * Math.abs(c) - exp.beatErrorMs * 1000)).toBeLessThan(100);
        const sep =
          pts.filter((b) => b.parity === 0).reduce((s, b) => s + b.uUs, 0) /
            pts.filter((b) => b.parity === 0).length -
          pts.filter((b) => b.parity === 1).reduce((s, b) => s + b.uUs, 0) /
            pts.filter((b) => b.parity === 1).length;
        expect(Math.abs(Math.abs(sep) - exp.beatErrorMs * 1000)).toBeLessThan(150);
      });

      it('reports the same rate in getBeat once locked', async () => {
        const exp = h.expected;
        if (!exp) return;
        await collect(15000);
        const b = await req('getBeat');
        expect(b.locked).toBe(true);
        expect(b.vphNearest).toBe(28800);
        expect(Math.abs(b.rateSDay - exp.rateSDay)).toBeLessThan(0.6);
        expect(Math.abs(b.beatErrorMs - exp.beatErrorMs)).toBeLessThan(0.2);
        expect(b.ratePoints).toBeGreaterThanOrEqual(8);
      });

      it('restarts seq at 0 on a stream reset', async () => {
        await collect(5000);
        await req('stop');
        await req('start');
        await h.advance(6000);
        const newest = beatsOfResult(await req('getBeats', { max: 8 }));
        expect(Math.min(...newest.map((b) => b.seq))).toBeLessThan(80);
        expect(newest.at(-1)?.seq).toBeLessThan(60);
      });
    });

    describe('quartz', () => {
      it('switches mode, restarts and refuses restart in mechanical mode', async () => {
        if (!(await req('hello')).caps.quartz) return;
        const e = await errorOf(req('quartzRestart'));
        expect(e.code).toBe('badRequest');
        const m0 = (await req('getQuartz')).measurementId;
        await req('patchState', { patch: { quartz: { mode: 'motor', gateS: 60 } } });
        const q = await req('getQuartz');
        expect(q.mode).toBe('motor');
        expect(q.measurementId).not.toBe(m0);
        expect(q.motor).not.toBeNull();
        expect(q.lcd).toBeNull();
        const r = await req('quartzRestart');
        expect(r.measurementId).not.toBe(q.measurementId);
      });

      it('measures a motor watch with inhibition correction', async () => {
        const exp = h.expected;
        if (!exp?.motorWithSDay || !h.attach) return;
        h.attach('motor');
        await req('setTimebase', { ppm: exp.calPpm });
        await req('patchState', { patch: { quartz: { mode: 'motor', gateS: 0 } } });
        await req('subscribe', { quartzPulses: true });
        await req('start');
        notifies.length = 0;
        await h.advance(130_000);
        const q = await req('getQuartz');
        expect(q.state).toBe('done');
        expect(q.motor?.inhibition).toBe('corrected');
        expect(Math.abs(q.rateSDay - exp.motorWithSDay)).toBeLessThan(0.1);
        expect(q.motor?.inhibitionPeriodS).toBeGreaterThan(55);
        const pulses = (await req('getQuartzPulses')).pulses;
        expect(pulses.length).toBe(8);
        for (let i = 1; i < pulses.length; i++) {
          const a = pulses[i - 1];
          const b = pulses[i];
          expect(b?.sequence).toBe((a?.sequence ?? 0) - 1);
          expect(b?.polarity).toBe(-(a?.polarity ?? 0));
        }
        const pushed = notifies.filter((x) => x.op === 'quartzPulse');
        expect(pushed.length).toBeGreaterThan(60);
      });

      it('keeps the mechanical path out of quartz modes', async () => {
        if (!(await req('hello')).caps.quartz) return;
        await req('patchState', { patch: { quartz: { mode: 'fork' } } });
        const q = await req('getQuartz');
        expect(q.fork?.fNomHz).toBe(360);
        expect(q.motor).toBeNull();
      });
    });

    describe('timebase', () => {
      it('sets, saves and clears', async () => {
        const a = await req('setTimebase', { ppm: 12.5, source: 'ntp', durationS: 600 });
        expect(a.calPpm).toBe(12.5);
        expect(a.calSource).toBe('ntp');
        expect(a.saved).toBe(false);
        const b = await req('saveTimebase');
        expect(b.saved).toBe(true);
        const c = await req('clearTimebase');
        expect(c.calPpm).toBe(0);
        expect(c.calSource).toBe('none');
        expect(c.saved).toBe(false);
      });

      it('validates inputs', async () => {
        expect((await errorOf(req('setTimebase', { ppm: 5000 }))).message).toBe(
          'ppm must be -1000..1000',
        );
        expect((await errorOf(req('setTimebase', {}))).code).toBe('badRequest');
        expect(
          (await errorOf(req('setTimebase', { ppm: 1, source: 'gps' as 'ntp' }))).message,
        ).toBe('source must be none, manual or ntp');
        expect((await errorOf(req('setTimebase', { ppm: 1, logDeltaPpm: 50 }))).message).toBe(
          'logDeltaPpm must be 0.05..10',
        );
      });

      it('changes only the log threshold when ppm is absent', async () => {
        await req('setTimebase', { ppm: 3 });
        const r = await req('setTimebase', { logDeltaPpm: 0.5 });
        expect(r.logDeltaPpm).toBe(0.5);
        expect(r.calPpm).toBe(3);
      });

      it('replies busy to save and applies nothing while streaming', async () => {
        if (!h.setUsbStreaming) return;
        h.setUsbStreaming(true);
        const e = await errorOf(req('saveTimebase'));
        expect(e.code).toBe('busy');
        expect(e.message).toBe('close the audio stream before saving');
        // RAM-only ppm is fine while streaming; only a changed logDeltaPpm needs flash.
        expect((await req('setTimebase', { ppm: 9 })).calPpm).toBe(9);
        const cur = (await req('getTimebase')).logDeltaPpm;
        const e2 = await errorOf(req('setTimebase', { ppm: 4, logDeltaPpm: cur + 1 }));
        expect(e2.code).toBe('busy');
        expect((await req('getTimebase')).calPpm).toBe(9);
      });

      it('getTime is monotonic and runs at the crystal rate', async () => {
        const a = await req('getTime');
        await h.advance(1000);
        const b = await req('getTime');
        await h.advance(1000);
        const c = await req('getTime');
        expect(b.tUs).toBeGreaterThan(a.tUs);
        expect(c.tUs).toBeGreaterThan(b.tUs);
        expect(c.uptimeMs).toBeGreaterThan(b.uptimeMs);
        if (h.expected) {
          const ratio = (c.tUs - b.tUs) / ((c.uptimeMs - b.uptimeMs) * 1000);
          expect(Math.abs((ratio - 1) * 1e6 - h.expected.calPpm)).toBeLessThan(2500);
        }
      });
    });

    describe('timebase log', () => {
      it('logs saves and pages by encoded size (about 18-21 entries)', async () => {
        for (let i = 0; i < 20; i++) {
          await req('setTimebase', { ppm: i + 1, source: 'ntp', durationS: 60 });
          await req('saveTimebase');
        }
        const p0 = await logReq();
        expect(p0.total).toBe(20);
        expect(p0.offset).toBe(0);
        expect(p0.entries.length).toBeGreaterThanOrEqual(18);
        expect(p0.entries[0]).toMatchObject({ reason: 'save', source: 'ntp', ppm: 1 });
        const p1 = await logReq(p0.entries.length);
        expect([...p0.entries, ...p1.entries].map((e) => e.ppm)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
        const far = await logReq(500);
        expect(far.entries).toEqual([]);
        expect(far.offset).toBe(20);
        const cleared = await req('clearTimebaseLog');
        expect(cleared.total).toBe(0);
        expect(cleared.offset).toBe(0);
      });

      it('caps the ring at 24 entries, dropping the oldest', async () => {
        for (let i = 0; i < 26; i++) {
          await req('setTimebase', { ppm: i + 1, source: 'ntp' });
          await req('saveTimebase');
        }
        const p = await logReq(18);
        expect(p.total).toBe(24);
        expect(p.entries.at(-1)?.ppm).toBe(26);
        expect((await logReq(0)).entries[0]?.ppm).toBe(3);
      });

      it('appends PPS entries by policy when time is accelerated', async () => {
        if (!h.accelerate) return;
        if (!(await req('hello')).caps.pps) return;
        h.accelerate(5000);
        for (let i = 0; i < 40; i++) {
          await h.advance(1000);
          await req('getTimebase');
        }
        const p = await logReq();
        const pps = p.entries.filter((e) => e.source === 'pps');
        expect(pps.length).toBeGreaterThanOrEqual(1);
        expect(pps[0]?.reason).toBe('delta');
        for (let i = 1; i < pps.length; i++) {
          expect((pps[i]?.dateUnix ?? 0) - (pps[i - 1]?.dateUnix ?? 0)).toBeGreaterThanOrEqual(
            86400,
          );
        }
        const tb = await req('getTimebase');
        expect(tb.pps.locked).toBe(true);
      });
    });

    describe('gps', () => {
      it('acquires a fix and lists compact satellites', async () => {
        const caps = (await req('hello')).caps;
        if (caps.gps !== true) {
          const e = await errorOf(req('getGps'));
          expect(e.code).toBe('badRequest');
          expect(e.message).toBe('GPS not built in');
          return;
        }
        await h.advance(40_000);
        const g = await req('getGps');
        expect(g.satCols).toEqual(['sys', 'prn', 'el', 'az', 'snr', 'used']);
        expect(g.sats.length).toBeGreaterThanOrEqual(8);
        expect(g.sats.length).toBeLessThanOrEqual(32);
        for (const s of g.sats) {
          expect(['GP', 'GL', 'GA', 'BD', 'QZ', '??']).toContain(s[0]);
          expect([0, 1]).toContain(s[5]);
        }
        if (h.expected) {
          expect(g.fix).toBe(true);
          expect(g.posValid).toBe(true);
          expect(g.satsUsed).toBeGreaterThanOrEqual(4);
          expect(g.sats.filter((s) => s[5] === 1)).toHaveLength(g.satsUsed);
        }
      });
    });
  });
}
