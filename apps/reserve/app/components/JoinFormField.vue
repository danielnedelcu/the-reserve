<script setup lang="ts">
import { useField } from "vee-validate";
import { dateKey, parseDateKey, type FormField } from "~~/shared/forms/fields";

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

/**
 * Blur for a GROUP of controls (yes/no, the tick boxes): validate when focus
 * leaves the whole group, not when it hops from one option to the next —
 * otherwise clicking "No" after focusing "Yes" flashes "please answer" in
 * the instant between the two.
 */
function onGroupBlur(event: FocusEvent) {
  const group = event.currentTarget as HTMLElement;
  if (group.contains(event.relatedTarget as Node | null)) return;
  void onBlur(event);
}

/** A closed select is the moment the person is done with it. */
function onSelectOpen(open: boolean) {
  if (!open) void validate();
}

const describedBy = computed(() =>
  errorMessage.value ? `${props.field.key}-error` : undefined,
);

/**
 * Yes/No ↔ boolean bridge. reka-ui radio values are strings (AcceptableValue
 * has no boolean), while the answer contract, the Zod schema and the server
 * all speak boolean — and `false` MUST arrive as boolean false: it is the
 * answer "no", which an earlier version of this form silently dropped as
 * "unanswered". Unset stays undefined so an unanswered question stays
 * unanswered (isEmptyAnswer), never a default.
 */
/**
 * Date ↔ day-key bridge. The picker speaks Date; the answer is the
 * "YYYY-MM-DD" string the server validates with isRealDate. dateKey is the
 * only formatter allowed here, and the agreement test covers the days where
 * a UTC conversion would land on the wrong date.
 */
const dateModel = computed<Date | null>({
  get: () => parseDateKey(value.value),
  set: (picked) => {
    value.value = picked ? dateKey(picked) : undefined;
  },
});

const YES = "yes";
const NO = "no";
const yesNo = computed<string | undefined>({
  get: () => (value.value === true ? YES : value.value === false ? NO : undefined),
  set: (choice) => {
    value.value = choice === YES ? true : choice === NO ? false : undefined;
  },
});
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
    <fieldset
      v-else-if="field.type === 'boolean'"
      class="mt-2"
      :aria-describedby="describedBy"
      @focusout="onGroupBlur"
    >
      <legend class="sr-only">{{ field.label }}</legend>
      <UiRadioGroup
        v-model="yesNo"
        orientation="horizontal"
        class="flex flex-wrap gap-3"
        :aria-invalid="!!errorMessage"
      >
        <label
          v-for="choice in [
            { label: 'Yes', value: YES },
            { label: 'No', value: NO },
          ]"
          :key="choice.value"
          :for="`${field.key}-${choice.value}`"
          class="has-[[data-state=checked]]:border-reserve-primary has-[[data-state=checked]]:bg-reserve-primary/5 flex min-w-24 cursor-pointer items-center gap-2.5 rounded-lg border border-gray-400 px-4 py-2.5 text-base text-gray-800 has-[[data-state=checked]]:font-medium"
        >
          <UiRadioGroupItem
            :id="`${field.key}-${choice.value}`"
            :value="choice.value"
            class="size-5 border-gray-500 text-reserve-primary"
          />
          {{ choice.label }}
        </label>
      </UiRadioGroup>
    </fieldset>

    <!-- UiSelect binds strings, which is what a select answer is. Validation
         runs when the list CLOSES: the trigger's own blur fires as the list
         opens, which would flag a required question while the person is
         still choosing. -->
    <UiSelect
      v-else-if="field.type === 'select'"
      v-model="value as string"
      @update:open="onSelectOpen"
    >
      <UiSelectTrigger
        :id="field.key"
        placeholder="Please choose…"
        :aria-invalid="!!errorMessage"
        :aria-describedby="describedBy"
        class="mt-2 rounded-lg border-gray-400 text-base data-[size=default]:h-11"
      />
      <UiSelectContent>
        <UiSelectItem
          v-for="option in field.options"
          :key="option"
          :value="option"
          :text="option"
          class="py-2.5 text-base"
        />
      </UiSelectContent>
    </UiSelect>

    <!-- UiCheckboxGroup owns the array: each UiCheckbox inside it adds or
         removes its `value`, which is the push/remove behaviour native
         checkbox-array v-model used to provide. -->
    <fieldset
      v-else-if="field.type === 'multiselect'"
      class="mt-2"
      :aria-describedby="describedBy"
      @focusout="onGroupBlur"
    >
      <legend class="sr-only">{{ field.label }}</legend>
      <UiCheckboxGroup
        v-model="value as string[]"
        orientation="vertical"
        class="space-y-2.5"
        :aria-invalid="!!errorMessage"
      >
        <label
          v-for="option in field.options"
          :key="option"
          :for="`${field.key}-${option}`"
          class="flex cursor-pointer items-center gap-3 text-base text-gray-700"
        >
          <UiCheckbox
            :id="`${field.key}-${option}`"
            :value="option"
            class="size-5 border-gray-500 data-[state=checked]:border-reserve-primary data-[state=checked]:bg-reserve-primary"
          />
          {{ option }}
        </label>
      </UiCheckboxGroup>
    </fieldset>

    <!-- A date is TYPED first and picked second. For a date of birth the
         target is decades back, so a calendar alone means paging through
         hundreds of months; the input takes mm/dd/yyyy directly and the
         button opens the calendar (its title opens a month/year chooser)
         for anyone who prefers to look. The input's own click deliberately
         does NOT open the popover: on a phone that would stack a calendar
         on top of the keyboard. The button passes itself as the popover's
         anchor explicitly, so the calendar is positioned by the button
         however it was activated. Keyboard activation (a coordinate-less
         click) opens it and Escape closes it — verified 2026-09-12. -->
    <UiDatepicker
      v-else-if="field.type === 'date'"
      v-model="dateModel"
      mode="date"
      :masks="{ input: 'MM/DD/YYYY' }"
      :popover="{ visibility: 'click', placement: 'bottom-start' }"
      @popover-did-hide="validate()"
    >
      <template #default="{ inputValue, inputEvents, togglePopover }">
        <div class="relative mt-2">
          <UiInput
            :id="field.key"
            :model-value="inputValue"
            type="text"
            inputmode="numeric"
            autocomplete="bday"
            placeholder="mm/dd/yyyy"
            :aria-invalid="!!errorMessage"
            :aria-describedby="describedBy"
            class="h-11 pr-12 text-base"
            v-on="{
              input: inputEvents.input,
              change: inputEvents.change,
              keyup: inputEvents.keyup,
            }"
            @blur="onBlur"
          />
          <button
            type="button"
            class="text-gray-600 hover:text-reserve-primary focus-visible:ring-reserve-teal absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg outline-none focus-visible:ring-2"
            :aria-label="`Open a calendar to choose ${field.label}`"
            @click="togglePopover({ target: $event.currentTarget as HTMLElement })"
          >
            <Icon name="lucide:calendar" class="size-5" aria-hidden="true" />
          </button>
        </div>
      </template>
    </UiDatepicker>

    <UiInput
      v-else
      :id="field.key"
      v-model="value as string"
      :type="
        field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'
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
