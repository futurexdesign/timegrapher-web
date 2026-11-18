<script setup lang="ts">
/**
 * Device info section: identity from `hello` (firmware, board, source,
 * protocol, USB ids), the capabilities as readable chips and a button that
 * copies the raw hello JSON to the clipboard.
 */
import { computed, ref } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useSnackbarStore } from '@/stores/snackbar';
import { capChips } from '@/utils/capsChips';

const connection = useConnectionStore();
const snackbar = useSnackbarStore();

const hello = computed(() => connection.hello);
const chips = computed(() => (hello.value ? capChips(hello.value.caps) : []));
const copied = ref(false);

/**
 * Formats a USB id as 4 hex digits.
 * @param n Id.
 */
function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`;
}

/** Copies the raw hello JSON. */
async function copy(): Promise<void> {
  if (!hello.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(hello.value, null, 2));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    snackbar.error(e, 'Copy failed');
  }
}
</script>

<template>
  <div v-if="hello" data-testid="device-info">
    <v-table density="compact">
      <tbody>
        <tr>
          <th>Firmware</th>
          <td>{{ hello.fwVersion }}</td>
        </tr>
        <tr>
          <th>Board</th>
          <td>{{ hello.board }}</td>
        </tr>
        <tr>
          <th>Audio source</th>
          <td>{{ hello.source }}</td>
        </tr>
        <tr>
          <th>Protocol</th>
          <td>v{{ hello.protocolVersion }}</td>
        </tr>
        <tr>
          <th>USB VID / PID</th>
          <td>{{ hex(hello.vid) }} / {{ hex(hello.pid) }}</td>
        </tr>
      </tbody>
    </v-table>
    <div class="text-subtitle-2 mt-4 mb-1">Capabilities</div>
    <div class="d-flex flex-wrap ga-2">
      <v-chip
        v-for="c in chips"
        :key="c.label"
        size="small"
        :color="c.on ? 'primary' : undefined"
        :variant="c.on ? 'tonal' : 'outlined'"
      >
        {{ c.label }}
      </v-chip>
    </div>
    <v-btn
      class="mt-4"
      size="small"
      variant="tonal"
      :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'"
      @click="copy"
    >
      {{ copied ? 'Copied' : 'Copy raw hello JSON' }}
    </v-btn>
  </div>
</template>
