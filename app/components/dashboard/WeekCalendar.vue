<script setup lang="ts">
const supabase = useSupabaseClient();

function toDateStr(d: Date) {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}

const selectedDate = ref(toDateStr(new Date()));
const todayStr = toDateStr(new Date());

// ---------------------------------------------------------------------------
// Appointments for a rolling window (±5 weeks around today).
// The weekly calendar pages freely; a generous window keeps dots accurate
// for normal browsing without wiring into v-calendar's page events.
// ---------------------------------------------------------------------------
interface Appt {
  id: string;
  staff_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  client: { first_name: string; last_name: string } | null;
  staff: { display_name: string } | null;
  appointment_services: { name_snapshot: string }[];
}

const { data: appointments } = await useAsyncData(
  "dashboard-window",
  async () => {
    const from = new Date();
    from.setDate(from.getDate() - 14);
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setDate(to.getDate() + 35);
    const { data, error } = await supabase
      .from("appointments")
      .select(
        "id, staff_id, starts_at, ends_at, status, client:clients(first_name, last_name), staff:staff!appointments_staff_id_fkey(display_name), appointment_services(name_snapshot)",
      )
      .gte("starts_at", from.toISOString())
      .lt("starts_at", to.toISOString())
      .not("status", "in", "(cancelled)")
      .order("starts_at");
    if (error) throw error;
    return (data ?? []) as unknown as Appt[];
  },
);

// ---------------------------------------------------------------------------
// Calendar attributes: one dot per provider per day, in the provider's color,
// with a popover naming them. Multiple providers stack multiple dots.
// ---------------------------------------------------------------------------
const attributes = computed(() => {
  // day -> provider -> { name, count }
  const byDay = new Map<string, Map<string, { name: string; count: number }>>();
  for (const appt of appointments.value ?? []) {
    const day = toDateStr(new Date(appt.starts_at));
    const providers = byDay.get(day) ?? new Map();
    const entry = providers.get(appt.staff_id) ?? {
      name: appt.staff?.display_name ?? "Provider",
      count: 0,
    };
    entry.count += 1;
    providers.set(appt.staff_id, entry);
    byDay.set(day, providers);
  }

  const attrs: Record<string, unknown>[] = [];
  for (const [day, providers] of byDay) {
    for (const [staffId, entry] of providers) {
      attrs.push({
        dates: new Date(`${day}T12:00:00`),
        dot: { style: { backgroundColor: providerColor(staffId) } },
        popover: {
          label: `${entry.name} · ${entry.count} appointment${entry.count === 1 ? "" : "s"}`,
        },
      });
    }
  }
  return attrs;
});

function onDayClick(day: { id: string }) {
  selectedDate.value = day.id; // v-calendar day ids are YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// The selected day's appointments
// ---------------------------------------------------------------------------
const dayAppointments = computed(() =>
  (appointments.value ?? []).filter(
    (appt) => toDateStr(new Date(appt.starts_at)) === selectedDate.value,
  ),
);

const dayLabel = computed(() =>
  selectedDate.value === todayStr
    ? "Today"
    : new Date(`${selectedDate.value}T12:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
);

function timeRange(appt: Appt) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  return `${fmt(appt.starts_at)} – ${fmt(appt.ends_at)}`;
}
</script>

<template>
  <div class="rounded-md border bg-card p-5">
    <!-- Weekly calendar: dots per provider, click a day to list it below -->
    <UiCalendar
      view="weekly"
      borderless
      title-position="left"
      transparent
      expanded
      :attributes="attributes"
      @dayclick="onDayClick"
    />

    <!-- Selected day's appointments -->
    <div class="mt-4">
      <div class="flex items-center gap-3">
        <p class="text-muted-foreground shrink-0 text-xs font-medium">
          {{ dayLabel }}
        </p>
        <div class="border-border/70 flex-1 border-t border-dashed" />
      </div>

      <ul class="mt-3 space-y-3">
        <li v-for="appt in dayAppointments" :key="appt.id">
          <UiCard class="relative overflow-hidden rounded-md py-3">
            <div
              class="absolute inset-y-0 left-0 w-1"
              :style="{ backgroundColor: providerColor(appt.staff_id) }"
              aria-hidden="true"
            />
            <UiCardContent class="px-4 py-0 pl-5">
              <p class="text-xs font-medium flex flex-col">
                {{
                  appt.client
                    ? `${appt.client.first_name} ${appt.client.last_name}`
                    : "Client"
                }}
                <span class="text-muted-foreground font-normal">
                  {{ appt.appointment_services[0]?.name_snapshot }}
                </span>
              </p>
              <p class="text-muted-foreground mt-0.5 text-xs">
                {{ timeRange(appt) }}
                <span v-if="appt.staff"> · {{ appt.staff.display_name }}</span>
              </p>
            </UiCardContent>
          </UiCard>
        </li>
        <li
          v-if="!dayAppointments.length"
          class="text-muted-foreground text-sm"
        >
          No appointments this day.
        </li>
      </ul>
    </div>

    <NuxtLink
      to="/schedule"
      class="text-muted-foreground mt-5 block text-xs underline-offset-4 hover:underline"
    >
      Open full schedule →
    </NuxtLink>
  </div>
</template>
