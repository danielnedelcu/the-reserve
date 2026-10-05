<script setup lang="ts">
/**
 * AskModal — the ⌘I prompt surface.
 *
 * Deliberately NOT merged into the command palette: ⌘K is deterministic
 * and navigational, this is generative and takes seconds. Same keyboard
 * grammar, different contract, so they stay separate components.
 *
 * Shows ~3 presets keyed to the current route (instant, zero-token) plus
 * a free-text input (LLM → SQL). Submitting hands off to AskPanel via
 * useAsk() and closes — the dock is where waiting and results happen.
 */
import { presetsForRoute, EXAMPLE_QUESTIONS } from "~~/shared/ask/presets";

const { ask, modalOpen } = useAsk();
const route = useRoute();

const question = ref("");
const presets = computed(() => presetsForRoute(route.path));

// Typewriter placeholder: cycles example questions so the input suggests
// its own range rather than sitting empty and inscrutable.
const exampleIndex = ref(0);
let cycle: ReturnType<typeof setInterval> | undefined;

watch(modalOpen, (open) => {
  if (open) {
    question.value = "";
    exampleIndex.value = 0;
    cycle = setInterval(() => {
      exampleIndex.value = (exampleIndex.value + 1) % EXAMPLE_QUESTIONS.length;
    }, 3500);
  } else {
    clearInterval(cycle);
  }
});

onUnmounted(() => clearInterval(cycle));

// ⌘I from anywhere. Ignored while typing in another field only when that
// field would swallow it — the modal is the point, so we always preventDefault.
useEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key.toLowerCase() === "i" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    modalOpen.value = !modalOpen.value;
  }
});

function submitText() {
  const text = question.value.trim();
  if (!text) return;
  ask({ question: text, route: route.path, label: text });
  modalOpen.value = false;
}

function submitPreset(id: string, label: string) {
  ask({ presetId: id, route: route.path, label });
  modalOpen.value = false;
}
</script>

<template>
  <UiDialog v-model:open="modalOpen">
    <UiDialogContent class="sm:max-w-lg">
      <UiDialogHeader>
        <UiDialogTitle class="flex items-center gap-2">
          <Icon name="lucide:sparkles" class="size-4" aria-hidden="true" />
          Ask The Reserve
        </UiDialogTitle>
        <UiDialogDescription>
          Ask about your bookings, clients, and sales. Answers come from your
          own data.
        </UiDialogDescription>
      </UiDialogHeader>

      <div class="grid gap-4">
        <!-- Presets: instant, no LLM -->
        <div class="grid gap-2">
          <p class="text-muted-foreground text-xs font-medium">
            Common questions here
          </p>
          <button
            v-for="preset in presets"
            :key="preset.id"
            type="button"
            class="hover:bg-muted focus-visible:ring-ring flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
            @click="submitPreset(preset.id, preset.label)"
          >
            <Icon
              name="lucide:zap"
              class="size-3.5 shrink-0 opacity-60"
              aria-hidden="true"
            />
            <span>{{ preset.label }}</span>
          </button>
        </div>

        <!-- Free text: goes through the LLM -->
        <form class="grid gap-2" @submit.prevent="submitText">
          <label for="ask-input" class="text-muted-foreground text-xs font-medium">
            Or ask anything
          </label>
          <div class="flex gap-2">
            <UiInput
              id="ask-input"
              v-model="question"
              :placeholder="EXAMPLE_QUESTIONS[exampleIndex]"
              autocomplete="off"
            />
            <UiButton type="submit" :disabled="!question.trim()">
              <Icon name="lucide:corner-down-left" class="size-4" aria-hidden="true" />
              <span class="sr-only">Ask</span>
            </UiButton>
          </div>
        </form>
      </div>
    </UiDialogContent>
  </UiDialog>
</template>
