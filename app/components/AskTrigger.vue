<script setup lang="ts">
/**
 * AskTrigger — opens the Ask dock.
 *
 * Lives in the top bar next to the notifications bell rather than floating
 * over the page: it matches how the palette and the bell are already
 * surfaced, and nothing overlaps page content that way. Toggles, so the
 * same control closes the dock again.
 */
const { dockOpen, toggleDock } = useAsk();
</script>

<template>
  <UiButton
    variant="ghost"
    size="icon"
    type="button"
    :aria-expanded="dockOpen"
    aria-controls="ask-dock"
    @click="toggleDock"
  >
    <Icon name="lucide:sparkles" class="size-4" aria-hidden="true" />
    <span class="sr-only">{{ dockOpen ? "Close" : "Open" }} Ask The Reserve</span>
  </UiButton>
</template>
