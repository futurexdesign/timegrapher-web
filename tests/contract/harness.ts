/**
 * Harness abstraction for the transport contract suite.
 *
 * The suite talks to a device only through {@link Transport}; everything that
 * differs between the simulator and real hardware (how time passes, how a
 * test watch is placed on the stand) lives behind {@link ContractHarness}.
 * A hardware harness would implement `advance` as a real sleep and leave the
 * optional hooks undefined; tests needing them are skipped.
 */
import type { Transport } from '@/transport/Transport';

/** Values the harness guarantees for the signal it presents (tolerance checks are skipped without them). */
export interface ExpectedSignal {
  /** Rate the device should report for the mechanical watch once the timebase is set to `calPpm` (s/d). */
  rateSDay: number;
  /** Beat error (ms). */
  beatErrorMs: number;
  /** The ppm to put into `setTimebase` so that the reported rate equals `rateSDay`. */
  calPpm: number;
  /** Nominal half period (µs) of the mechanical watch. */
  nominalUs: number;
  /** Calibrated motor rate with inhibition correction (s/d), when the harness can attach a motor watch. */
  motorWithSDay?: number;
}

/** Adapter between the contract suite and one device implementation. */
export interface ContractHarness {
  /** Human-readable name for the test titles. */
  readonly name: string;
  /** Builds and opens a fresh transport to a fresh device. */
  create(): Promise<Transport>;
  /**
   * Awaits a request while letting (fake or real) time pass until it settles.
   * @param p The in-flight request.
   */
  run<T>(p: Promise<T>): Promise<T>;
  /**
   * Lets `ms` of (fake or real) time pass, running timers and notifies.
   * @param ms Milliseconds.
   */
  advance(ms: number): Promise<void>;
  /** Releases the transport and any timer patches. */
  dispose(): Promise<void>;
  /** Signal the harness presents, when known. */
  readonly expected?: ExpectedSignal;
  /** Puts a watch kind on the stand. */
  attach?(kind: 'mechanical' | 'motor' | 'lcd' | 'fork'): void;
  /** Opens / closes the USB audio stream from the "host" side. */
  setUsbStreaming?(on: boolean): void;
  /** Sets time acceleration (simulated seconds per real second). */
  accelerate?(x: number): void;
  /** Makes the next flash operation fail with `busy`. */
  setFlashBusy?(on: boolean): void;
}
