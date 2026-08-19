<script setup lang="ts">
const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// Today's appointments (RLS scopes: providers see only their own)
// ---------------------------------------------------------------------------
interface Appt {
  id: string;
  staff_id: string;
  client_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  client: { first_name: string; last_name: string } | null;
  staff: { display_name: string } | null;
  appointment_services: { name_snapshot: string }[];
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

const { data: appointments, refresh } = await useAsyncData(
  "frontdesk-today",
  async () => {
    const { from, to } = todayRange();
    const { data, error } = await supabase
      .from("appointments")
      .select(
        "id, staff_id, client_id, starts_at, ends_at, status, client:clients(first_name, last_name), staff:staff!appointments_staff_id_fkey(display_name), appointment_services(name_snapshot)",
      )
      .gte("starts_at", from)
      .lt("starts_at", to)
      .not("status", "in", "(cancelled,no_show)")
      .order("starts_at");
    if (error) throw error;
    return (data ?? []) as unknown as Appt[];
  },
);

// Which of today's appointments are already paid (have a non-refund transaction)
const { data: paidIds, refresh: refreshPaid } = await useAsyncData(
  "frontdesk-paid",
  async () => {
    const ids = (appointments.value ?? []).map((appt) => appt.id);
    if (!ids.length) return new Set<string>();
    const { data } = await supabase
      .from("transactions")
      .select("appointment_id")
      .in("appointment_id", ids)
      .is("refunds_transaction_id", null);
    return new Set((data ?? []).map((t) => t.appointment_id as string));
  },
  { watch: [appointments] },
);

// ---------------------------------------------------------------------------
// The three lanes
// ---------------------------------------------------------------------------
const arriving = computed(() =>
  (appointments.value ?? []).filter((appt) =>
    ["booked", "confirmed"].includes(appt.status),
  ),
);
const inHouse = computed(() =>
  (appointments.value ?? []).filter((appt) =>
    ["checked_in", "in_progress"].includes(appt.status),
  ),
);
const readyToSettle = computed(() =>
  (appointments.value ?? []).filter(
    (appt) => appt.status === "completed" && !paidIds.value?.has(appt.id),
  ),
);
const settledCount = computed(
  () =>
    (appointments.value ?? []).filter(
      (appt) => appt.status === "completed" && paidIds.value?.has(appt.id),
    ).length,
);

const canAct = computed(
  () => can("appointments.edit.any") || can("appointments.edit.own"),
);
const canCheckout = computed(() => can("pos.checkout"));

// ---------------------------------------------------------------------------
// Inline transitions
// ---------------------------------------------------------------------------
const NEXT: Record<string, { to: string; label: string }> = {
  booked: { to: "checked_in", label: "Check in" },
  confirmed: { to: "checked_in", label: "Check in" },
  checked_in: { to: "in_progress", label: "Start" },
  in_progress: { to: "completed", label: "Complete" },
};

const actingId = ref<string | null>(null);

async function advance(appt: Appt) {
  const next = NEXT[appt.status];
  if (!next) return;
  actingId.value = appt.id;
  const { error } = await supabase
    .from("appointments")
    .update({ status: next.to })
    .eq("id", appt.id);
  actingId.value = null;
  if (error) return toast.error("Could not update", error.message);
  await Promise.all([refresh(), refreshPaid()]);
}

function clientName(appt: Appt) {
  return appt.client
    ? `${appt.client.first_name} ${appt.client.last_name}`
    : "Client";
}
function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_DOT: Record<string, string> = {
  booked: "bg-muted-foreground/40",
  confirmed: "bg-primary/60",
  checked_in: "bg-primary",
  in_progress: "bg-emerald-500",
};
</script>

<template>
  <div class="rounded-md border bg-card p-5">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">Today's appointments</h2>
      <p class="text-muted-foreground text-xs">
        {{ appointments?.length ?? 0 }} appointment{{
          (appointments?.length ?? 0) === 1 ? "" : "s"
        }}
        <span v-if="settledCount"> · {{ settledCount }} settled ✓</span>
      </p>
    </div>

    <!-- READY TO CHECK OUT: the money lane, always on top -->
    <section v-if="readyToSettle.length" class="mt-4">
      <p
        class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Ready to check out
      </p>
      <ul class="mt-2 space-y-2">
        <li
          v-for="appt in readyToSettle"
          :key="appt.id"
          class="border-primary/40 bg-primary/5 flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-2.5"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ clientName(appt) }}</p>
            <p class="text-muted-foreground truncate text-xs">
              {{ appt.appointment_services[0]?.name_snapshot }} ·
              {{ appt.staff?.display_name }} · finished
            </p>
          </div>
          <UiButton
            v-if="canCheckout"
            size="sm"
            :to="`/checkout?appointment=${appt.id}`"
          >
            <Icon name="lucide:credit-card" class="size-4" />
            Checkout
          </UiButton>
        </li>
      </ul>
    </section>

    <!-- IN THE BUILDING -->
    <section v-if="inHouse.length" class="mt-4">
      <p
        class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        In the building
      </p>
      <ul class="mt-2 space-y-2">
        <li
          v-for="appt in inHouse"
          :key="appt.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-2.5"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="size-2 shrink-0 rounded-full"
              :class="STATUS_DOT[appt.status]"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ clientName(appt) }}</p>
              <p class="text-muted-foreground truncate text-xs">
                {{ appt.appointment_services[0]?.name_snapshot }} ·
                {{ appt.staff?.display_name }} ·
                {{
                  appt.status === "in_progress"
                    ? `until ${timeLabel(appt.ends_at)}`
                    : "checked in"
                }}
              </p>
            </div>
          </div>
          <div class="flex gap-2">
            <UiButton
              v-if="canAct && NEXT[appt.status]"
              size="sm"
              variant="outline"
              :disabled="actingId === appt.id"
              @click="advance(appt)"
            >
              {{ NEXT[appt.status]!.label }}
            </UiButton>
            <UiButton
              v-if="canCheckout"
              size="sm"
              variant="ghost"
              :to="`/checkout?appointment=${appt.id}`"
            >
              Checkout
            </UiButton>
          </div>
        </li>
      </ul>
    </section>

    <!-- ARRIVING -->
    <section v-if="arriving.length" class="mt-4">
      <p
        class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Arriving
      </p>
      <ul class="mt-2 space-y-2">
        <li
          v-for="appt in arriving"
          :key="appt.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-2.5"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="size-2 shrink-0 rounded-full"
              :class="STATUS_DOT[appt.status]"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">
                {{ timeLabel(appt.starts_at) }} — {{ clientName(appt) }}
              </p>
              <p class="text-muted-foreground truncate text-xs">
                {{ appt.appointment_services[0]?.name_snapshot }} ·
                {{ appt.staff?.display_name }} ·
                <span class="capitalize">{{ appt.status }}</span>
              </p>
            </div>
          </div>
          <UiButton
            v-if="canAct"
            size="sm"
            variant="outline"
            :disabled="actingId === appt.id"
            @click="advance(appt)"
          >
            Check in
          </UiButton>
        </li>
      </ul>
    </section>

    <p
      v-if="!appointments?.length"
      class="text-muted-foreground mt-4 rounded-md border border-dashed px-4 py-6 text-center text-sm"
    >
      No appointments today.
    </p>
  </div>
</template>
