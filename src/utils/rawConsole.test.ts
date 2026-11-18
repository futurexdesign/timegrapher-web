import { describe, expect, it } from 'vitest';
import { RAW_OPS, formatResponse, parseRequestBody } from './rawConsole';

describe('parseRequestBody', () => {
  it('treats empty text as no body', () => {
    expect(parseRequestBody('  \n')).toEqual({ ok: true, body: undefined });
  });
  it('parses an object', () => {
    expect(parseRequestBody('{"mode":"usbMic"}')).toEqual({ ok: true, body: { mode: 'usbMic' } });
  });
  it('rejects malformed JSON', () => {
    const r = parseRequestBody('{"a":');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Invalid JSON');
  });
  it('rejects arrays, scalars and null', () => {
    for (const t of ['[1]', '5', '"x"', 'null']) expect(parseRequestBody(t).ok).toBe(false);
  });
});

describe('formatResponse', () => {
  it('pretty prints', () => {
    expect(formatResponse({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it('handles undefined', () => {
    expect(formatResponse(undefined)).toBe('undefined');
  });
});

describe('RAW_OPS', () => {
  it('has unique entries including hello', () => {
    expect(new Set(RAW_OPS).size).toBe(RAW_OPS.length);
    expect(RAW_OPS).toContain('hello');
    expect(RAW_OPS).not.toContain('subscribe');
  });
});
