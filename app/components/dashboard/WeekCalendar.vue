<script setup lang="ts">
const supabase = useSupabaseClient();

// ---------------------------------------------------------------------------
// Week state (weeks start Monday, like the reference design)
// ---------------------------------------------------------------------------
function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay(); // 0=Sun..6=Sat
  copy.setDate(copy.getDate() - ((day + 6) % 7)); // back to Monday
  return copy;
}
function toDateStr(d: Date) {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}

const weekStart = ref(startOfWeek(new Date()));
const selectedDate = ref(toDateStr(new Date()));
const todayStr = toDateStr(new Date());

const weekDays = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart.value);
    d.setDate(d.getDate() + i);
    return {
      dateStr: toDateStr(d),
      dayNum: d.getDate(),
      dayName: d.toLocaleDateString("en-US", { weekday: "short" }),
    };
  }),
);

const monthLabel = computed(() =>
  new Date(`${selectedDate.value}T12:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  }),
);

function shiftWeek(delta: number) {
  const d = new Date(weekStart.value);
  d.setDate(d.getDate() + delta * 7);
  weekStart.value = d;
  selectedDate.value = toDateStr(d); // select the Monday of the new week
}

// ---------------------------------------------------------------------------
// Appointments for the visible week (RLS scopes: providers see their own)
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
  "dashboard-week",
  async () => {
    const from = new Date(weekStart.value).toISOString();
    const endDate = new Date(weekStart.value);
    endDate.setDate(endDate.getDate() + 7);
    const { data, error } = await supabase
      .from("appointments")
      .select(
        "id, staff_id, starts_at, ends_at, status, client:clients(first_name, last_name), staff:staff!appointments_staff_id_fkey(display_name), appointment_services(name_snapshot)",
      )
      .gte("starts_at", from)
      .lt("starts_at", endDate.toISOString())
      .not("status", "in", "(cancelled)")
      .order("starts_at");
    if (error) throw error;
    return (data ?? []) as unknown as Appt[];
  },
  { watch: [weekStart] },
);

// Dot markers on the strip for days that have anything
const daysWithAppointments = computed(() => {
  const set = new Set<string>();
  for (const appt of appointments.value ?? []) {
    set.add(toDateStr(new Date(appt.starts_at)));
  }
  return set;
});

// From the selected date to the end of the week, grouped by day, empty days skipped
const groupedFromSelected = computed(() => {
  const groups: { dateStr: string; label: string; appts: Appt[] }[] = [];
  for (const day of weekDays.value) {
    if (day.dateStr < selectedDate.value) continue;
    const appts = (appointments.value ?? []).filter(
      (a) => toDateStr(new Date(a.starts_at)) === day.dateStr,
    );
    if (!appts.length) continue;
    const label =
      day.dateStr === todayStr
        ? "Today"
        : new Date(`${day.dateStr}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
    groups.push({ dateStr: day.dateStr, label, appts });
  }
  return groups;
});

// ---------------------------------------------------------------------------
// Deterministic "random" color per provider
// ---------------------------------------------------------------------------
const PALETTE = [
  "#0f9b8e", // teal
  "#5b6ee1", // indigo
  "#e8833a", // orange
  "#c85c8e", // rose
  "#7f9c3f", // olive
  "#8260a2", // violet
  "#b6975a", // gold
  "#4e8fbf", // steel blue
];

function providerColor(staffId: string): string {
  let hash = 0;
  for (let i = 0; i < staffId.length; i++) {
    hash = (hash * 31 + staffId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

function timeRange(appt: Appt) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${fmt(appt.starts_at)} - ${fmt(appt.ends_at)}`;
}
</script>

<template>
  <div class="rounded-2xl border bg-card p-5">
    <!-- Header: month + week nav -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">{{ monthLabel }}</h2>
      <div class="flex gap-1">
        <UiButton
          variant="outline"
          size="sm"
          aria-label="Previous week"
          @click="shiftWeek(-1)"
        >
          <Icon name="lucide:chevron-left" class="size-4" />
        </UiButton>
        <UiButton size="sm" aria-label="Next week" @click="shiftWeek(1)">
          <Icon name="lucide:chevron-right" class="size-4" />
        </UiButton>
      </div>
    </div>

    <!-- Week strip -->
    <div class="mt-5 grid grid-cols-7 text-center">
      <div v-for="day in weekDays" :key="day.dateStr">
        <p class="text-muted-foreground text-xs">{{ day.dayName }}</p>
        <button
          class="mt-2 inline-flex size-9 items-center justify-center rounded-full text-sm transition"
          :class="
            day.dateStr === selectedDate
              ? 'bg-primary text-primary-foreground font-semibold'
              : 'text-foreground hover:bg-secondary'
          "
          @click="selectedDate = day.dateStr"
        >
          {{ day.dayNum }}
        </button>
        <div class="mt-1 flex justify-center">
          <span
            v-if="
              daysWithAppointments.has(day.dateStr) &&
              day.dateStr !== selectedDate
            "
            class="bg-primary/50 size-1 rounded-full"
          />
        </div>
      </div>
    </div>

    <!-- Appointments, grouped by day from the selected date -->
    <div class="mt-5 space-y-5">
      <div v-for="group in groupedFromSelected" :key="group.dateStr">
        <div class="flex items-center gap-3">
          <p class="text-muted-foreground shrink-0 text-xs">
            {{ group.label }}
          </p>
          <div class="border-border/70 flex-1 border-t border-dashed" />
        </div>

        <ul class="mt-3 space-y-3">
          <li
            v-for="appt in group.appts"
            :key="appt.id"
            class="bg-secondary/40 relative overflow-hidden rounded-xl py-3 pl-4 pr-3"
          >
            <!-- Provider color bar -->
            <span
              class="absolute inset-y-0 left-0 w-1.5"
              :style="{ backgroundColor: providerColor(appt.staff_id) }"
              aria-hidden="true"
            />
            <p class="text-sm font-medium">
              {{
                appt.client
                  ? `${appt.client.first_name} ${appt.client.last_name}`
                  : "Client"
              }}
              <span class="text-muted-foreground font-normal">
                · {{ appt.appointment_services[0]?.name_snapshot }}
              </span>
            </p>
            <p class="text-muted-foreground mt-0.5 text-xs">
              {{ timeRange(appt) }}
              <span v-if="appt.staff"> · {{ appt.staff.display_name }}</span>
            </p>
          </li>
        </ul>
      </div>

      <p
        v-if="!groupedFromSelected.length"
        class="text-muted-foreground text-sm"
      >
        No appointments from this day through the end of the week.
      </p>
    </div>

    <NuxtLink
      to="/schedule"
      class="text-muted-foreground mt-5 block text-xs underline-offset-4 hover:underline"
    >
      Open full schedule →
    </NuxtLink>
  </div>
</template>
