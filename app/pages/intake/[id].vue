<script setup lang="ts">
/**
 * One prospect's submission, and the decision.
 *
 * THE SEAM LIVES HERE. The action is APPROVE, and approving creates
 * nothing — it records that this person is welcome to join. Becoming a
 * member means enrolling: choosing a tier and putting a card on file, at
 * the desk, with them present. That is §3 and owner-blocked, and it is a
 * separate action when it exists.
 *
 * There is no "create client" button on this page on purpose. One would be
 * easy to add and would quietly mint members who never paid, which is the
 * members-only invariant leaking through the screen meant to enforce it.
 * The banner below says so in the interface, not just in this comment,
 * because the next person to read the code may only read the screen.
 */
definePageMeta({ middleware: "can", permission: "forms.responses.view" });
useSeoMeta({ title: "New member — The Reserve" });

const route = useRoute();
const toast = useToast();
const id = route.params.id as string;

interface Detail {
  prospect: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    status: string;
    submitted_at: string;
    reviewed_at: string | null;
  };
  /** The lead this prospect came from, if any (§8 provenance). */
  lead: { id: string; first_name: string; last_name: string; source: string } | null;
  submission: {
    id: string;
    formName: string;
    version: number;
    consentText: string | null;
    consentedAt: string | null;
    submittedAt: string;
    answers: { key: string; label: string; value: unknown }[];
  } | null;
}

const { data, refresh } = await useFetch<Detail>(`/api/prospects/${id}`);
const saving = ref(false);

const prospect = computed(() => data.value?.prospect);
const decided = computed(
  () => prospect.value?.status === "approved" || prospect.value?.status === "rejected",
);

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

async function decide(status: "under_review" | "approved" | "rejected") {
  saving.value = true;
  try {
    await $fetch(`/api/prospects/${id}/review`, {
      method: "POST",
      body: { status },
    });
    await refresh();
    toast.success(
      status === "approved" ? "Approved" : status === "rejected" ? "Not approved" : "Marked as being reviewed",
      status === "approved"
        ? "They can be enrolled at the desk when they come in."
        : "Recorded.",
    );
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error("Could not save", err.data?.statusMessage ?? "Please try again.");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-8">
    <NuxtLink
      to="/intake"
      class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
    >
      <Icon name="lucide:chevron-left" class="size-4" aria-hidden="true" />
      Back to new members
    </NuxtLink>

    <div v-if="prospect" class="mt-4">
      <h1 class="text-2xl font-semibold">
        {{ prospect.first_name }} {{ prospect.last_name }}
      </h1>
      <p class="text-muted-foreground mt-1 text-sm">
        {{ prospect.email
        }}<span v-if="prospect.phone"> · {{ prospect.phone }}</span>
      </p>
      <!-- Provenance: the lead → prospect link, from the prospect's end. -->
      <p v-if="data?.lead" class="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
        <Icon name="lucide:megaphone" class="size-4" aria-hidden="true" />
        Came from a lead
        <NuxtLink :to="`/leads/${data.lead.id}`" class="font-medium hover:underline">
          {{ data.lead.first_name }} {{ data.lead.last_name }}
        </NuxtLink>
        · via {{ data.lead.source }}
      </p>

      <!-- What approving does, said plainly, on the screen where someone
           might otherwise assume it does more. -->
      <div class="mt-6 flex items-start gap-3 rounded-xl border p-4">
        <Icon
          name="lucide:info"
          class="mt-0.5 size-5 shrink-0"
          aria-hidden="true"
        />
        <div class="text-sm">
          <p class="font-medium">Approving does not create an account.</p>
          <p class="text-muted-foreground mt-1">
            It records that this person is welcome to join. They become a
            member when they enrol at the desk — choosing a membership and
            putting a card on file.
          </p>
        </div>
      </div>

      <!-- The submission -->
      <div v-if="data?.submission" class="mt-6 rounded-xl border">
        <div class="flex items-baseline justify-between border-b px-4 py-3">
          <h2 class="font-medium">{{ data.submission.formName }}</h2>
          <span class="text-muted-foreground text-xs">
            version {{ data.submission.version }}
          </span>
        </div>
        <dl class="divide-y">
          <div
            v-for="answer in data.submission.answers"
            :key="answer.key"
            class="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-3 sm:gap-4"
          >
            <dt class="text-muted-foreground text-sm">{{ answer.label }}</dt>
            <dd class="text-sm sm:col-span-2">{{ display(answer.value) }}</dd>
          </div>
        </dl>
        <div
          v-if="data.submission.consentedAt"
          class="text-muted-foreground border-t px-4 py-3 text-sm"
        >
          <Icon
            name="lucide:circle-check"
            class="mr-1.5 inline size-4"
            aria-hidden="true"
          />
          Agreed to the terms on
          {{ new Date(data.submission.consentedAt).toLocaleDateString("en-CA") }}
        </div>
      </div>

      <p class="text-muted-foreground mt-4 text-xs">
        Health answers are not shown here. They are kept with the treatment
        record and need the health-notes permission to read.
      </p>

      <!-- The decision -->
      <div class="mt-8 flex flex-wrap items-center gap-3">
        <template v-if="!decided">
          <UiButton :disabled="saving" @click="decide('approved')">
            <Icon name="lucide:circle-check" class="mr-1.5 size-4" />
            Approve
          </UiButton>
          <UiButton
            variant="outline"
            :disabled="saving"
            @click="decide('rejected')"
          >
            Not approved
          </UiButton>
          <UiButton
            v-if="prospect.status === 'submitted'"
            variant="ghost"
            :disabled="saving"
            @click="decide('under_review')"
          >
            Mark as being reviewed
          </UiButton>
        </template>

        <div v-else class="flex items-center gap-2 text-sm font-medium">
          <Icon
            :name="
              prospect.status === 'approved'
                ? 'lucide:circle-check'
                : 'lucide:circle-x'
            "
            class="size-5"
            aria-hidden="true"
          />
          <span>
            {{ prospect.status === "approved" ? "Approved" : "Not approved" }}
            <span
              v-if="prospect.reviewed_at"
              class="text-muted-foreground font-normal"
            >
              on
              {{ new Date(prospect.reviewed_at).toLocaleDateString("en-CA") }}
            </span>
          </span>
        </div>
      </div>

      <p
        v-if="prospect.status === 'approved'"
        class="text-muted-foreground mt-4 text-sm"
      >
        Next step happens in person: enrol them at the desk when they come in.
      </p>
    </div>
  </div>
</template>
