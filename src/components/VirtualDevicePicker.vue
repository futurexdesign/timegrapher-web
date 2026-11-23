<script setup lang="ts">
/**
 * Dialog for choosing which board the virtual device imitates before it
 * connects. The list comes from {@link VIRTUAL_VARIANTS}; "Connect" calls
 * `connect('virtual', { virtualVariant })` and closes the dialog. The last
 * choice is kept in `localStorage` (every access is guarded, since storage can
 * be blocked) and preselected the next time the dialog opens.
 */
import { computed, ref, watch } from 'vue';
import { DEFAULT_VIRTUAL_VARIANT, VIRTUAL_VARIANTS, type VirtualVariantId } from '@/sim';
import { useConnectionStore } from '@/stores/connection';

/** `localStorage` key holding the last chosen variant id. */
const STORAGE_KEY = 'timegrapher.virtualVariant';

/** Dialog visibility; the parent binds it with `v-model`. */
const open = defineModel<boolean>({ required: true });

const connection = useConnectionStore();

/**
 * Reads the remembered variant.
 * @returns The stored id when it names a known variant, else the default.
 */
function loadChoice(): VirtualVariantId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const known = VIRTUAL_VARIANTS.find((v) => v.id === stored);
    if (known) return known.id;
  } catch {
    // Storage blocked: fall through to the default.
  }
  return DEFAULT_VIRTUAL_VARIANT;
}

/**
 * Remembers a choice for the next session; a blocked store is ignored.
 * @param id Variant to remember.
 */
function saveChoice(id: VirtualVariantId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage blocked: the choice only lasts for this page load.
  }
}

const selected = ref<VirtualVariantId>(loadChoice());

/** `v-list` selection model: an array holding the single chosen id. */
const selection = computed<VirtualVariantId[]>({
  get: () => [selected.value],
  set: (ids) => {
    const next = VIRTUAL_VARIANTS.find((v) => v.id === ids[0]);
    if (next) selected.value = next.id;
  },
});

// Re-read on each open so the dialog reflects the stored choice.
watch(open, (isOpen) => {
  if (isOpen) selected.value = loadChoice();
});

/** Remembers the choice, closes the dialog and connects to the chosen board. */
function confirm(): void {
  saveChoice(selected.value);
  open.value = false;
  void connection.connect('virtual', { virtualVariant: selected.value });
}
</script>

<template>
  <v-dialog v-model="open" max-width="440">
    <v-card
      title="Virtual device"
      subtitle="Choose the board to simulate"
      data-testid="virtual-picker"
    >
      <v-card-text>
        <v-list v-model:selected="selection" select-strategy="single-independent" mandatory>
          <v-list-item
            v-for="variant in VIRTUAL_VARIANTS"
            :key="variant.id"
            :value="variant.id"
            :title="variant.label"
            :data-testid="`virtual-variant-${variant.id}`"
          >
            <template #append>
              <v-chip
                size="small"
                label
                :prepend-icon="variant.options.ble === true ? 'mdi-bluetooth' : 'mdi-usb'"
              >
                {{ variant.description }}
              </v-chip>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn data-testid="virtual-cancel" @click="open = false">Cancel</v-btn>
        <v-btn
          color="primary"
          data-testid="virtual-confirm"
          :disabled="connection.status !== 'disconnected'"
          @click="confirm"
        >
          Connect
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
