<script setup lang="ts">
/**
 * Modal asking whether to take control of a stand that another host holds
 * (BLE_TRANSPORT_PLAN.md §6.3a). It opens when the connection store has a
 * pending takeover request: after `hello` reported another owner, or after a
 * later request failed with `linkBusy`. "Take over" sends `claim` with
 * `takeover: true`; "Cancel" disconnects. The dialog is persistent so the
 * choice cannot be dismissed by accident; Vuetify keeps focus inside it.
 */
import { computed } from 'vue';
import { linkKindLabel, useConnectionStore } from '@/stores/connection';

const connection = useConnectionStore();

/** Open while a takeover request is pending. */
const open = computed(() => connection.takeoverRequest !== null);

/** The prompt text; names the link when the device reported it. */
const message = computed(() => {
  const owner = connection.takeoverRequest?.owner ?? null;
  const how = owner === null ? '' : ` over ${linkKindLabel(owner)}`;
  return `This stand is being controlled${how} by another app. Take over?`;
});
</script>

<template>
  <v-dialog :model-value="open" max-width="440" persistent>
    <v-card title="Stand in use" data-testid="takeover-dialog">
      <v-card-text>{{ message }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn data-testid="takeover-cancel" @click="connection.cancelTakeover()">Cancel</v-btn>
        <v-btn color="primary" data-testid="takeover-confirm" @click="connection.confirmTakeover()">
          Take over
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
