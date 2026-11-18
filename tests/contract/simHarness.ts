/**
 * Simulator implementation of {@link ContractHarness}: fake timers drive the
 * virtual transport, the physical model is pinned to known, noise-light values.
 */
import { vi } from 'vitest';
import { clearPersistedSettings, getSimulatorControl } from '@/sim';
import { createVirtualTransport } from '@/sim';
import type { Transport } from '@/transport/Transport';
import type { ContractHarness, ExpectedSignal } from './harness';

/** Known signal of the simulator harness. */
export const SIM_EXPECTED: ExpectedSignal = {
  rateSDay: 7,
  beatErrorMs: 1.2,
  calPpm: 5,
  nominalUs: 125000,
  motorWithSDay: 0.9 - (488.28e-6 / 60) * 86400,
};

/** @returns A harness running the simulator under fake timers. */
export function createSimHarness(): ContractHarness {
  let transport: Transport | null = null;
  const h: ContractHarness = {
    name: 'simulator',
    expected: SIM_EXPECTED,
    async create() {
      clearPersistedSettings();
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'performance',
          'Date',
        ],
      });
      transport = createVirtualTransport({
        seed: 42,
        latencyMs: 2,
        ignorePersisted: true,
        mechanical: {
          vph: 28800,
          rateSDay: SIM_EXPECTED.rateSDay,
          beatErrorMs: SIM_EXPECTED.beatErrorMs,
          jitterUs: 20,
          rateWanderSDay: 0,
          amplitudeJitterDeg: 2,
        },
        timebase: { crystalPpm: SIM_EXPECTED.calPpm, driftPpm: 0, walkPpmPerSqrtS: 0 },
        gpsParams: { fixAfterS: 20 },
        signalScaleMax: 50,
      });
      await h.run(transport.open());
      return transport;
    },
    async run<T>(p: Promise<T>): Promise<T> {
      const flag = { settled: false };
      const wrapped = p.finally(() => {
        flag.settled = true;
      });
      wrapped.catch(() => undefined);
      for (let i = 0; i < 200 && !flag.settled; i++) await vi.advanceTimersByTimeAsync(5);
      return p;
    },
    async advance(ms) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    async dispose() {
      await transport?.close();
      transport = null;
      vi.useRealTimers();
    },
    attach(kind) {
      getSimulatorControl()?.setAttached(kind);
    },
    setUsbStreaming(on) {
      getSimulatorControl()?.setUsbStreaming(on);
    },
    accelerate(x) {
      getSimulatorControl()?.setTimeScale(x);
    },
    setFlashBusy(on) {
      getSimulatorControl()?.setFaults({ flashBusy: on });
    },
  };
  return h;
}
