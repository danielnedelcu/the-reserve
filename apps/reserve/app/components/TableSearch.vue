<script setup lang="ts">
/**
 * The search box above a server-side table. It waits about 300ms after
 * typing stops before searching (useServerTable cancels any search still
 * running), and follows the table's value when it changes another way
 * (Back, Clear) unless you're typing in it.
 */
const props = withDefaults(
  defineProps<{
    value: string;
    id?: string;
    placeholder?: string;
    hint?: string;
  }>(),
  { id: "table-search", placeholder: "Search", hint: "Results update as you type." },
);
const emit = defineEmits<{ search: [q: string] }>();

const text = ref(props.value);
const focused = ref(false);
watch(
  () => props.value,
  (v) => {
    if (!focused.value) text.value = v;
  },
);
let timer: ReturnType<typeof setTimeout> | undefined;
function onInput() {
  clearTimeout(timer);
  timer = setTimeout(() => emit("search", text.value), 300);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="w-full max-w-xs">
    <UiInput
      :id="id"
      v-model="text"
      type="search"
      :placeholder="placeholder"
      :aria-label="placeholder"
      :aria-describedby="`${id}-hint`"
      @input="onInput"
      @focus="focused = true"
      @blur="focused = false"
    />
    <p :id="`${id}-hint`" class="sr-only">{{ hint }}</p>
  </div>
</template>
