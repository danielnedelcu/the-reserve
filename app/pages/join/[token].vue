<script setup lang="ts">
import type { FormField } from "~~/shared/forms/fields";

/**
 * The public form page — where a prospect fills in their intake, or a
 * client signs a waiver. Reached by a tokenized link, no account.
 *
 * Written for the people who actually land here: often older, sometimes
 * low-vision, frequently not confident with forms, and doing this on a
 * phone in a car park before an appointment. So: one column, large type,
 * every requirement stated in words rather than implied by an asterisk or
 * a colour, and errors that say what to do next. Nothing on this page
 * relies on colour alone to carry meaning.
 */
definePageMeta({ layout: false });

const route = useRoute();
const token = route.params.token as string;

interface PublicForm {
  organizationName: string;
  formName: string;
  formDescription: string | null;
  version: number;
  consentText: string | null;
  fields: FormField[];
}

const { data: form, error: loadError } = await useFetch<PublicForm>(
  `/api/public/forms/${token}`,
);

const answers = reactive<Record<string, string | boolean | string[]>>({});
const consented = ref(false);
const submitting = ref(false);
const submitted = ref(false);
const errorMessage = ref("");
const errorFieldKey = ref<string | null>(null);

// Multiselect answers need an array to push into before anything is picked.
for (const field of form.value?.fields ?? []) {
  if (field.type === "multiselect") answers[field.key] = [];
  else if (field.type === "boolean") answers[field.key] = false;
}

const loadErrorMessage = computed(
  () =>
    (loadError.value?.data as { statusMessage?: string } | undefined)
      ?.statusMessage ?? "This link is no longer valid.",
);

function toggleChoice(key: string, option: string, checked: boolean) {
  const current = (answers[key] as string[] | undefined) ?? [];
  answers[key] = checked
    ? [...current, option]
    : current.filter((v) => v !== option);
}

async function submit() {
  errorMessage.value = "";
  errorFieldKey.value = null;

  if (form.value?.consentText && !consented.value) {
    errorMessage.value = "Please tick the box to agree before sending.";
    return;
  }

  submitting.value = true;
  try {
    // Empty answers are dropped rather than sent as "": the server treats
    // blank as unanswered anyway, and sending them would fail validation
    // on optional fields that have a type.
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(answers)) {
      const empty =
        value === "" ||
        value === false ||
        (Array.isArray(value) && value.length === 0);
      if (!empty) payload[key] = value;
    }

    await $fetch(`/api/public/forms/${token}/submit`, {
      method: "POST",
      body: { answers: payload, consented: consented.value },
    });
    submitted.value = true;
  } catch (e: unknown) {
    const err = e as {
      statusCode?: number;
      data?: { statusMessage?: string; data?: { fieldKey?: string | null } };
    };
    errorFieldKey.value = err.data?.data?.fieldKey ?? null;
    errorMessage.value =
      err.data?.statusMessage ??
      "Something went wrong sending your answers. Please try again.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-reserve-ink px-4 py-10">
    <div class="mx-auto w-full max-w-xl">
      <p
        class="text-center text-xs uppercase tracking-[0.35em] text-reserve-teal"
      >
        {{ form?.organizationName || "The Reserve" }}
      </p>

      <!-- Link is expired, used, or was never real. One message for all
           three: the person's next step is identical, and distinguishing
           them would confirm to a stranger which tokens exist. -->
      <div
        v-if="loadError"
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:link-2-off"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">
          This link cannot be opened
        </h1>
        <p class="mt-3 text-base text-gray-700">{{ loadErrorMessage }}</p>
        <p class="mt-3 text-base text-gray-700">
          Please call us or ask at the front desk, and we will send you a new
          one.
        </p>
      </div>

      <!-- Sent. No detail about what was stored or who reads it. -->
      <div
        v-else-if="submitted"
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:circle-check"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">Thank you</h1>
        <p class="mt-3 text-base text-gray-700">
          We have your answers. There is nothing else for you to do.
        </p>
        <p class="mt-3 text-base text-gray-700">
          We will talk it through with you when you come in.
        </p>
      </div>

      <!-- The form -->
      <form
        v-else
        class="mt-8 rounded-2xl bg-white p-6 shadow-xl shadow-black/30 sm:p-8"
        @submit.prevent="submit"
      >
        <h1 class="text-2xl font-semibold text-reserve-ink">
          {{ form?.formName }}
        </h1>
        <p v-if="form?.formDescription" class="mt-2 text-base text-gray-700">
          {{ form.formDescription }}
        </p>
        <p class="mt-2 text-base text-gray-600">
          Questions marked <span class="font-semibold">required</span> must be
          answered. The rest are up to you.
        </p>

        <div class="mt-8 space-y-7">
          <div v-for="field in form?.fields ?? []" :key="field.key">
            <label
              :for="field.key"
              class="block text-base font-medium text-reserve-ink"
            >
              {{ field.label }}
              <span
                v-if="field.required"
                class="ml-1 text-sm font-semibold text-reserve-primary"
                >(required)</span
              >
            </label>
            <p v-if="field.help" class="mt-1 text-sm text-gray-600">
              {{ field.help }}
            </p>

            <UiTextarea
              v-if="field.type === 'textarea'"
              :id="field.key"
              v-model="answers[field.key] as string"
              :rows="4"
              class="mt-2 text-base"
            />

            <div
              v-else-if="field.type === 'boolean'"
              class="mt-2 flex items-center gap-3"
            >
              <UiCheckbox
                :id="field.key"
                v-model="answers[field.key] as boolean"
                class="size-5"
              />
              <label :for="field.key" class="text-base text-gray-700">Yes</label>
            </div>

            <div v-else-if="field.type === 'select'" class="mt-2">
              <select
                :id="field.key"
                v-model="answers[field.key] as string"
                class="w-full rounded-lg border border-gray-400 px-3 py-2.5 text-base focus:border-reserve-primary focus:outline-none focus:ring-2 focus:ring-reserve-teal"
              >
                <option value="">Please choose…</option>
                <option v-for="option in field.options" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
            </div>

            <fieldset v-else-if="field.type === 'multiselect'" class="mt-2">
              <legend class="sr-only">{{ field.label }}</legend>
              <div class="space-y-2.5">
                <div
                  v-for="option in field.options"
                  :key="option"
                  class="flex items-center gap-3"
                >
                  <UiCheckbox
                    :id="`${field.key}-${option}`"
                    class="size-5"
                    :model-value="((answers[field.key] as string[]) ?? []).includes(option)"
                    @update:model-value="
                      (checked) => toggleChoice(field.key, option, checked === true)
                    "
                  />
                  <label
                    :for="`${field.key}-${option}`"
                    class="text-base text-gray-700"
                    >{{ option }}</label
                  >
                </div>
              </div>
            </fieldset>

            <UiInput
              v-else
              :id="field.key"
              v-model="answers[field.key] as string"
              :type="
                field.type === 'email'
                  ? 'email'
                  : field.type === 'date'
                    ? 'date'
                    : field.type === 'phone'
                      ? 'tel'
                      : 'text'
              "
              class="mt-2 h-11 text-base"
            />

            <!-- The field the server named, called out in words as well as
                 position, since a coloured border alone would not read. -->
            <p
              v-if="errorFieldKey === field.key"
              class="mt-2 flex items-start gap-1.5 text-sm font-medium text-reserve-primary"
            >
              <Icon
                name="lucide:triangle-alert"
                class="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{{ errorMessage }}</span>
            </p>
          </div>
        </div>

        <!-- Consent, when this version carries any -->
        <div v-if="form?.consentText" class="mt-8 border-t border-gray-200 pt-6">
          <div
            class="max-h-56 overflow-y-auto rounded-lg bg-gray-50 p-4 text-base leading-relaxed text-gray-800"
          >
            {{ form.consentText }}
          </div>
          <div class="mt-4 flex items-start gap-3">
            <UiCheckbox id="consent" v-model="consented" class="mt-0.5 size-5" />
            <label for="consent" class="text-base text-gray-800">
              I have read the above and I agree.
              <span class="font-semibold text-reserve-primary">(required)</span>
            </label>
          </div>
        </div>

        <p
          v-if="errorMessage && !errorFieldKey"
          class="mt-6 flex items-start gap-2 rounded-lg bg-gray-50 p-4 text-base font-medium text-reserve-ink"
        >
          <Icon
            name="lucide:triangle-alert"
            class="mt-0.5 size-5 shrink-0 text-reserve-primary"
            aria-hidden="true"
          />
          <span>{{ errorMessage }}</span>
        </p>

        <!-- Brand purple rather than the app's neutral primary. Staff
             screens keep the default; this page is a prospect's first
             contact with The Reserve, so it carries the brand. White on
             #572e72 clears AA contrast comfortably. -->
        <UiButton
          type="submit"
          :disabled="submitting"
          class="mt-8 h-12 w-full bg-reserve-primary text-base text-white hover:bg-reserve-primary/90"
        >
          {{ submitting ? "Sending…" : "Send my answers" }}
        </UiButton>

        <p class="mt-4 text-center text-sm text-gray-600">
          You can only send this form once.
        </p>
      </form>
    </div>
  </div>
</template>
