<script setup lang="ts">
/**
 * A capped card whose middle scrolls. The header slot is pinned above,
 * the footer slot is pinned below, and only the default slot scrolls —
 * so on a busy day a list stops growing at its cap instead of pushing
 * the rest of the dashboard off the page, and whatever frames the list
 * (a title, a calendar, an "open full schedule" link) stays put.
 *
 * The cap and the padding are the consumer's: pass `max-h-*` and `p-*`
 * in `class`, which falls through to the root. Three dashboard cards
 * use this (today's appointments, the week calendar's day list, new
 * clients); it was extracted when the third copy of the same
 * flex-col / min-h-0 / overflow-y-auto recipe appeared.
 */
defineSlots<{
  header?: () => unknown;
  default: () => unknown;
  footer?: () => unknown;
}>();
</script>

<template>
  <div class="flex flex-col rounded-md border bg-card">
    <div v-if="$slots.header" class="shrink-0">
      <slot name="header" />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <slot />
    </div>
    <div v-if="$slots.footer" class="shrink-0">
      <slot name="footer" />
    </div>
  </div>
</template>
