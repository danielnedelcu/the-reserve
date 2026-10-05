<script setup lang="ts">
import { useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import { isEmptyAnswer, type FormField } from "~~/shared/forms/fields";
import {
  buildAnswerSchema,
  requiredAnswersPresent,
} from "~~/shared/forms/validation";

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
 *
 * Validation is Zod, built from the SAME field descriptors and shared
 * predicates the server validates with (shared/forms/validation.ts). The
 * server still decides — this only means a person is told what is missing
 * while they can still fix it, instead of after pressing send.
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

const fields = computed<FormField[]>(() => form.value?.fields ?? []);

const { values, errors, handleSubmit, setFieldError } = useForm({
  validationSchema: computed(() => toTypedSchema(buildAnswerSchema(fields.value))),
  // Multiselects need an array to push into; nothing else is pre-answered.
  // A boolean starting at false would have answered a yes/no question on
  // the person's behalf, which for a health question is the difference
  // between saying no and saying nothing.
  initialValues: Object.fromEntries(
    (form.value?.fields ?? [])
      .filter((f) => f.type === "multiselect")
      .map((f) => [f.key, [] as string[]]),
  ),
});

const consented = ref(false);
const submitting = ref(false);
const submitted = ref(false);
const formError = ref("");

const loadErrorMessage = computed(
  () =>
    (loadError.value?.data as { statusMessage?: string } | undefined)
      ?.statusMessage ?? "This link is no longer valid.",
);

const consentNeeded = computed(() => !!form.value?.consentText);

/**
 * Whether the button is live.
 *
 * Three conditions, and the first is the one that matters: every required
 * question actually answered, judged by the SHARED definition of
 * "answered" — so a required yes/no satisfied with "no" counts, which an
 * earlier version of this page got wrong.
 */
const canSend = computed(
  () =>
    requiredAnswersPresent(fields.value, values) &&
    Object.keys(errors.value).length === 0 &&
    (!consentNeeded.value || consented.value) &&
    !submitting.value,
);

const submit = handleSubmit(async (validated) => {
  formError.value = "";
  submitting.value = true;
  try {
    // Unanswered optional questions are left out entirely rather than sent
    // as "". isEmptyAnswer is the same test the server applies, so the two
    // cannot disagree about what counts as an answer — notably `false`,
    // which is the answer "no" and must survive this filter.
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(validated)) {
      if (!isEmptyAnswer(value)) payload[key] = value;
    }

    await $fetch(`/api/public/forms/${token}/submit`, {
      method: "POST",
      body: { answers: payload, consented: consented.value },
    });
    submitted.value = true;
  } catch (e: unknown) {
    const err = e as {
      data?: { statusMessage?: string; data?: { fieldKey?: string | null } };
    };
    const fieldKey = err.data?.data?.fieldKey ?? null;
    const message =
      err.data?.statusMessage ??
      "Something went wrong sending your answers. Please try again.";
    // The server names the field it rejected — put its message where that
    // question is, not in a banner the reader has to match up themselves.
    if (fieldKey && fields.value.some((f) => f.key === fieldKey)) {
      setFieldError(fieldKey, message);
    } else {
      formError.value = message;
    }
  } finally {
    submitting.value = false;
  }
});
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
          <JoinFormField
            v-for="field in fields"
            :key="field.key"
            :field="field"
          />
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
          v-if="formError"
          class="mt-6 flex items-start gap-2 rounded-lg bg-gray-50 p-4 text-base font-medium text-reserve-ink"
        >
          <Icon
            name="lucide:triangle-alert"
            class="mt-0.5 size-5 shrink-0 text-reserve-primary"
            aria-hidden="true"
          />
          <span>{{ formError }}</span>
        </p>

        <!-- Brand purple rather than the app's neutral primary. Staff
             screens keep the default; this page is a prospect's first
             contact with The Reserve, so it carries the brand. White on
             #572e72 clears AA contrast comfortably. -->
        <UiButton
          type="submit"
          :disabled="!canSend"
          class="mt-8 h-12 w-full bg-reserve-primary text-base text-white hover:bg-reserve-primary/90"
        >
          {{ submitting ? "Sending…" : "Send my answers" }}
        </UiButton>

        <!-- Why the button is off, said plainly. A disabled control with no
             explanation is the worst version of this pattern: the reader
             cannot tell whether they missed something or the page broke. -->
        <p v-if="!canSend && !submitting" class="mt-3 text-center text-sm text-gray-600">
          <template v-if="!requiredAnswersPresent(fields, values)">
            Please answer the questions marked required.
          </template>
          <template v-else-if="Object.keys(errors).length">
            Please check the highlighted answers above.
          </template>
          <template v-else-if="consentNeeded && !consented">
            Please tick the box to agree.
          </template>
        </p>

        <p class="mt-4 text-center text-sm text-gray-600">
          You can only send this form once.
        </p>
      </form>
    </div>
  </div>
</template>
