/**
 * Quartz modes end to end on the virtual device: selecting a quartz mode from
 * the app (patchState) must produce a measurement without a trip to the
 * Simulator panel, because the simulated stand swaps the watch to match
 * (`autoAttach`, on by default). With auto-attach off, a mismatched watch must
 * stay silent, like a real stand with the wrong watch on it.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';
import { VirtualDevice } from './VirtualDevice';

type QuartzMode = 'motor' | 'lcd' | 'fork';

/**
 * Runs `seconds` of signal in 250 ms steps (the transport's real cadence).
 * @param d Device under test.
 * @param clock Its manual clock.
 * @param seconds Signal seconds to run.
 */
function run(d: VirtualDevice, clock: ManualClock, seconds: number): void {
  for (let i = 0; i < seconds * 4; i++) {
    clock.advance(250);
    d.advance();
  }
}

/**
 * Builds a running device with `mode` selected through the protocol.
 * @param mode Quartz mode to select.
 * @param autoAttach Simulator option under test.
 */
function setup(mode: QuartzMode, autoAttach?: boolean): { d: VirtualDevice; clock: ManualClock } {
  const clock = new ManualClock(1000);
  const d = new VirtualDevice({ clock: clock.now, seed: 7, autoAttach });
  d.handle('start', {});
  d.handle('patchState', { patch: { quartz: { mode } } });
  return { d, clock };
}

describe('quartz modes on the virtual device', () => {
  it('motor: pulses arrive and a rate appears after selecting the mode', () => {
    const { d, clock } = setup('motor');
    expect(d.attached).toBe('motor');
    run(d, clock, 20);
    expect(d.handle('getQuartzPulses', { max: 8 }).pulses.length).toBeGreaterThan(0);
    const q = d.handle('getQuartz', {});
    expect(q.mode).toBe('motor');
    expect(q.motor?.valid).toBe(true);
  });

  it.each(['lcd', 'fork'] as const)('%s: a rate appears after selecting the mode', (mode) => {
    const { d, clock } = setup(mode);
    expect(d.attached).toBe(mode);
    run(d, clock, 20);
    const q = d.handle('getQuartz', {});
    expect(q.mode).toBe(mode);
    expect(q[mode]?.valid).toBe(true);
  });

  it('switching back to mechanical puts the mechanical watch back', () => {
    const { d } = setup('lcd');
    d.handle('patchState', { patch: { quartz: { mode: 'mechanical' } } });
    expect(d.attached).toBe('mechanical');
  });

  it('with autoAttach off a mismatched watch stays silent (wrong-watch scenario)', () => {
    const { d, clock } = setup('motor', false);
    expect(d.attached).toBe('mechanical');
    run(d, clock, 20);
    expect(d.handle('getQuartzPulses', { max: 8 }).pulses).toHaveLength(0);
    expect(d.handle('getQuartz', {}).motor?.valid).toBe(false);
  });
});
