/**
 * Virtual (simulated) device entry point.
 *
 * The connection store imports {@link createVirtualTransport} from this module.
 * The UI's Simulator panel uses {@link getSimulatorControl}.
 */
import type { Transport } from '@/transport/Transport';
import { VirtualTransport, type VirtualTransportOptions } from './VirtualTransport';
import { VIRTUAL_VARIANTS, type VirtualVariantId } from './variants';

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
export { DEFAULT_VIRTUAL_VARIANT, VIRTUAL_VARIANTS } from './variants';
export type { VirtualVariant, VirtualVariantId } from './variants';
export { createRng } from './rng';
export type { Rng } from './rng';

/**
 * Creates a {@link Transport} backed by a software simulation of the device
 * (same protocol surface, no hardware). The new device becomes the active
 * simulator (see {@link getSimulatorControl}); physical settings from the
 * previous virtual session are reused.
 * @param options Optional overrides (tests, alternative setups). `variant`
 *   names a board to imitate; its options sit beneath the explicit ones, so an
 *   explicit `board` or `ble` wins. Omitted = the plain device defaults.
 * @returns The transport (not yet open).
 */
export function createVirtualTransport(
  options?: VirtualTransportOptions & { variant?: VirtualVariantId },
): Transport {
  const { variant, ...rest } = options ?? {};
  const chosen = VIRTUAL_VARIANTS.find((v) => v.id === variant);
  return new VirtualTransport({ ...chosen?.options, ...rest });
}
