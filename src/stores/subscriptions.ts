/**
 * Shared push-subscription manager and notify bus.
 *
 * The device keeps ONE subscription per connection (§7), and every
 * `subscribe` re-seeds the event / pulse / beat baselines. If each view sent
 * its own `subscribe`, views would fight over rates and drop pushes. Instead,
 * consumers register *claims* here:
 *
 * ```ts
 * const subs = useSubscriptionsStore();
 * subs.claim('timegrapher', { beatHz: 2, beats: true });
 * const off = subs.on('beats', (d) => …);
 * // later
 * subs.release('timegrapher'); off();
 * ```
 *
 * The effective subscription is the merge of all claims (rates: maximum;
 * flags: logical OR). Only the fields that actually changed are sent, so a
 * claim that does not change the merged value costs nothing and does not
 * re-seed baselines. Claims survive a disconnect and are re-applied on the
 * next connection. A failed `subscribe` is retried with backoff
 * ({@link SUBSCRIBE_RETRY_MS}) while connected, until one succeeds (the device's
 * echo, possibly clamped, is then the truth); a disconnect stops the retries.
 */
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { HidSubscribePatch, HidSubscription, NotifyOp } from '@/protocol/types';
import type { HidNotifyDataMap } from '@/protocol/timegrapher_hid';
import { useConnectionStore } from './connection';
import { useSnackbarStore } from './snackbar';

/** Rate fields of {@link HidSubscription} (merged by maximum). */
const RATE_KEYS = ['metricsHz', 'beatHz', 'timingHz', 'quartzHz'] as const;
/** Flag fields of {@link HidSubscription} (merged by OR). */
const FLAG_KEYS = ['events', 'errors', 'quartzPulses', 'beats'] as const;

/** Retry delays (ms) after a failed `subscribe`; the last one repeats. */
export const SUBSCRIBE_RETRY_MS: readonly number[] = [1000, 2000, 5000, 10000];

/** The quiet subscription the device starts with after connect. */
const QUIET: HidSubscription = {
  metricsHz: 0,
  beatHz: 0,
  timingHz: 0,
  quartzHz: 0,
  events: false,
  errors: false,
  quartzPulses: false,
  beats: false,
};

/** Listener for one notify op. */
export type NotifyHandler<O extends NotifyOp> = (data: HidNotifyDataMap[O]) => void;

/**
 * Merges claims into one subscription.
 * @param claims Claims by owner.
 * @returns The effective subscription.
 */
export function mergeClaims(claims: Iterable<HidSubscribePatch>): HidSubscription {
  const out: HidSubscription = { ...QUIET };
  for (const c of claims) {
    for (const k of RATE_KEYS) out[k] = Math.max(out[k], c[k] ?? 0);
    for (const k of FLAG_KEYS) out[k] = Boolean(out[k]) || Boolean(c[k]);
  }
  return out;
}

/**
 * Fields of `next` that differ from `prev`.
 * @param prev Subscription in effect on the device.
 * @param next Desired subscription.
 * @returns Patch to send, or `null` when nothing changed.
 */
export function diffSubscription(
  prev: HidSubscription,
  next: HidSubscription,
): HidSubscribePatch | null {
  const patch: HidSubscribePatch = {};
  let changed = false;
  for (const k of RATE_KEYS) {
    if (prev[k] !== next[k]) {
      patch[k] = next[k];
      changed = true;
    }
  }
  for (const k of FLAG_KEYS) {
    if (Boolean(prev[k]) !== Boolean(next[k])) {
      patch[k] = Boolean(next[k]);
      changed = true;
    }
  }
  return changed ? patch : null;
}

/** Pinia store owning the device subscription and notify fan-out. */
export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const connection = useConnectionStore();
  const snackbar = useSnackbarStore();

  /** Claims by owner id. */
  const claims = ref(new Map<string, HidSubscribePatch>());
  /** What the device last echoed (authoritative, includes firmware clamping). */
  const active = ref<HidSubscription>({ ...QUIET });
  /** Desired merged subscription. */
  const desired = computed(() => mergeClaims(claims.value.values()));

  const handlers = new Map<NotifyOp, Set<(data: unknown) => void>>();
  let offNotify: (() => void) | null = null;
  /** Serialises sync() so overlapping changes never interleave. */
  let syncing: Promise<void> = Promise.resolve();
  const isUp = (): boolean => connection.isConnected;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;

  /** Cancels a pending retry and restarts the backoff sequence. */
  function stopRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
  }

  /** Schedules the next retry (no-op while one is pending). */
  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    const delay =
      SUBSCRIBE_RETRY_MS[Math.min(retryAttempt, SUBSCRIBE_RETRY_MS.length - 1)] ?? 10000;
    retryAttempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sync();
    }, delay);
  }

  /** Sends the difference between {@link desired} and {@link active}. */
  async function syncNow(): Promise<void> {
    if (!connection.isConnected) return;
    const patch = diffSubscription(active.value, desired.value);
    if (patch === null) {
      stopRetry();
      return;
    }
    try {
      const echo = await connection.requireTransport().request('subscribe', patch);
      active.value = { ...QUIET, ...echo };
      stopRetry();
    } catch (e) {
      // Report the first failure of a streak only; retries stay quiet.
      if (retryAttempt === 0) snackbar.error(e, 'Subscribe failed');
      // The status may have changed during the request (TS cannot see that).
      if (isUp()) scheduleRetry();
    }
  }

  /** Queues a sync after any in-flight one. */
  function sync(): Promise<void> {
    syncing = syncing.then(syncNow, syncNow);
    return syncing;
  }

  /**
   * Adds or replaces the claim of `owner`.
   * @param owner Stable id of the consumer (e.g. a store or view name).
   * @param patch Rates / flags it needs.
   */
  function claim(owner: string, patch: HidSubscribePatch): Promise<void> {
    const next = new Map(claims.value);
    next.set(owner, { ...patch });
    claims.value = next;
    return sync();
  }

  /**
   * Removes the claim of `owner`.
   * @param owner Id passed to {@link claim}.
   */
  function release(owner: string): Promise<void> {
    if (!claims.value.has(owner)) return Promise.resolve();
    const next = new Map(claims.value);
    next.delete(owner);
    claims.value = next;
    return sync();
  }

  /**
   * Registers a handler for one notify op.
   * @param op Notify op name.
   * @param handler Called with the typed `data` of each notify.
   * @returns Unregister function.
   */
  function on<O extends NotifyOp>(op: O, handler: NotifyHandler<O>): () => void {
    let set = handlers.get(op);
    if (!set) {
      set = new Set();
      handlers.set(op, set);
    }
    const h = handler as (data: unknown) => void;
    set.add(h);
    return () => set.delete(h);
  }

  /* Attach to each new transport; re-apply claims after (re)connect. */
  watch(
    () => connection.isConnected,
    (connected) => {
      offNotify?.();
      offNotify = null;
      active.value = { ...QUIET };
      stopRetry();
      if (!connected) return;
      offNotify = connection.requireTransport().onNotify((n) => {
        const set = handlers.get(n.op);
        if (!set) return;
        for (const h of set) {
          try {
            h(n.data);
          } catch (e) {
            console.error(`notify handler for ${n.op} failed`, e);
          }
        }
      });
      void sync();
    },
    { immediate: true },
  );

  return { claims, active, desired, claim, release, on, sync };
});
