<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "clients.view" });

const route = useRoute();
const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();
const clientId = route.params.id as string;

// ---------------------------------------------------------------------------
// Client (with preferred provider name)
// ---------------------------------------------------------------------------
const { data: client } = await useAsyncData(`client-${clientId}`, async () => {
  const { data, error } = await supabase
    .from("clients")
    .select(
      "*, preferred_staff:staff!clients_preferred_staff_id_fkey(display_name)",
    )
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
});

useSeoMeta({
  title: () =>
    client.value
      ? `${client.value.first_name} ${client.value.last_name} — The Reserve`
      : "Client — The Reserve",
});

const CONTACT_LABELS: Record<string, string> = {
  email: "Email",
  phone: "Phone call",
  sms: "Text message",
};

const address = computed(() => {
  const c = client.value;
  if (!c) return null;
  const line = [c.address_line1, c.address_line2].filter(Boolean).join(", ");
  const cityLine = [c.city, c.state, c.postal_code].filter(Boolean).join(", ");
  const full = [line, cityLine].filter(Boolean).join(" · ");
  return full || null;
});

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDob(dateStr: string) {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Notes — preference/internal read directly (RLS filters); health notes read
// via the audited server route so every access leaves an audit trail.
// ---------------------------------------------------------------------------
interface Note {
  id: string;
  kind: "preference" | "health" | "internal";
  body: string;
  created_at: string;
  author?: { display_name: string } | null;
}

const { data: generalNotes, refresh: refreshGeneral } = await useAsyncData(
  `client-notes-${clientId}`,
  async () => {
    const { data, error } = await supabase
      .from("client_notes")
      .select("id, kind, body, created_at, author:staff(display_name)")
      .eq("client_id", clientId)
      .neq("kind", "health")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as Note[];
  },
);

const canSeeHealth = computed(() => can("clients.notes.health.view"));

const { data: healthNotes, refresh: refreshHealth } = await useAsyncData(
  `client-health-notes-${clientId}`,
  async () => {
    if (!canSeeHealth.value) return [];
    return await $fetch<Note[]>(`/api/clients/${clientId}/health-notes`);
  },
);

const noteBody = ref("");
const noteKind = ref<"preference" | "internal" | "health">("preference");
const savingNote = ref(false);

const kindOptions = computed(() => {
  const opts: { value: string; label: string }[] = [
    { value: "preference", label: "Preference" },
    { value: "internal", label: "Internal" },
  ];
  if (can("clients.notes.health.create")) {
    opts.push({ value: "health", label: "Health (restricted)" });
  }
  return opts;
});

async function addNote() {
  if (!noteBody.value.trim()) return;
  savingNote.value = true;
  const { data: staffId } = await supabase.rpc("current_staff_id");
  const { error } = await supabase.from("client_notes").insert({
    client_id: clientId,
    author_id: staffId,
    kind: noteKind.value,
    body: noteBody.value.trim(),
  });
  savingNote.value = false;
  if (error) return toast.error("Could not add note", error.message);
  toast.success("Note added");
  noteBody.value = "";
  if (noteKind.value === "health") await refreshHealth();
  else await refreshGeneral();
}

const kindBadge: Record<string, string> = {
  preference: "bg-secondary text-muted-foreground",
  internal: "bg-secondary text-muted-foreground",
  health: "bg-destructive/10 text-destructive",
};
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <NuxtLink
      to="/clients"
      class="text-muted-foreground text-sm hover:underline"
    >
      ← All clients
    </NuxtLink>

    <div v-if="!client" class="text-muted-foreground mt-10">
      Client not found (or you don't have access).
    </div>

    <template v-else>
      <div class="mt-4 flex items-start justify-between">
        <div>
          <h1 class="text-2xl font-semibold">
            {{ client.first_name }} {{ client.last_name }}
            <span
              v-if="client.pronouns"
              class="text-muted-foreground text-base font-normal"
            >
              ({{ client.pronouns }})
            </span>
          </h1>
          <p class="text-muted-foreground mt-1 text-sm">
            Client since {{ formatDate(client.created_at) }}
            <span v-if="!client.active"> · Inactive</span>
          </p>
        </div>
        <span
          v-if="client.no_show_count > 0"
          class="bg-destructive/10 text-destructive rounded-full px-3 py-1 text-xs"
        >
          {{ client.no_show_count }} no-show{{
            client.no_show_count > 1 ? "s" : ""
          }}
        </span>
      </div>

      <!-- Contact & details -->
      <section
        class="mt-6 grid gap-x-6 gap-y-4 rounded-md border bg-card p-5 sm:grid-cols-3"
      >
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Email
          </p>
          <p class="mt-1 text-sm">{{ client.email ?? "—" }}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Phone
          </p>
          <p class="mt-1 text-sm">{{ client.phone ?? "—" }}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Prefers
          </p>
          <p class="mt-1 text-sm">
            {{ CONTACT_LABELS[client.preferred_contact_method] ?? "—" }}
          </p>
        </div>
        <div class="sm:col-span-2">
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Address
          </p>
          <p class="mt-1 text-sm">{{ address ?? "—" }}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Date of birth
          </p>
          <p class="mt-1 text-sm">
            {{ client.date_of_birth ? formatDob(client.date_of_birth) : "—" }}
          </p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Emergency contact
          </p>
          <p class="mt-1 text-sm">
            {{ client.emergency_contact_name ?? "—" }}
            <span
              v-if="client.emergency_contact_phone"
              class="text-muted-foreground"
            >
              · {{ client.emergency_contact_phone }}
            </span>
          </p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Preferred provider
          </p>
          <p class="mt-1 text-sm">
            {{ client.preferred_staff?.display_name ?? "No preference" }}
          </p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Marketing
          </p>
          <p class="mt-1 text-sm">
            {{ client.marketing_opt_in ? "Opted in" : "Not opted in" }}
          </p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Referral source
          </p>
          <p class="mt-1 text-sm">{{ client.referral_source ?? "—" }}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs uppercase tracking-wide">
            Flags
          </p>
          <p class="mt-1 text-sm">
            {{
              client.flags?.requires_card_on_file
                ? "Card on file required"
                : "—"
            }}
          </p>
        </div>
      </section>

      <!-- Appointments (lights up when the calendar ships) -->
      <section class="mt-8">
        <h2 class="font-medium">Appointments</h2>
        <p class="text-muted-foreground mt-2 text-sm">
          Appointment history will appear here once scheduling is live.
        </p>
      </section>

      <!-- Notes -->
      <section class="mt-8">
        <h2 class="font-medium">Notes</h2>

        <div class="mt-3 rounded-md border bg-card p-4">
          <div class="flex flex-wrap items-start gap-3">
            <UiSelect v-model="noteKind">
              <UiSelectTrigger
                id="note-kind"
                class="mt-1.5 sm:max-w-48"
                placeholder="Note type"
              />
              <UiSelectContent>
                <UiSelectItem value="preference" text="Preference" />
                <UiSelectItem value="internal" text="Internal" />
                <UiSelectItem
                  v-if="canSeeHealth"
                  value="health"
                  text="Health (restricted)"
                />
              </UiSelectContent>
            </UiSelect>
            <textarea
              v-model="noteBody"
              rows="2"
              placeholder="e.g. Prefers firm pressure; allergic to lavender"
              class="border-input min-w-0 flex-1 rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <UiButton
              size="sm"
              :disabled="savingNote || !noteBody.trim()"
              :text="savingNote ? 'Adding…' : 'Add note'"
              @click="addNote"
            />
          </div>
          <p v-if="noteKind === 'health'" class="text-destructive mt-2 text-xs">
            Health notes are visible only to providers and admins, and every
            read is audit-logged.
          </p>
        </div>

        <template v-if="canSeeHealth && healthNotes?.length">
          <h3 class="text-destructive mt-5 text-sm font-medium">
            Health notes
          </h3>
          <ul class="mt-2 space-y-2">
            <li
              v-for="note in healthNotes"
              :key="note.id"
              class="border-destructive/30 rounded-md border bg-card p-3"
            >
              <p class="text-sm">{{ note.body }}</p>
              <p class="text-muted-foreground mt-1 text-xs">
                {{ note.author?.display_name ?? "Staff" }} ·
                {{ formatDate(note.created_at) }}
              </p>
            </li>
          </ul>
        </template>

        <ul class="mt-4 space-y-2">
          <li
            v-for="note in generalNotes"
            :key="note.id"
            class="rounded-md border bg-card p-3"
          >
            <div class="flex items-center gap-2">
              <span
                class="rounded-full px-2 py-0.5 text-xs"
                :class="kindBadge[note.kind]"
              >
                {{ note.kind }}
              </span>
              <p class="text-muted-foreground text-xs">
                {{ note.author?.display_name ?? "Staff" }} ·
                {{ formatDate(note.created_at) }}
              </p>
            </div>
            <p class="mt-2 text-sm">{{ note.body }}</p>
          </li>
          <li
            v-if="!generalNotes?.length && !healthNotes?.length"
            class="text-muted-foreground text-sm"
          >
            No notes yet.
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
