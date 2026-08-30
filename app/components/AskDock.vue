<script setup lang="ts">
/**
 * AskDock — Ask The Reserve's bottom-right chat panel.
 *
 * Bottom-right and non-navigating on purpose: the admin asked a question
 * mid-task, so the answer has to sit still while they act on it.
 *
 * One input path, deliberately. The dock's own Ask button dispatches the
 * same window event that useAsk().ask() fires from anywhere else, so a
 * question typed here and a question fired by ⌘I or a chip on a client
 * page go through identical code. There is no second way in to keep
 * working.
 *
 * HISTORY IS VISUAL, NOT CONVERSATIONAL. Asks stack as Q&A pairs so an
 * admin can compare answers and scroll back, but every question is still
 * answered INDEPENDENTLY: /api/ask receives one question and no prior
 * turns, so nothing here lets "and how about last month?" resolve against
 * the question above it. Conversational follow-up — sending prior turns
 * so the model can refine — is a separate piece of work with its own cost
 * and prompt-caching consequences. See the design doc's open questions.
 *
 * Because entries are independent, they also complete independently: a
 * slow question left pending does not block a later quick one, and each
 * fills its own slot when it lands.
 *
 * Results render through the rendering contract (app/utils/askFormat.ts):
 * a column's NAME decides its display — `_cents` → currency, `_at` → a
 * date, `_id` consumed to link the name it identifies. The caption above
 * each table is built server-side from the result shape; result rows
 * never leave the database, so there is no model-written prose to show.
 */
import type { AskRequest, AskResult } from "~/composables/useAsk";
import type { ColumnPlan, DisplayColumn } from "~/utils/askFormat";

interface AskEntry {
  id: number;
  /** The question as asked, shown above its answer. */
  label: string;
  pending: boolean;
  result: AskResult | null;
  error: string | null;
  /** Column classification, computed once when the result lands. */
  plan: ColumnPlan | null;
  showSql: boolean;
}

const { onAsk, askText, dockOpen, closeDock } = useAsk();
const route = useRoute();

const question = ref("");
const entries = ref<AskEntry[]>([]);
const copiedId = ref<number | null>(null);
// UiInput is a component; it exposes the native element as `inputRef`.
const inputEl = ref<{ inputRef?: HTMLInputElement } | null>(null);
const scrollEl = ref<HTMLElement | null>(null);

let nextId = 0;

/** Keep the newest exchange in view as it is added and as it resolves. */
async function scrollToLatest() {
  await nextTick();
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

onAsk(async (request: AskRequest) => {
  dockOpen.value = true;

  // reactive() BEFORE pushing, deliberately. Pushing a plain object stores
  // the raw object while reads go through a proxy, so later mutations
  // (entry.pending = false) change the data without triggering a re-render —
  // the entry would sit on "Looking through your data…" forever even though
  // the request succeeded. Mutating the proxy is what makes it live.
  const entry = reactive<AskEntry>({
    id: nextId++,
    label: request.label,
    pending: true,
    result: null,
    error: null,
    plan: null,
    showSql: false,
  });
  entries.value.push(entry);
  await scrollToLatest();

  try {
    const result = await $fetch<AskResult>("/api/ask", {
      method: "POST",
      body: {
        question: request.question,
        presetId: request.presetId,
        route: request.route,
      },
    });
    entry.result = result;
    // markRaw: the plan is derived once and never mutated, so there is no
    // reason to pay for a reactive proxy over its Map.
    entry.plan = markRaw(planColumns(result.columns, result.rows));
  } catch (error) {
    const err = error as { data?: { statusMessage?: string }; message?: string };
    entry.error = err.data?.statusMessage ?? err.message ?? "Something went wrong.";
  } finally {
    entry.pending = false;
    await scrollToLatest();
  }
});

function submit() {
  const text = question.value.trim();
  if (!text) return;
  askText(text, route.path);
  question.value = "";
}

/** Start over. Clears the transcript; nothing server-side is affected. */
async function newThread() {
  entries.value = [];
  question.value = "";
  await nextTick();
  inputEl.value?.inputRef?.focus();
}

// Focus the input when the dock opens — it is the only thing to do here.
watch(dockOpen, async (open) => {
  if (!open) return;
  await nextTick();
  inputEl.value?.inputRef?.focus();
});

/**
 * The table iterates plan.display, not the raw columns: a person's name
 * arrives split across first_name/last_name and is rendered as one "Name"
 * cell carrying one link.
 */
const cell = (
  entry: AskEntry,
  column: DisplayColumn,
  row: Record<string, unknown>,
) => cellValue(column, row, entry.plan ?? undefined);

/** Caption plus the table as TSV — the shape that pastes into an email. */
async function copyEntry(entry: AskEntry) {
  const result = entry.result;
  if (!result || !entry.plan) return;
  const columns = entry.plan.display;
  const headings = columns.map((c) => c.label).join("\t");
  const body = result.rows
    .map((row) => columns.map((c) => cell(entry, c, row)).join("\t"))
    .join("\n");
  await navigator.clipboard.writeText(
    [result.answer, headings, body].filter(Boolean).join("\n"),
  );
  copiedId.value = entry.id;
  setTimeout(() => {
    if (copiedId.value === entry.id) copiedId.value = null;
  }, 2000);
}
</script>

<template>
  <div
    v-if="dockOpen"
    id="ask-dock"
    class="bg-background fixed right-4 bottom-4 z-50 flex max-h-[min(34rem,80vh)] w-[min(28rem,calc(100vw-2rem))] flex-col rounded-xl border shadow-lg"
    role="complementary"
    aria-label="Ask The Reserve"
  >
    <!-- Header -->
    <div class="flex items-center gap-1 border-b p-3">
      <Icon
        name="lucide:sparkles"
        class="mr-1 size-4 shrink-0 opacity-70"
        aria-hidden="true"
      />
      <p class="flex-1 text-sm font-medium">Ask The Reserve</p>
      <UiButton
        v-if="entries.length"
        variant="ghost"
        size="icon-sm"
        type="button"
        @click="newThread"
      >
        <Icon name="lucide:plus" class="size-4" aria-hidden="true" />
        <span class="sr-only">New thread — clear these questions</span>
      </UiButton>
      <UiButton variant="ghost" size="icon-sm" type="button" @click="closeDock">
        <Icon name="lucide:x" class="size-4" aria-hidden="true" />
        <span class="sr-only">Close</span>
      </UiButton>
    </div>

    <!-- Transcript -->
    <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
      <!-- Empty state -->
      <div
        v-if="!entries.length"
        class="text-muted-foreground grid gap-1 py-6 text-center text-sm"
      >
        <Icon
          name="lucide:message-circle-question"
          class="mx-auto size-5 opacity-50"
          aria-hidden="true"
        />
        <p>Ask a question about your bookings, clients, or sales.</p>
        <p class="text-xs">Answers come from your own data.</p>
      </div>

      <ol v-else class="grid list-none gap-5">
        <li v-for="entry in entries" :key="entry.id" class="grid gap-2">
          <!-- The question -->
          <p class="text-sm font-medium">{{ entry.label }}</p>

          <!-- Pending -->
          <div
            v-if="entry.pending"
            class="text-muted-foreground flex items-center gap-2 text-sm"
          >
            <Icon
              name="lucide:loader-circle"
              class="size-4 animate-spin"
              aria-hidden="true"
            />
            Looking through your data…
          </div>

          <!-- Error. Icon + text, never colour alone. -->
          <div
            v-else-if="entry.error"
            class="border-destructive/40 flex items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <Icon
              name="lucide:triangle-alert"
              class="text-destructive mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              <span class="font-medium">Couldn't answer that.</span>
              {{ entry.error }}
            </p>
          </div>

          <!-- Result -->
          <div v-else-if="entry.result" class="grid gap-3">
            <p v-if="entry.result.answer" class="text-sm leading-relaxed">
              {{ entry.result.answer }}
            </p>

            <div v-if="entry.result.rows.length" class="rounded-lg border">
              <UiTable>
                <UiTableHeader>
                  <UiTableRow class="hover:bg-transparent">
                    <UiTableHead
                      v-for="column in entry.plan?.display ?? []"
                      :key="column.key"
                      :class="column.numeric ? 'text-right' : undefined"
                    >
                      {{ column.label }}
                    </UiTableHead>
                  </UiTableRow>
                </UiTableHeader>
                <UiTableBody>
                  <UiTableRow
                    v-for="(row, index) in entry.result.rows"
                    :key="index"
                  >
                    <UiTableCell
                      v-for="column in entry.plan?.display ?? []"
                      :key="column.key"
                      :class="column.numeric ? 'text-right' : undefined"
                    >
                      <NuxtLink
                        v-if="cellLink(column, row)"
                        :to="cellLink(column, row)!"
                        class="font-medium underline-offset-4 hover:underline"
                      >
                        {{ cell(entry, column, row) }}
                      </NuxtLink>
                      <template v-else>{{ cell(entry, column, row) }}</template>
                    </UiTableCell>
                  </UiTableRow>
                </UiTableBody>
              </UiTable>
            </div>

            <p v-if="entry.result.truncated" class="text-muted-foreground text-xs">
              Showing the first {{ entry.result.rows.length }} rows.
            </p>

            <!-- Transparency: the generated SQL, per answer, on demand -->
            <div v-if="entry.result.sql" class="grid gap-2">
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
                :aria-expanded="entry.showSql"
                @click="entry.showSql = !entry.showSql"
              >
                <Icon
                  :name="entry.showSql ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                  class="size-3.5"
                  aria-hidden="true"
                />
                {{ entry.showSql ? "Hide" : "Show" }} the query
              </button>
              <pre
                v-if="entry.showSql"
                class="bg-muted overflow-x-auto rounded-lg p-3 text-xs"
              ><code>{{ entry.result.sql }}</code></pre>
            </div>

            <div v-if="entry.result.rows.length" class="flex justify-end">
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                @click="copyEntry(entry)"
              >
                <Icon
                  :name="copiedId === entry.id ? 'lucide:check' : 'lucide:copy'"
                  class="size-3.5"
                  aria-hidden="true"
                />
                {{ copiedId === entry.id ? "Copied" : "Copy" }}
              </UiButton>
            </div>
          </div>
        </li>
      </ol>
    </div>

    <!-- Ask -->
    <form class="flex items-center gap-2 border-t p-3" @submit.prevent="submit">
      <label for="ask-dock-input" class="sr-only">Your question</label>
      <UiInput
        id="ask-dock-input"
        ref="inputEl"
        v-model="question"
        placeholder="Ask a question…"
        autocomplete="off"
        class="flex-1"
        @keydown.enter.prevent="submit"
      />
      <UiButton type="submit" :disabled="!question.trim()"> Ask </UiButton>
    </form>
  </div>
</template>
