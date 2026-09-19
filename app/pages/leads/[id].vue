<script setup lang="ts">
import {
  LEAD_MANUAL_STATUSES,
  LEAD_INTEREST_LABELS,
  type LeadInterest,
  type LeadManualStatus,
} from "~~/shared/leads/constants";

/**
 * One lead: who they are, what they asked about, the notes thread, and
 * the status control.
 *
 * THE STATUS CONTROL NEVER OFFERS "CONVERTED". Converted means "became a
 * prospect", and that happens through one action — sending them the
 * intake form (phase 4) — which issues the link and threads the
 * provenance chain in the same move. Picking it from a dropdown would
 * record a conversion with no prospect behind it. The options come from
 * LEAD_MANUAL_STATUSES, the same list the status route accepts, so the
 * screen and the route cannot disagree. The convert action itself is
 * stubbed below until phase 4 lands, and says so on the screen.
 */
definePageMeta({ middleware: "can", permission: "leads.view" });
useSeoMeta({ title: "Lead — The Reserve" });

const route = useRoute();
const toast = useToast();
const { can } = usePermissions();
const id = route.params.id as string;

interface Detail {
  lead: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    interest: LeadInterest;
    source: string;
    status: string;
    consent: boolean;
    consent_at: string | null;
    created_at: string;
    updated_at: string;
  };
  notes: {
    id: string;
    body: string;
    created_at: string;
    author: { display_name: string } | null;
  }[];
}

const { data, refresh } = await useFetch<Detail>(`/api/leads/${id}`);
const lead = computed(() => data.value?.lead);
const notes = computed(() => data.value?.notes ?? []);
const canManage = computed(() => can("leads.manage"));
const converted = computed(() => lead.value?.status === "converted");

const STATUS_OPTIONS: { value: LeadManualStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "lost", label: "Lost" },
];

// ── status ─────────────────────────────────────────────────────────────
const savingStatus = ref(false);

/**
 * UiSelect binds a string; this computed's setter is the save. A value
 * outside LEAD_MANUAL_STATUSES cannot come from the control (it only
 * renders those), but the guard keeps a stray string from reaching the
 * route as if it were a choice.
 */
const statusModel = computed<string>({
  get: () => lead.value?.status ?? "new",
  set: (value) => {
    if (!(LEAD_MANUAL_STATUSES as readonly string[]).includes(value)) return;
    void setStatus(value as LeadManualStatus);
  },
});

async function setStatus(status: LeadManualStatus) {
  if (!lead.value || lead.value.status === status) return;
  savingStatus.value = true;
  try {
    await $fetch(`/api/leads/${id}/status`, { method: "POST", body: { status } });
    await refresh();
    toast.success("Status updated", STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status);
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error("Could not update status", err.data?.statusMessage ?? "Please try again.");
    await refresh();
  } finally {
    savingStatus.value = false;
  }
}

// ── notes ──────────────────────────────────────────────────────────────
const noteBody = ref("");
const savingNote = ref(false);

async function addNote() {
  const body = noteBody.value.trim();
  if (!body) return;
  savingNote.value = true;
  try {
    await $fetch(`/api/leads/${id}/notes`, { method: "POST", body: { body } });
    noteBody.value = "";
    await refresh();
    toast.success("Note added");
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error("Could not add note", err.data?.statusMessage ?? "Please try again.");
  } finally {
    savingNote.value = false;
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-8">
    <NuxtLink
      to="/leads"
      class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
    >
      <Icon name="lucide:chevron-left" class="size-4" aria-hidden="true" />
      Back to leads
    </NuxtLink>

    <div v-if="lead" class="mt-4">
      <h1 class="text-2xl font-semibold">{{ lead.first_name }} {{ lead.last_name }}</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        <a :href="`mailto:${lead.email}`" class="hover:underline">{{ lead.email }}</a>
        <template v-if="lead.phone">
          · <a :href="`tel:${lead.phone}`" class="hover:underline">{{ lead.phone }}</a>
        </template>
      </p>

      <!-- What they asked about, and where they came from -->
      <dl class="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border p-4 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-muted-foreground">Interested in</dt>
          <dd class="font-medium">{{ LEAD_INTEREST_LABELS[lead.interest] ?? lead.interest }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">Source</dt>
          <dd class="font-medium">{{ lead.source }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">Captured</dt>
          <dd class="font-medium">{{ when(lead.created_at) }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">Marketing consent</dt>
          <dd class="flex items-center gap-1.5 font-medium">
            <Icon
              :name="lead.consent ? 'lucide:circle-check' : 'lucide:circle-minus'"
              class="size-4"
              aria-hidden="true"
            />
            <span v-if="lead.consent && lead.consent_at">
              Given {{ new Date(lead.consent_at).toLocaleDateString("en-CA") }}
            </span>
            <span v-else>Not given</span>
          </dd>
        </div>
      </dl>

      <!-- Status + the conversion action -->
      <section class="mt-8 rounded-xl border p-4">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div class="w-full sm:w-64">
            <label class="text-sm font-medium" for="lead-status">Status</label>
            <div v-if="converted" class="mt-1.5 flex items-center gap-2 text-sm font-medium">
              <Icon name="lucide:arrow-right-circle" class="size-5" aria-hidden="true" />
              Converted
              <span class="text-muted-foreground font-normal">— they were sent the intake form</span>
            </div>
            <UiSelect v-else v-model="statusModel" :disabled="!canManage || savingStatus">
              <UiSelectTrigger id="lead-status" class="mt-1.5" />
              <UiSelectContent>
                <UiSelectItem
                  v-for="o in STATUS_OPTIONS"
                  :key="o.value"
                  :value="o.value"
                  :text="o.label"
                />
              </UiSelectContent>
            </UiSelect>
            <p v-if="!canManage && !converted" class="text-muted-foreground mt-1.5 text-xs">
              You can see this lead but not change it.
            </p>
          </div>

          <!-- The convert action. Stubbed: phase 4 wires it to the form-send
               flow, which issues the intake link, flips the lead to
               converted and threads prospect_intake.lead_id in one move.
               Shown disabled with the reason, rather than hidden, so the
               screen is honest about what it cannot yet do. -->
          <div v-if="canManage && !converted" class="text-right">
            <UiButton disabled>
              <Icon name="lucide:send" class="mr-1.5 size-4" aria-hidden="true" />
              Send intake form
            </UiButton>
            <p class="text-muted-foreground mt-1.5 text-xs">
              Converting a lead arrives with the next update.
            </p>
          </div>
        </div>
      </section>

      <!-- Notes: append-only, authored, dated -->
      <section class="mt-8">
        <h2 class="font-medium">Notes</h2>

        <div v-if="canManage" class="mt-3 rounded-xl border p-4">
          <label class="sr-only" for="lead-note">Add a note</label>
          <UiTextarea
            id="lead-note"
            v-model="noteBody"
            :rows="3"
            placeholder="e.g. Called, left a voicemail; try again Thursday"
            @keydown.meta.enter.prevent="addNote"
            @keydown.ctrl.enter.prevent="addNote"
          />
          <div class="mt-2 flex items-center justify-between gap-3">
            <p class="text-muted-foreground text-xs">Notes cannot be edited or deleted once added.</p>
            <UiButton
              size="sm"
              :disabled="savingNote || !noteBody.trim()"
              :text="savingNote ? 'Adding…' : 'Add note'"
              @click="addNote"
            />
          </div>
        </div>

        <p v-if="!notes.length" class="text-muted-foreground mt-3 text-sm">No notes yet.</p>
        <ul v-else class="mt-3 space-y-3">
          <li v-for="note in notes" :key="note.id" class="rounded-xl border p-4">
            <p class="text-sm whitespace-pre-wrap">{{ note.body }}</p>
            <p class="text-muted-foreground mt-2 text-xs">
              {{ note.author?.display_name ?? "Staff" }} · {{ when(note.created_at) }}
            </p>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
