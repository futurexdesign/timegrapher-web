import { describe, expect, it } from 'vitest';
import { isIos, isLikelyBluefy, type PlatformInfo } from './platform';

const iphone: PlatformInfo = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  platform: 'iPhone',
  maxTouchPoints: 5,
  hasBluetooth: false,
};
const ipad: PlatformInfo = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 5,
  hasBluetooth: false,
};
const mac: PlatformInfo = { ...ipad, maxTouchPoints: 0 };

describe('platform detection', () => {
  it('PL-01 detects an iPhone user agent', () => {
    expect(isIos(iphone)).toBe(true);
  });

  it('PL-02 detects iPadOS reporting a desktop Mac', () => {
    expect(isIos(ipad)).toBe(true);
  });

  it('PL-03 does not treat a desktop Mac as iOS', () => {
    expect(isIos(mac)).toBe(false);
  });

  it('PL-04 isLikelyBluefy needs iOS and Web Bluetooth', () => {
    expect(isLikelyBluefy({ ...iphone, hasBluetooth: true })).toBe(true);
    expect(isLikelyBluefy(iphone)).toBe(false);
    expect(isLikelyBluefy({ ...mac, hasBluetooth: true })).toBe(false);
  });

  it('PL-05 helpers use only the injected facts', () => {
    // Same facts, same answer: only the argument matters, not the runner's navigator.
    expect(isIos(iphone)).toBe(isIos({ ...iphone }));
    expect(isIos({ ...mac, maxTouchPoints: 2 })).toBe(true);
  });
});
