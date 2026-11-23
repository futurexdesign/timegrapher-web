/**
 * Connection store: owns the active {@link Transport}, the connection status,
 * the `hello` identity/caps and the feature flags derived from the caps.
 *
 * Views never construct transports; they call `connect(kind)` and use
 * `requireTransport()` to issue requests.
 */
import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type {
  HidHelloCaps,
  HidHelloResult,
  HidLinkKind,
  OpName,
  RequestOf,
  ResultOf,
} from '@/protocol/types';
import { createVirtualTransport, type VirtualVariantId } from '@/sim'; // FACTORY HOOK: virtual device
import { DeviceError, type Transport, type TransportKind } from '@/transport/Transport';
import { WebBleTransport, isWebBleAvailable, isWebBleSupported } from '@/transport/WebBleTransport';
import { WebHidTransport, isWebHidSupported } from '@/transport/WebHidTransport';
import { BEATS_PACKED_FORMAT, HID_PROTOCOL_VERSION } from '@/protocol/constants';
import { useSnackbarStore } from './snackbar';

/**
 * Connection lifecycle. `needsTakeover` is the pause between `hello` and
 * `connected` while the user decides whether to take control from another host
 * (§6.3a); no request other than the `claim` has been sent in that state.
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'needsTakeover' | 'connected';

/** Why the takeover dialog is open. */
export type TakeoverPhase = 'connect' | 'busy';

/** State behind the takeover dialog (§6.3a). */
export interface TakeoverRequest {
  /** Link that holds control, or `null` when it is unknown. */
  readonly owner: HidLinkKind | null;
  /** `connect`: found busy after `hello`; `busy`: a later request failed `linkBusy`. */
  readonly phase: TakeoverPhase;
}

/**
 * User-facing name of a control link.
 * @param kind Link kind from the protocol.
 * @returns `USB` or `Bluetooth`.
 */
export function linkKindLabel(kind: HidLinkKind): string {
  return kind === 'ble' ? 'Bluetooth' : 'USB';
}

/** Reason prefix {@link FramedTransport} reports for a `controlReleased` notify. */
const TAKEOVER_REASON = /^Control taken over by (usbHid|ble)$/;

/**
 * Extracts the owner from a `linkBusy` message (`"control held by usbHid"`).
 * @param message Device error message.
 * @returns The owner, or `null` when the text does not name one.
 */
function ownerFromBusy(message: string): HidLinkKind | null {
  const m = /held by (usbHid|ble)/.exec(message);
  return m?.[1] === 'ble' ? 'ble' : m?.[1] === 'usbHid' ? 'usbHid' : null;
}

/** Per-connect choices that only some transport kinds use. */
export interface ConnectOptions {
  /** Board the `virtual` transport imitates (default: the Pico 2 without BLE). */
  virtualVariant?: VirtualVariantId;
}

/** Builds a transport for a kind. Overridable for tests. */
export type TransportFactory = (kind: TransportKind, opts?: ConnectOptions) => Transport;

/**
 * Default factory.
 * FACTORY HOOK: add/replace transport kinds here. The 'virtual' branch calls
 * `createVirtualTransport` from `src/sim/index.ts`.
 * @param kind Transport kind to build.
 * @param opts Per-connect choices; `virtualVariant` applies to `virtual` only.
 */
export const defaultTransportFactory: TransportFactory = (kind, opts) => {
  switch (kind) {
    case 'webhid':
      return new WebHidTransport();
    case 'webble':
      return new WebBleTransport();
    case 'virtual':
      return createVirtualTransport({ variant: opts?.virtualVariant });
  }
};

/** Feature flags derived from `hello.caps` (absent caps key = feature absent). */
export interface FeatureFlags {
  quartz: boolean;
  beats: boolean;
  /** Packed beat notifies exist (`caps.beatsPacked`, BLE_TRANSPORT_PLAN.md §14.2). */
  beatsPacked: boolean;
  deviceMode: boolean;
  gps: boolean;
  pps: boolean;
  timebaseLog: boolean;
  timing: boolean;
  pipeline: boolean;
}

const NO_FEATURES: FeatureFlags = {
  quartz: false,
  beats: false,
  beatsPacked: false,
  deviceMode: false,
  gps: false,
  pps: false,
  timebaseLog: false,
  timing: false,
  pipeline: false,
};

/**
 * Derives {@link FeatureFlags} from caps.
 * @param caps `hello.caps`, or `null` when not connected.
 */
export function deriveFeatures(caps: HidHelloCaps | null): FeatureFlags {
  if (caps === null) return NO_FEATURES;
  return {
    quartz: caps.quartz,
    beats: caps.beats === true,
    beatsPacked: (caps.beatsPacked ?? 0) >= BEATS_PACKED_FORMAT,
    deviceMode: caps.deviceMode === true,
    gps: caps.gps === true,
    pps: caps.pps === true,
    timebaseLog: caps.timebaseLog === true,
    timing: caps.timing,
    pipeline: (caps.pipeline?.length ?? 0) > 0,
  };
}

/** Pinia store for the device connection. */
export const useConnectionStore = defineStore('connection', () => {
  const snackbar = useSnackbarStore();

  /** Factory used by `connect`; replace via {@link setTransportFactory}. */
  let factory: TransportFactory = defaultTransportFactory;

  const status = ref<ConnectionStatus>('disconnected');
  const kind = ref<TransportKind | null>(null);
  const transport = shallowRef<Transport | null>(null);
  const hello = ref<HidHelloResult | null>(null);
  const lastError = ref<string | null>(null);
  /** Non-null while the takeover dialog is open. */
  const takeoverRequest = ref<TakeoverRequest | null>(null);
  /**
   * Bumped after a successful takeover while connected. The device reset its
   * handler when the other host took control, so dependants (subscriptions)
   * watch this to re-apply their state.
   */
  const ownershipEpoch = ref(0);
  /** `true` when Web Bluetooth exists and reports a usable radio. */
  const webBleAvailable = ref(false);
  let offDisconnect: (() => void) | null = null;
  let offNotify: (() => void) | null = null;

  const caps = computed(() => hello.value?.caps ?? null);
  const features = computed(() => deriveFeatures(caps.value));
  const isConnected = computed(() => status.value === 'connected');
  const webHidAvailable = computed(() => isWebHidSupported());
  /** Short description such as "Pico2 · fw 0.1.0-dev", with " · BLE" over Bluetooth. */
  const deviceLabel = computed(() => {
    if (!hello.value) return '';
    const base = `${hello.value.board} · fw ${hello.value.fwVersion}`;
    return kind.value === 'webble' ? `${base} · BLE` : base;
  });

  /** Queries the radio and follows `availabilitychanged` for the store's lifetime. */
  function trackBleAvailability(): void {
    if (!isWebBleSupported()) return;
    const refresh = (): void => {
      void isWebBleAvailable().then((ok) => {
        webBleAvailable.value = ok;
      });
    };
    refresh();
    navigator.bluetooth.addEventListener('availabilitychanged', refresh);
  }
  trackBleAvailability();

  /**
   * Replaces the transport factory (tests, alternative backends).
   * @param f New factory.
   */
  function setTransportFactory(f: TransportFactory): void {
    factory = f;
  }

  /**
   * Opens the takeover dialog after a `linkBusy` reply (ownership changed
   * under a connected app). Ignored while a dialog is already open.
   * @param message The `linkBusy` error message.
   */
  function promptTakeover(message: string): void {
    if (status.value !== 'connected' || takeoverRequest.value !== null) return;
    takeoverRequest.value = { owner: ownerFromBusy(message), phase: 'busy' };
  }

  /** Guards by transport so a stale wrapper cannot reach a newer connection. */
  const guarded = new WeakMap<Transport, Transport>();

  /**
   * Wraps `t` so a `linkBusy` reply from any store opens the takeover dialog
   * (§6.3a), then still rejects to the caller.
   * @param t The live transport.
   */
  function guard(t: Transport): Transport {
    const existing = guarded.get(t);
    if (existing) return existing;
    const g: Transport = {
      get kind() {
        return t.kind;
      },
      open: () => t.open(),
      close: () => t.close(),
      onNotify: (cb) => t.onNotify(cb),
      onDisconnect: (cb) => t.onDisconnect(cb),
      // Rest args keep the call shape the caller used (omitted stays omitted).
      async request<O extends OpName>(
        ...args: [op: O, body?: RequestOf<O>, timeoutMs?: number]
      ): Promise<ResultOf<O>> {
        try {
          return await t.request(...args);
        } catch (e) {
          if (e instanceof DeviceError && e.code === 'linkBusy' && transport.value === t) {
            promptTakeover(e.message);
          }
          throw e;
        }
      },
    };
    guarded.set(t, g);
    return g;
  }

  /**
   * Returns the live transport. Requests made through it open the takeover
   * dialog when the device answers `linkBusy`.
   * @throws {DeviceError} `notOpen` when not connected.
   */
  function requireTransport(): Transport {
    const t = transport.value;
    if (t === null || status.value !== 'connected') {
      throw new DeviceError('notOpen', 'No device connected');
    }
    return guard(t);
  }

  /** Drops the transport, hello and listeners and returns to `disconnected`. */
  function reset(): void {
    offDisconnect?.();
    offDisconnect = null;
    offNotify?.();
    offNotify = null;
    takeoverRequest.value = null;
    transport.value = null;
    hello.value = null;
    kind.value = null;
    status.value = 'disconnected';
  }

  /**
   * Connects: builds the transport, opens it, then issues `hello`.
   * Failures are reported via the snackbar (user-cancelled choosers are quiet).
   * @param k Which kind of device to connect to.
   * @param opts Per-connect choices, such as the virtual board variant.
   */
  async function connect(k: TransportKind, opts?: ConnectOptions): Promise<void> {
    if (status.value !== 'disconnected') return;
    status.value = 'connecting';
    kind.value = k;
    lastError.value = null;
    let t: Transport | null = null;
    try {
      const live = factory(k, opts);
      t = live;
      await live.open();
      transport.value = live;
      offDisconnect = live.onDisconnect((reason) => {
        const taken = TAKEOVER_REASON.exec(reason ?? '');
        if (taken?.[1] === 'usbHid' || taken?.[1] === 'ble') {
          snackbar.show(`Another app took control over ${linkKindLabel(taken[1])}`, 'warning');
        } else {
          snackbar.show(`Device disconnected${reason ? `: ${reason}` : ''}`, 'warning');
        }
        reset();
      });
      // Transports that do not tear themselves down on `controlReleased` (the
      // simulator) deliver it as a plain notify; real ones never get here.
      offNotify = live.onNotify((n) => {
        if (n.op !== 'controlReleased' || transport.value !== live) return;
        snackbar.show(`Another app took control over ${linkKindLabel(n.data.to)}`, 'warning');
        reset();
        void live.close().catch(() => undefined);
      });
      const h = await live.request('hello');
      hello.value = h;
      const ctl = h.control;
      if (ctl && ctl.owner !== null && !ctl.self) {
        // Held elsewhere: stop here and let the user decide (§6.3a).
        takeoverRequest.value = { owner: ctl.owner, phase: 'connect' };
        status.value = 'needsTakeover';
        return;
      }
      finishConnect(h);
    } catch (e) {
      const cancelled = e instanceof DeviceError && e.message === 'No device selected';
      lastError.value = e instanceof Error ? e.message : String(e);
      if (e instanceof DeviceError && e.code === 'linkUnsupported') {
        snackbar.show(
          `Bluetooth link not usable: ${e.message}. Try another browser or device, or connect over USB.`,
          'error',
        );
      } else if (!cancelled) snackbar.error(e, 'Connect failed');
      if (t) await t.close().catch(() => undefined);
      reset();
    }
  }

  /**
   * Completes a connect: marks the store connected and flags a protocol
   * version mismatch.
   * @param h The device's `hello` result.
   */
  function finishConnect(h: HidHelloResult): void {
    status.value = 'connected';
    const version: number = h.protocolVersion;
    if (version !== HID_PROTOCOL_VERSION) {
      // Stay connected: the ops this app uses may still work, but flag it.
      snackbar.show(
        `Device speaks protocol v${String(version)}; this app expects v${String(HID_PROTOCOL_VERSION)}. Some features may not work.`,
        'warning',
      );
    }
  }

  /**
   * Dialog action "Take over": sends `claim {takeover:true}`. After the
   * connect-time prompt the normal connect continues; after a later `linkBusy`
   * the epoch is bumped so dependants re-apply their state. A failed claim
   * closes the connection (connect phase) or reports the error.
   */
  async function confirmTakeover(): Promise<void> {
    const t = transport.value;
    const req = takeoverRequest.value;
    const h = hello.value;
    if (t === null || req === null) return;
    try {
      await t.request('claim', { takeover: true });
    } catch (e) {
      if (transport.value !== t) return;
      snackbar.error(e, 'Take over failed');
      if (req.phase === 'connect') await disconnect();
      else takeoverRequest.value = null;
      return;
    }
    if (transport.value !== t) return;
    takeoverRequest.value = null;
    if (req.phase === 'connect' && h !== null) finishConnect(h);
    else ownershipEpoch.value++;
  }

  /** Dialog action "Cancel": closes the connection quietly. */
  async function cancelTakeover(): Promise<void> {
    await disconnect();
  }

  /** Closes the transport and resets state. Safe to call when disconnected. */
  async function disconnect(): Promise<void> {
    const t = transport.value;
    reset();
    if (t) await t.close().catch(() => undefined);
  }

  return {
    status,
    kind,
    transport,
    hello,
    caps,
    features,
    isConnected,
    webHidAvailable,
    deviceLabel,
    lastError,
    webBleAvailable,
    takeoverRequest,
    ownershipEpoch,
    confirmTakeover,
    cancelTakeover,
    connect,
    disconnect,
    requireTransport,
    setTransportFactory,
  };
});
