<script setup lang="ts">
/**
 * Advanced section for developers: the subscription state (merged claims and
 * what the device echoed as active) and a raw request console (op select +
 * JSON body, pretty-printed response or error, history of the last 20). The
 * console cannot send `subscribe`; that goes through the subscriptions store.
 */
import { computed, ref } from 'vue';
import type { OpName } from '@/protocol/types';
import { isDeviceError } from '@/transport/Transport';
import { useConnectionStore } from '@/stores/connection';
import { useSubscriptionsStore } from '@/stores/subscriptions';
import { RAW_OPS, formatResponse, parseRequestBody } from '@/utils/rawConsole';

/** One console history entry. */
interface HistoryEntry {
  op: OpName;
  body: string;
  ok: boolean;
  output: string;
  at: string;
}

const HISTORY_MAX = 20;

const connection = useConnectionStore();
const subs = useSubscriptionsStore();

const op = ref<OpName>('getTiming');
const bodyText = ref('');
const output = ref('');
const outputOk = ref(true);
const sending = ref(false);
const history = ref<HistoryEntry[]>([]);

const bodyError = computed(() => {
  const r = parseRequestBody(bodyText.value);
  return r.ok ? '' : r.error;
});
const claimRows = computed(() =>
  [...subs.claims.entries()].map(([owner, c]) => ({ owner, claim: JSON.stringify(c) })),
);

/** Sends the request and records the outcome. */
async function send(): Promise<void> {
  const parsed = parseRequestBody(bodyText.value);
  if (!parsed.ok) return;
  sending.value = true;
  let text: string;
  let ok = true;
  try {
    const result = await connection.requireTransport().request(op.value, parsed.body);
    text = formatResponse(result);
  } catch (e) {
    ok = false;
    text = isDeviceError(e)
      ? formatResponse({ error: e.code, message: e.message })
      : formatResponse({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    sending.value = false;
  }
  output.value = text;
  outputOk.value = ok;
  history.value = [
    { op: op.value, body: bodyText.value, ok, output: text, at: new Date().toLocaleTimeString() },
    ...history.value,
  ].slice(0, HISTORY_MAX);
}

/**
 * Loads a history entry back into the console.
 * @param h Entry.
 */
function recall(h: HistoryEntry): void {
  op.value = h.op;
  bodyText.value = h.body;
  output.value = h.output;
  outputOk.value = h.ok;
}
</script>

<template>
  <div data-testid="advanced">
    <div class="text-subtitle-2 mb-1">Subscriptions</div>
    <v-table density="compact" class="mb-2">
      <tbody>
        <tr v-for="r in claimRows" :key="r.owner">
          <th>{{ r.owner }}</th>
          <td class="text-caption">{{ r.claim }}</td>
        </tr>
        <tr v-if="claimRows.length === 0">
          <td class="text-medium-emphasis">No claims.</td>
        </tr>
      </tbody>
    </v-table>
    <div class="text-caption text-medium-emphasis">Merged (desired)</div>
    <pre class="text-caption mb-2" data-testid="sub-desired">{{
      JSON.stringify(subs.desired)
    }}</pre>
    <div class="text-caption text-medium-emphasis">Active on device</div>
    <pre class="text-caption mb-4" data-testid="sub-active">{{ JSON.stringify(subs.active) }}</pre>

    <div class="text-subtitle-2 mb-1">Raw request console</div>
    <div class="text-caption text-medium-emphasis mb-2" data-testid="raw-subscribe-note">
      <code>subscribe</code> is not offered here: the device keeps one subscription, owned by the
      claims above.
    </div>
    <v-select v-model="op" :items="RAW_OPS as OpName[]" label="Op" density="compact" />
    <v-textarea
      v-model="bodyText"
      label="Body (JSON object, optional)"
      rows="3"
      auto-grow
      density="compact"
      class="font-monospace"
      :error-messages="bodyError"
      placeholder='{"limit": 8}'
    />
    <v-btn
      color="primary"
      :loading="sending"
      :disabled="bodyError !== '' || !connection.isConnected"
      @click="send"
    >
      Send
    </v-btn>
    <pre
      v-if="output"
      class="mt-3 pa-2 rounded text-caption"
      :class="outputOk ? 'bg-surface-variant' : 'text-error bg-surface-variant'"
      style="overflow: auto; max-height: 20rem"
      data-testid="console-output"
      >{{ output }}</pre>
    <div v-if="history.length" class="text-subtitle-2 mt-4">History</div>
    <v-list density="compact">
      <v-list-item
        v-for="(h, i) in history"
        :key="i"
        :title="h.op"
        :subtitle="`${h.at} ${h.body || '(no body)'}`"
        :prepend-icon="h.ok ? 'mdi-check' : 'mdi-alert'"
        @click="recall(h)"
      />
    </v-list>
  </div>
</template>
