/**
 * Catalogue of the boards the virtual device can imitate. Each entry matches
 * one firmware build: the `board` string in `hello` and whether the build has
 * BLE (`hello.caps.ble`, `getLink.ble`). The picker lists
 * {@link VIRTUAL_VARIANTS}; {@link createVirtualTransport} applies a variant's
 * options beneath any explicit ones.
 */
import type { VirtualDeviceOptions } from './VirtualDevice';

/** Identifier of a virtual board variant (one per firmware environment). */
export type VirtualVariantId = 'pico2-pcm1808' | 'pico2w-pcm1808';

/** One selectable virtual board. */
export interface VirtualVariant {
  /** Stable identifier; stored by the picker. */
  readonly id: VirtualVariantId;
  /** Name shown in the picker. */
  readonly label: string;
  /** Short capability summary shown beside the name. */
  readonly description: string;
  /** Device options that make the simulation match this build. */
  readonly options: Pick<VirtualDeviceOptions, 'board' | 'ble'>;
}

/** All variants, in picker order. */
export const VIRTUAL_VARIANTS: readonly VirtualVariant[] = [
  {
    id: 'pico2-pcm1808',
    label: 'Pico 2 · PCM1808',
    description: 'USB only',
    options: { board: 'Pico2', ble: false },
  },
  {
    id: 'pico2w-pcm1808',
    label: 'Pico 2 W · PCM1808',
    description: 'USB + Bluetooth',
    options: { board: 'Pico2W', ble: true },
  },
];

/** Variant used when none is chosen; the BLE-less board the simulator always modelled. */
export const DEFAULT_VIRTUAL_VARIANT: VirtualVariantId = 'pico2-pcm1808';
