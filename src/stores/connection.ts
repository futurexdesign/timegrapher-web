/**
 * Connection store: owns the active {@link Transport}, the connection status,
 * the `hello` identity/caps and the feature flags derived from the caps.
 *
 * Views never construct transports; they call `connect(kind)` and use
 * `requireTransport()` to issue requests.
 */
import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { HidHelloCaps, HidHelloResult } from '@/protocol/types';
import { createVirtualTransport } from '@/sim'; // FACTORY HOOK: virtual device
import { DeviceError, type Transport, type TransportKind } from '@/transport/Transport';
import { WebHidTransport, isWebHidSupported } from '@/transport/WebHidTransport';
import { HID_PROTOCOL_VERSION } from '@/protocol/constants';
import { useSnackbarStore } from './snackbar';

/** Connection lifecycle. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** Builds a transport for a kind. Overridable for tests. */
export type TransportFactory = (kind: TransportKind) => Transport;

/**
 * Default factory.
 * FACTORY HOOK: add/replace transport kinds here. The 'virtual' branch calls
 * `createVirtualTransport` from `src/sim/index.ts`.
 * @param kind Transport kind to build.
 */
export const defaultTransportFactory: TransportFactory = (kind) => {
  switch (kind) {
    case 'webhid':
      return new WebHidTransport();
    case 'virtual':
      return createVirtualTransport();
  }
};

/** Feature flags derived from `hello.caps` (absent caps key = feature absent). */
export interface FeatureFlags {
  quartz: boolean;
  beats: boolean;
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
  let offDisconnect: (() => void) | null = null;

  const caps = computed(() => hello.value?.caps ?? null);
  const features = computed(() => deriveFeatures(caps.value));
  const isConnected = computed(() => status.value === 'connected');
  const webHidAvailable = computed(() => isWebHidSupported());
  /** Short description such as "Pico2 · fw 0.1.0-dev". */
  const deviceLabel = computed(() =>
    hello.value ? `${hello.value.board} · fw ${hello.value.fwVersion}` : '',
  );

  /**
   * Replaces the transport factory (tests, alternative backends).
   * @param f New factory.
   */
  function setTransportFactory(f: TransportFactory): void {
    factory = f;
  }

  /**
   * Returns the live transport.
   * @throws {DeviceError} `notOpen` when not connected.
   */
  function requireTransport(): Transport {
    const t = transport.value;
    if (t === null || status.value !== 'connected') {
      throw new DeviceError('notOpen', 'No device connected');
    }
    return t;
  }

  /** Drops the transport, hello and listener and returns to `disconnected`. */
  function reset(): void {
    offDisconnect?.();
    offDisconnect = null;
    transport.value = null;
    hello.value = null;
    kind.value = null;
    status.value = 'disconnected';
  }

  /**
   * Connects: builds the transport, opens it, then issues `hello`.
   * Failures are reported via the snackbar (user-cancelled choosers are quiet).
   * @param k Which kind of device to connect to.
   */
  async function connect(k: TransportKind): Promise<void> {
    if (status.value !== 'disconnected') return;
    status.value = 'connecting';
    kind.value = k;
    lastError.value = null;
    let t: Transport | null = null;
    try {
      t = factory(k);
      await t.open();
      transport.value = t;
      offDisconnect = t.onDisconnect((reason) => {
        snackbar.show(`Device disconnected${reason ? `: ${reason}` : ''}`, 'warning');
        reset();
      });
      hello.value = await t.request('hello');
      status.value = 'connected';
      const version: number = hello.value.protocolVersion;
      if (version !== HID_PROTOCOL_VERSION) {
        // Stay connected: the ops this app uses may still work, but flag it.
        snackbar.show(
          `Device speaks protocol v${String(version)}; this app expects v${String(HID_PROTOCOL_VERSION)}. Some features may not work.`,
          'warning',
        );
      }
    } catch (e) {
      const cancelled = e instanceof DeviceError && e.message === 'No device selected';
      lastError.value = e instanceof Error ? e.message : String(e);
      if (!cancelled) snackbar.error(e, 'Connect failed');
      if (t) await t.close().catch(() => undefined);
      reset();
    }
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
    connect,
    disconnect,
    requireTransport,
    setTransportFactory,
  };
});
