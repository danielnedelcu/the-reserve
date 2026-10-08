<script setup lang="ts">
/**
 * A picker whose options come from the server as you type — Lokl's
 * SearchSelect in server mode (docs/server-tables-reference.md §7), for
 * the lists that are too long to load whole: clients and products. It
 * replaced selects and search boxes that loaded every row and were cut
 * at max_rows without an error (docs/TODO.md, "Pickers that load every
 * row"). The small catalogues — staff, services — stay as plain selects.
 *
 * - `search(term, signal)` runs about 300ms after typing stops; an older
 *   search still running is cancelled and its late answer dropped
 *   (app/utils/latestSearch.ts, the newest search wins).
 * - Opening the list runs the empty search once, so it is never blank.
 * - The chosen value's label is looked up by id through `lookup`, so the
 *   box names it after a reload, before any search.
 * - A `clearLabel` adds a first option that sets the value to null
 *   ("Walk-in / no client"); `clearOnSelect` makes the picker an action
 *   (add this product) rather than a choice.
 * - Accessible by role and name: the input is a combobox named by the
 *   page's <label for=id>, the list a listbox of options, and the
 *   "Searching…" line a status, so the journeys find all three.
 */
import { createLatestSearch, type LatestSearch } from "~/utils/latestSearch";

export interface SearchOption<Data = unknown> {
  value: string;
  label: string;
  /** A second line that tells same-named entries apart: an email, a price. */
  description?: string;
  data?: Data;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    search: (term: string, signal: AbortSignal) => Promise<SearchOption[]>;
    lookup?: (id: string, signal: AbortSignal) => Promise<SearchOption | null>;
    id: string;
    placeholder?: string;
    emptyText?: string;
    clearLabel?: string;
    clearOnSelect?: boolean;
    disabled?: boolean;
  }>(),
  { placeholder: "Type to search…", emptyText: "Nothing matches.", clearOnSelect: false, disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string | null]; select: [option: SearchOption] }>();

const open = ref(false);
const focused = ref(false);
const term = ref("");
const found = shallowRef<SearchOption[]>([]);
const searching = ref(false);
const searched = ref(false); // has any search answered yet (for the empty line)
const active = ref(-1);
const known = reactive(new Map<string, SearchOption>());

const searcher: LatestSearch = createLatestSearch(props.search, {
  result: (_term, options) => {
    found.value = options;
    for (const o of options) known.set(o.value, o);
    searched.value = true;
    active.value = options.length ? 0 : -1;
  },
  error: () => {
    found.value = [];
    searched.value = true;
  },
  busy: (b) => (searching.value = b),
});
onBeforeUnmount(() => searcher.cancel());

const selected = computed(() => (props.modelValue ? known.get(props.modelValue) : undefined));
/** What the box shows: the typed term while typing, else the chosen label. */
const text = computed(() => (focused.value ? term.value : (selected.value?.label ?? "")));

// The chosen value's label, looked up by id when nothing here knows it yet
// (after a reload, or a value set by the page).
let lookupController: AbortController | null = null;
watch(
  () => props.modelValue,
  async (id) => {
    lookupController?.abort();
    if (!id || known.has(id) || !props.lookup) return;
    const mine = (lookupController = new AbortController());
    try {
      const option = await props.lookup(id, mine.signal);
      if (!mine.signal.aborted && option) known.set(option.value, option);
    } catch {
      // the box shows nothing for it rather than a wrong name
    }
  },
  { immediate: true },
);

function onFocus() {
  focused.value = true;
  term.value = "";
  open.value = true;
  if (!searched.value) void searcher.now("");
}
function onBlur() {
  focused.value = false;
  open.value = false;
  searcher.cancel();
}
function onInput(e: Event) {
  term.value = (e.target as HTMLInputElement).value;
  open.value = true;
  searcher.request(term.value.trim());
}
const options = computed<(SearchOption | { value: null; label: string })[]>(() =>
  props.clearLabel ? [{ value: null, label: props.clearLabel }, ...found.value] : found.value,
);
function choose(option: SearchOption | { value: null; label: string }) {
  if (option.value === null) {
    emit("update:modelValue", null);
  } else {
    known.set(option.value, option as SearchOption);
    emit("select", option as SearchOption);
    emit("update:modelValue", props.clearOnSelect ? null : option.value);
  }
  term.value = "";
  open.value = false;
  (document.getElementById(props.id) as HTMLInputElement | null)?.blur();
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    open.value = true;
    active.value = Math.min(active.value + 1, options.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    active.value = Math.max(active.value - 1, 0);
  } else if (e.key === "Enter") {
    const option = options.value[active.value];
    if (open.value && option) {
      e.preventDefault();
      choose(option);
    }
  } else if (e.key === "Escape") {
    open.value = false;
  }
}
const listId = computed(() => `${props.id}-listbox`);
const optionId = (i: number) => `${props.id}-option-${i}`;
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :value="text"
      type="text"
      role="combobox"
      autocomplete="off"
      :placeholder="placeholder"
      :disabled="disabled"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && active >= 0 ? optionId(active) : undefined"
      class="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
      @focus="onFocus"
      @blur="onBlur"
      @input="onInput"
      @keydown="onKeydown"
    />
    <div
      v-show="open"
      class="bg-popover text-popover-foreground absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border p-1 shadow-md"
    >
      <p v-if="searching" role="status" class="text-muted-foreground px-2 py-1.5 text-xs">Searching…</p>
      <ul :id="listId" role="listbox" :aria-label="placeholder">
        <li
          v-for="(option, i) in options"
          :id="optionId(i)"
          :key="option.value ?? '__none__'"
          role="option"
          :aria-selected="i === active"
          class="flex cursor-default flex-col rounded-sm px-2 py-1.5 text-sm"
          :class="i === active ? 'bg-accent text-accent-foreground' : ''"
          @mousedown.prevent="choose(option)"
          @mousemove="active = i"
        >
          <span>{{ option.label }}</span>
          <span v-if="'description' in option && option.description" class="text-muted-foreground text-xs">{{ option.description }}</span>
        </li>
      </ul>
      <p v-if="searched && !searching && !found.length" class="text-muted-foreground px-2 py-1.5 text-sm">{{ emptyText }}</p>
    </div>
  </div>
</template>
