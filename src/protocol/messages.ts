/**
 * Runtime narrowing of inbound JSON (`unknown`) to the typed protocol
 * envelopes (§4). The device is trusted for payload shapes, but the envelope
 * itself is validated so a malformed message can never crash the dispatcher.
 */
import type { HidErrorBody, HidErrorCode, HidNotify, HidResponse } from './types';

const ERROR_CODES: readonly string[] = [
  'unknownOp',
  'badRequest',
  'badParam',
  'notFound',
  'tooLarge',
  'busy',
  'flashError',
  'internal',
] satisfies HidErrorCode[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrows to a notification (`notify: true`, string `op`, `data` present).
 * @param v Parsed JSON.
 */
export function isNotify(v: unknown): v is HidNotify {
  return isRecord(v) && v.notify === true && typeof v.op === 'string' && 'data' in v;
}

/**
 * Narrows to a success/error response carrying a numeric `id`.
 * @param v Parsed JSON.
 */
export function isResponse(v: unknown): v is HidResponse {
  if (!isRecord(v) || typeof v.id !== 'number' || v.notify === true) return false;
  if (v.ok === true) return true;
  return v.ok === false && isRecord(v.error) && typeof v.error.message === 'string';
}

/**
 * Normalises an error body: unknown codes fall back to `internal`.
 * @param body The `error` object of an error response.
 */
export function normaliseErrorBody(body: HidErrorBody): HidErrorBody {
  return ERROR_CODES.includes(body.code) ? body : { code: 'internal', message: body.message };
}
