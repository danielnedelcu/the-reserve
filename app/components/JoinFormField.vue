<script setup lang="ts">
import { useField } from "vee-validate";
import type { FormField } from "~~/shared/forms/fields";

/**
 * One question on the public form, wired to vee-validate.
 *
 * A component per field because useField has to run in setup, and the
 * questions are not known until the form version loads.
 *
 * Feedback is written for the person reading it, not the developer: the
 * message says what to do, it appears under the field it belongs to, and
 * it pairs an icon with text so it does not depend on colour. Validation
 * runs on blur rather than on every keystroke — telling someone their
 * email is wrong while they are still typing it is noise.
 */
const props = defineProps<{ field: FormField }>();

const { value, errorMessage, handleBlur, validate } = useField<unknown>(
  () => props.field.key,
  undefined,
  { validateOnValueUpdate: false },
);

/**
 * Validate on blur, explicitly.
 *
 * handleBlur only marks the field touched; whether that also validates
 * depends on global vee-validate config, and a validation that silently
 * does not run looks exactly like a field that is fine. Calling validate()
 * here makes the behaviour a property of this component rather than of a
 * setting somewhere else.
 */
async function onBlur(event: Event) {
  handleBlur(event);
  await validate();
}

/** Once a field has shown an error, re-check as they fix it. */
watch(value, () => {
  if (errorMessage.value) validate();
});

const describedBy = computed(() =>
  errorMessage.value ? `${props.field.key}-error` : undefined,
);
</script>

<template>
  <div>
    <label :for="field.key" class="block text-base font-medium text-reserve-ink">
      {{ field.label }}
      <span
        v-if="field.required"
        class="ml-1 text-sm font-semibold text-reserve-primary"
        >(required)</span
      >
    </label>
    <p v-if="field.help" class="mt-1 text-sm text-gray-600">{{ field.help }}</p>

    <UiTextarea
      v-if="field.type === 'textarea'"
      :id="field.key"
      v-model="value as string"
      :rows="4"
      :aria-invalid="!!errorMessage"
      :aria-describedby="describedBy"
      class="mt-2 text-base"
      @blur="onBlur"
    />

    <!-- Yes AND No. A lone tick box cannot say "no" — it can only fail to
         say "yes", which leaves the record unable to tell a no from a
         silence. Neither is preselected: the form must not answer for
         someone. -->
    <fieldset v-else-if="field.type === 'boolean'" class="mt-2">
      <legend class="sr-only">{{ field.label }}</legend>
      <div class="flex flex-wrap gap-3">
        <label
          v-for="choice in [
            { label: 'Yes', value: true },
            { label: 'No', value: false },
          ]"
          :key="String(choice.value)"
          class="has-[:checked]:border-reserve-primary has-[:checked]:bg-reserve-primary/5 flex min-w-24 cursor-pointer items-center gap-2.5 rounded-lg border border-gray-400 px-4 py-2.5 text-base text-gray-800 has-[:checked]:font-medium"
        >
          <input
            :id="`${field.key}-${choice.value}`"
            v-model="value"
            type="radio"
            :name="field.key"
            :value="choice.value"
            class="accent-reserve-primary size-4"
            @blur="onBlur"
          />
          {{ choice.label }}
        </label>
      </div>
    </fieldset>

    <select
      v-else-if="field.type === 'select'"
      :id="field.key"
      v-model="value as string"
      :aria-invalid="!!errorMessage"
      :aria-describedby="describedBy"
      class="focus:border-reserve-primary focus:ring-reserve-teal mt-2 w-full rounded-lg border border-gray-400 px-3 py-2.5 text-base focus:outline-none focus:ring-2"
      @blur="onBlur"
    >
      <option value="">Please choose…</option>
      <option v-for="option in field.options" :key="option" :value="option">
        {{ option }}
      </option>
    </select>

    <fieldset v-else-if="field.type === 'multiselect'" class="mt-2">
      <legend class="sr-only">{{ field.label }}</legend>
      <div class="space-y-2.5">
        <label
          v-for="option in field.options"
          :key="option"
          class="flex items-center gap-3 text-base text-gray-700"
        >
          <input
            v-model="value as string[]"
            type="checkbox"
            :value="option"
            class="accent-reserve-primary size-5"
            @blur="onBlur"
          />
          {{ option }}
        </label>
      </div>
    </fieldset>

    <UiInput
      v-else
      :id="field.key"
      v-model="value as string"
      :type="
        field.type === 'email'
          ? 'email'
          : field.type === 'date'
            ? 'date'
            : field.type === 'phone'
              ? 'tel'
              : 'text'
      "
      :aria-invalid="!!errorMessage"
      :aria-describedby="describedBy"
      class="mt-2 h-11 text-base"
      @blur="onBlur"
    />

    <p
      v-if="errorMessage"
      :id="`${field.key}-error`"
      class="text-reserve-primary mt-2 flex items-start gap-1.5 text-sm font-medium"
    >
      <Icon
        name="lucide:triangle-alert"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ errorMessage }}</span>
    </p>
  </div>
</template>
