/**
 * Virtual (simulated) device entry point.
 *
 * The connection store imports {@link createVirtualTransport} from this module.
 * The UI's Simulator panel uses {@link getSimulatorControl}.
 */
import type { Transport } from '@/transport/Transport';
import { VirtualTransport, type VirtualTransportOptions } from './VirtualTransport';

export { clearPersistedSettings, getSimulatorControl } from './scenarios';
export type {
  BuildOptions,
  PresetId,
  PresetInfo,
  SimulatorControl,
  SimulatorSettings,
  SimulatorSnapshot,
} from './scenarios';
export { VirtualDevice } from './VirtualDevice';
export type { FaultState, VirtualDeviceOptions } from './VirtualDevice';
export { VirtualTransport } from './VirtualTransport';
export type { Scheduler, VirtualTransportOptions } from './VirtualTransport';
export { ManualClock, performanceClock } from './clock';
export type { Clock } from './clock';
export { createRng } from './rng';
export type { Rng } from './rng';

/**
 * Creates a {@link Transport} backed by a software simulation of the device
 * (same protocol surface, no hardware). The new device becomes the active
 * simulator (see {@link getSimulatorControl}); physical settings from the
 * previous virtual session are reused.
 * @param options Optional overrides (tests, alternative setups).
 * @returns The transport (not yet open).
 */
export function createVirtualTransport(options?: VirtualTransportOptions): Transport {
  return new VirtualTransport(options);
}
