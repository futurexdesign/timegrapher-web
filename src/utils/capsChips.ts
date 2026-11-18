/**
 * Turns `hello.caps` into a readable chip list for the device info section.
 */
import type { HidHelloCaps } from '@/protocol/types';

/** One chip: a label and whether the capability is present. */
export interface CapChip {
  /** Display text. */
  label: string;
  /** Capability present (false = shown muted). */
  on: boolean;
}

/**
 * Builds the chip list: feature flags (on / off) followed by limits.
 * @param caps `hello.caps`.
 */
export function capChips(caps: HidHelloCaps): CapChip[] {
  const flags: [string, boolean][] = [
    ['Timing stats', caps.timing],
    ['Quartz engine', caps.quartz],
    ['Beats', caps.beats === true],
    ['Device mode', caps.deviceMode === true],
    ['GPS', caps.gps === true],
    ['PPS', caps.pps === true],
    ['Timebase log', caps.timebaseLog === true],
    ['Pipeline graph', (caps.pipeline?.length ?? 0) > 0],
  ];
  const chips: CapChip[] = flags.map(([label, on]) => ({ label, on }));
  chips.push(
    { label: `${caps.blocks.length} DSP blocks`, on: true },
    { label: `max JSON ${caps.maxJsonBytes} B`, on: true },
    { label: `metrics ≤ ${caps.metricsHzMax} Hz`, on: true },
    { label: `beats ≤ ${caps.beatHzMax} Hz`, on: true },
    { label: `timing ≤ ${caps.timingHzMax} Hz`, on: true },
  );
  if (caps.quartz) chips.push({ label: `quartz ≤ ${caps.quartzHzMax} Hz`, on: true });
  return chips;
}
