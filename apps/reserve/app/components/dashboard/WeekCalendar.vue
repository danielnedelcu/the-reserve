<script setup lang="ts">
import { keyLabel, shiftDays, todayKey } from "~~/shared/time/period";
import { pickerDate } from "~~/shared/time/picker";
import { localDateKey, localToUtc, timeLabel } from "~~/shared/time/zone";

const supabase = useSupabaseClient();

// Every day here is the LOCATION's (business time, CLAUDE.md): an
// appointment is filed under the day it falls on at the spa, "today" is
// the spa's today, and the window is bounded by the spa's midnights.
// v-calendar itself speaks in browser Dates; pickerDate hands it a noon
// anchor of each key, which no browser zone moves off the day.
const { data: timezone } = await useLocationTimezone();
const tz = () => timezone.value;

const todayStr = todayKey(tz());
const selectedDate = ref(todayStr);

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
    const from = localToUtc(shiftDays(todayStr, -14), "00:00", tz());
    const to = localToUtc(shiftDays(todayStr, 35), "00:00", tz());
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
    const day = localDateKey(appt.starts_at, tz());
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
        dates: pickerDate(day),
        dot: { style: { backgroundColor: providerColor(staffId) } },
        popover: {
          label: `${entry.name} · ${entry.count} appointment${entry.count === 1 ? "" : "s"}`,
        },
      });
    }
  }

  // LOAD-BEARING: v-calendar's weekly view opens on the FIRST attribute's week.
  // This invisible anchor must be unshifted LAST (array position 0) so the
  // calendar opens on today instead of the oldest appointment's week.
  // Delete this and the dashboard opens ~2 weeks in the past.
  attrs.unshift({
    key: "today-anchor",
    dates: pickerDate(todayStr),
    highlight: { fillMode: "none" }, // renders nothing visible
  });

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
    (appt) => localDateKey(appt.starts_at, tz()) === selectedDate.value,
  ),
);

const dayLabel = computed(() =>
  selectedDate.value === todayStr
    ? "Today"
    : keyLabel(selectedDate.value, { weekday: "long", month: "long" }),
);

function timeRange(appt: Appt) {
  const fmt = (iso: string) => timeLabel(iso, tz());
  return `${fmt(appt.starts_at)} – ${fmt(appt.ends_at)}`;
}
</script>

<template>
  <!-- DashboardScrollFrame: the calendar and the day heading stay put, the
       day's list scrolls, "Open full schedule" stays visible below. The
       cap is taller than the other two cards' because the calendar itself
       takes the top ~230px. -->
  <DashboardScrollFrame role="region" aria-label="Week calendar" class="max-h-[600px] p-5">
    <template #header>
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

      <!-- Selected day's heading -->
      <div class="mt-4 flex items-center gap-3">
        <p class="text-muted-foreground shrink-0 text-xs font-medium">
          {{ dayLabel }}
        </p>
        <div class="border-border/70 flex-1 border-t border-dashed" />
      </div>
    </template>

    <!-- Selected day's appointments (this is what scrolls) -->
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
      <li v-if="!dayAppointments.length" class="text-muted-foreground text-sm">
        No appointments this day.
      </li>
    </ul>

    <template #footer>
      <NuxtLink
        to="/schedule"
        class="text-muted-foreground mt-5 block text-xs underline-offset-4 hover:underline"
      >
        Open full schedule →
      </NuxtLink>
    </template>
  </DashboardScrollFrame>
</template>
