/**
 * Helpers for the developer raw request console on the Settings view:
 * the list of ops it can send, JSON body validation and response formatting.
 */
import type { OpName } from '@/protocol/types';

/**
 * Ops offered by the raw console (typed request ops). `subscribe` is left out
 * on purpose: the device holds ONE subscription, so a raw `subscribe` would
 * overwrite the merged claims of the subscriptions store. Kept as a typed list
 * so a protocol change that removes an op fails the type check.
 */
export const RAW_OPS: readonly OpName[] = [
  'hello',
  'ping',
  'getState',
  'patchState',
  'getMetrics',
  'getTiming',
  'resetTiming',
  'getBeat',
  'getSpectrum',
  'getMatched',
  'getEvents',
  'getErrors',
  'clearErrors',
  'getTime',
  'getTimebase',
  'setTimebase',
  'saveTimebase',
  'clearTimebase',
  'getQuartz',
  'getQuartzPulses',
  'quartzRestart',
  'getDevice',
  'setDevice',
  'start',
  'stop',
  'getBeats',
  'getGps',
  'getTimebaseLog',
  'clearTimebaseLog',
];

/** Outcome of {@link parseRequestBody}. */
export type BodyParseResult =
  { ok: true; body: Record<string, unknown> | undefined } | { ok: false; error: string };

/**
 * Validates the JSON text of a request body. Empty / whitespace text means
 * "no body". Anything else must be a JSON object (not an array or scalar).
 * @param text Raw textarea content.
 * @returns The parsed body, or a human-readable error.
 */
export function parseRequestBody(text: string): BodyParseResult {
  const t = text.trim();
  if (t === '') return { ok: true, body: undefined };
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Body must be a JSON object (e.g. {"mode":"usbMic"})' };
  }
  return { ok: true, body: value as Record<string, unknown> };
}

/**
 * Pretty-prints a response or error payload for the console.
 * @param value Any JSON-serialisable value.
 */
export function formatResponse(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
}
