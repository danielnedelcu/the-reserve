<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "timeoff.approve" });
useSeoMeta({ title: "Time off — The Reserve" });

const supabase = useSupabaseClient();
const toast = useToast();

// ---------------------------------------------------------------------------
// Data
// NOTE: availability_exceptions has TWO foreign keys to staff (staff_id and
// created_by), so the embed must name the FK explicitly or PostgREST refuses
// with an "ambiguous relationship" error — the dashboard-widget lesson.
// ---------------------------------------------------------------------------
interface ExceptionRow {
  id: string;
  staff_id: string;
  starts_at: string;
  ends_at: string;
  kind: string;
  status: "requested" | "approved" | "denied";
  note: string | null;
  created_at: string;
  staff: { display_name: string } | null;
  requester: { display_name: string } | null;
}

const SELECT = `
  id, staff_id, starts_at, ends_at, kind, status, note, created_at,
  staff:staff!availability_exceptions_staff_id_fkey(display_name),
  requester:staff!availability_exceptions_created_by_fkey(display_name)
`;

const {
  data: pending,
  refresh: refreshPending,
  error: pendingError,
} = await useAsyncData("timeoff-pending", async () => {
  const { data, error } = await supabase
    .from("availability_exceptions")
    .select(SELECT)
    .eq("status", "requested")
    .order("starts_at");
  if (error) throw error;
  return (data ?? []) as unknown as ExceptionRow[];
});

const { data: upcoming, refresh: refreshUpcoming } = await useAsyncData(
  "timeoff-upcoming",
  async () => {
    const { data, error } = await supabase
      .from("availability_exceptions")
      .select(SELECT)
      .eq("status", "approved")
      .gte("ends_at", new Date().toISOString())
      .order("starts_at")
      .limit(20);
    if (error) throw error;
    return (data ?? []) as unknown as ExceptionRow[];
  },
);

const KIND_LABELS: Record<string, string> = {
  time_off: "Time off",
  sick: "Sick",
  break: "Break",
  extra_shift: "Extra shift",
};

function formatRange(startIso: string, endIso: string) {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return `${new Date(startIso).toLocaleString("en-US", opts)} → ${new Date(endIso).toLocaleString("en-US", opts)}`;
}

function requestedAgo(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
const decidingId = ref<string | null>(null);

async function decide(row: ExceptionRow, status: "approved" | "denied") {
  decidingId.value = row.id;
  const { error } = await supabase
    .from("availability_exceptions")
    .update({ status })
    .eq("id", row.id);
  decidingId.value = null;
  if (error) return toast.error("Could not update", error.message);
  toast.success(
    status === "approved" ? "Approved" : "Denied",
    `${row.staff?.display_name ?? "Staff"} · ${KIND_LABELS[row.kind] ?? row.kind}`,
  );
  await Promise.all([refreshPending(), refreshUpcoming()]);
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <h1 class="text-2xl font-semibold">Time off</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      Approve or deny requests. Approved time off is removed from bookable
      availability immediately; approved extra shifts add it.
    </p>

    <p v-if="pendingError" class="text-destructive mt-4 text-sm">
      Couldn't load requests: {{ pendingError.message }}
    </p>

    <!-- Pending requests -->
    <section class="mt-8">
      <div class="flex items-center gap-2">
        <h2 class="font-medium">Pending requests</h2>
        <span
          v-if="pending?.length"
          class="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-xs"
        >
          {{ pending.length }}
        </span>
      </div>

      <ul class="mt-3 space-y-2">
        <li
          v-for="row in pending"
          :key="row.id"
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4"
        >
          <div>
            <p class="text-sm font-medium">
              {{ row.staff?.display_name ?? "Staff" }}
              <span class="text-muted-foreground font-normal">
                · {{ KIND_LABELS[row.kind] ?? row.kind }}
              </span>
            </p>
            <p class="text-muted-foreground mt-0.5 text-xs">
              {{ formatRange(row.starts_at, row.ends_at) }}
              <span v-if="row.note"> · “{{ row.note }}”</span>
            </p>
            <p class="text-muted-foreground mt-0.5 text-xs">
              Requested {{ requestedAgo(row.created_at) }}
              <template
                v-if="
                  row.requester &&
                  row.requester.display_name !== row.staff?.display_name
                "
              >
                by {{ row.requester.display_name }}
              </template>
            </p>
          </div>
          <div class="flex gap-2">
            <UiButton
              size="sm"
              :disabled="decidingId === row.id"
              @click="decide(row, 'approved')"
            >
              Approve
            </UiButton>
            <UiButton
              size="sm"
              variant="outline"
              class="text-destructive"
              :disabled="decidingId === row.id"
              @click="decide(row, 'denied')"
            >
              Deny
            </UiButton>
          </div>
        </li>
        <li
          v-if="!pending?.length"
          class="text-muted-foreground rounded-xl border border-dashed px-5 py-6 text-center text-sm"
        >
          No pending requests — all caught up.
        </li>
      </ul>
    </section>

    <!-- Upcoming approved -->
    <section class="mt-10">
      <h2 class="font-medium">Upcoming approved time off</h2>
      <ul class="mt-3 space-y-2">
        <li
          v-for="row in upcoming"
          :key="row.id"
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-3"
        >
          <div>
            <p class="text-sm">
              <span class="font-medium">{{
                row.staff?.display_name ?? "Staff"
              }}</span>
              <span class="text-muted-foreground">
                · {{ KIND_LABELS[row.kind] ?? row.kind }} ·
                {{ formatRange(row.starts_at, row.ends_at) }}
              </span>
            </p>
          </div>
          <UiButton
            size="sm"
            variant="ghost"
            class="text-destructive"
            :disabled="decidingId === row.id"
            @click="decide(row, 'denied')"
          >
            Revoke
          </UiButton>
        </li>
        <li v-if="!upcoming?.length" class="text-muted-foreground text-sm">
          Nothing approved and upcoming.
        </li>
      </ul>
    </section>
  </div>
</template>
