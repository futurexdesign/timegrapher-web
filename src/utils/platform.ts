/**
 * Platform detection used only to adapt connect guidance (BLE_TRANSPORT_PLAN.md
 * §6.4). The helpers are pure: callers pass a {@link PlatformInfo} (from
 * {@link readPlatform} in the app, literals in tests). Nothing here may block a
 * user; a wrong guess only changes which hint is shown.
 */

/** The browser facts the helpers need. */
export interface PlatformInfo {
  /** `navigator.userAgent`. */
  readonly userAgent: string;
  /** `navigator.platform` (iPadOS reports `MacIntel`). */
  readonly platform: string;
  /** `navigator.maxTouchPoints` (0 on a desktop Mac, above 1 on an iPad). */
  readonly maxTouchPoints: number;
  /** `'bluetooth' in navigator` (Web Bluetooth is exposed). */
  readonly hasBluetooth: boolean;
}

/**
 * Reads {@link PlatformInfo} from the global `navigator`.
 * @returns The current facts; empty values when there is no `navigator`.
 */
export function readPlatform(): PlatformInfo {
  if (typeof navigator === 'undefined') {
    return { userAgent: '', platform: '', maxTouchPoints: 0, hasBluetooth: false };
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    hasBluetooth: 'bluetooth' in navigator,
  };
}

/**
 * Whether the device runs iOS or iPadOS. iPadOS 13+ sends a desktop Mac user
 * agent, so a Mac platform with more than one touch point counts as an iPad.
 * @param p Browser facts.
 * @returns `true` for iPhone, iPod and iPad.
 */
export function isIos(p: PlatformInfo): boolean {
  if (/iPhone|iPad|iPod/.test(p.userAgent)) return true;
  return p.platform === 'MacIntel' && p.maxTouchPoints > 1;
}

/**
 * Whether the browser is probably Bluefy or another iOS browser with Web
 * Bluetooth. Safari and Chrome on iOS do not expose `navigator.bluetooth`, so
 * its presence on iOS is the signal; no user agent name is matched.
 * @param p Browser facts.
 * @returns `true` on iOS with Web Bluetooth.
 */
export function isLikelyBluefy(p: PlatformInfo): boolean {
  return isIos(p) && p.hasBluetooth;
}
