<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "appointments.view.own" });
useSeoMeta({ title: "Schedule — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// View + date state
// ---------------------------------------------------------------------------
const view = ref<"day" | "week" | "month">("day");
const VIEWS: { key: typeof view.value; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

function toDateStr(d: Date) {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}
const selectedDate = ref(toDateStr(new Date()));
const todayStr = toDateStr(new Date());

function startOfWeek(dateStr: string): Date {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  d.setHours(0, 0, 0, 0);
  return d;
}

const weekDays = computed(() => {
  const start = startOfWeek(selectedDate.value);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return {
      dateStr: toDateStr(d),
      dayNum: d.getDate(),
      dayName: d.toLocaleDateString("en-US", { weekday: "short" }),
      isWeekend: i === 0 || i === 6,
    };
  });
});

const headerLabel = computed(() => {
  const d = new Date(`${selectedDate.value}T12:00:00`);
  if (view.value === "day") {
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  if (view.value === "week") {
    const first = weekDays.value[0]!;
    const last = weekDays.value[6]!;
    const f = new Date(`${first.dateStr}T12:00:00`);
    const l = new Date(`${last.dateStr}T12:00:00`);
    const fLabel = f.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const lLabel = l.toLocaleDateString("en-US", {
      month: f.getMonth() === l.getMonth() ? undefined : "short",
      day: "numeric",
      year: "numeric",
    });
    return `${fLabel} – ${lLabel}`;
  }
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
});

function shiftPeriod(delta: number) {
  const d = new Date(`${selectedDate.value}T12:00:00`);
  if (view.value === "day") d.setDate(d.getDate() + delta);
  else if (view.value === "week") d.setDate(d.getDate() + delta * 7);
  else d.setMonth(d.getMonth() + delta, 1);
  selectedDate.value = toDateStr(d);
}

// ---------------------------------------------------------------------------
// Month grid geometry (Sunday-first)
// ---------------------------------------------------------------------------
const monthGrid = computed(() => {
  const anchor = new Date(`${selectedDate.value}T12:00:00`);
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);

  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + (6 - last.getDay()));

  const days: { dateStr: string; dayNum: number; inMonth: boolean }[] = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    days.push({
      dateStr: toDateStr(cursor),
      dayNum: cursor.getDate(),
      inMonth: cursor.getMonth() === anchor.getMonth(),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return { days, gridStart, gridEnd };
});

// ---------------------------------------------------------------------------
// Data: fetch range depends on the view
// ---------------------------------------------------------------------------
interface Appt {
  id: string;
  client_id: string;
  staff_id: string;
  resource_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
  client: { first_name: string; last_name: string } | null;
  appointment_services: {
    name_snapshot: string;
    price_cents: number;
    duration_min: number;
  }[];
  resource: { name: string } | null;
}

// SCAR — the two-timezone seam (inventory, 2026-09-19). Everything on this
// page that turns a day key into an instant or an instant into grid
// pixels uses the VIEWER'S BROWSER CLOCK: the day range below is built
// from browser-local midnight, and blockStyle() positions a card from
// `getHours()`/`getMinutes()`. The slots route computes availability in
// the LOCATION'S timezone (server/utils/timezone.ts, localToUtc). The two
// agree only while the viewer and the location share a zone — true today,
// one city — and a viewer elsewhere would see cards drawn at their own
// local hour while being offered slots computed for the spa's. Recorded
// in docs/TODO.md as a latent correctness bug to fix DELIBERATELY (the
// fix is the location timezone on this side, not the browser's on the
// other). Until then, keep this behaviour exactly as it is: the redesign
// redraws these cards and must not "fix" it in passing.
/**
 * ONE range for all three views: the month grid (whole weeks, six rows)
 * around the selected date. Day and week are always inside it, so
 * switching views never fetches and never shows a partial set — the
 * range used to follow the view, and a day-to-week switch drew today's
 * cards first and popped the rest of the week in ~150ms later when the
 * week query landed. Now only navigating into a different month grid
 * loads anything; each view just filters apptsByDay for the days it
 * shows. Cost: up to six weeks of rows per load instead of one day.
 */
const fetchRange = computed(() => {
  const { gridStart, gridEnd } = monthGrid.value;
  const end = new Date(gridEnd);
  end.setDate(end.getDate() + 1);
  return { from: gridStart.toISOString(), to: end.toISOString() };
});
// Watched as a string so moving the selected date WITHIN the loaded grid
// (next day, next week) does not re-run the query.
const fetchRangeKey = computed(
  () => `schedule-${fetchRange.value.from}-${fetchRange.value.to}`,
);

const {
  data: appointments,
  refresh: refreshAppointments,
  error: apptError,
} = await useAsyncData(
  () => fetchRangeKey.value,
  async () => {
    const { data, error } = await supabase
      .from("appointments")
      .select(
        "id, client_id, staff_id, resource_id, starts_at, ends_at, status, notes, client:clients(first_name, last_name), appointment_services(name_snapshot, price_cents, duration_min), resource:resources(name)",
      )
      .gte("starts_at", fetchRange.value.from)
      .lte("starts_at", fetchRange.value.to)
      .not("status", "in", "(cancelled)")
      .order("starts_at");
    if (error) throw error;
    return (data ?? []) as unknown as Appt[];
  },
  { watch: [fetchRangeKey] },
);

const apptsByDay = computed(() => {
  const map: Record<string, Appt[]> = {};
  for (const appt of appointments.value ?? []) {
    const key = toDateStr(new Date(appt.starts_at));
    (map[key] ??= []).push(appt);
  }
  return map;
});

// ---------------------------------------------------------------------------
// Time-grid geometry (shared by day + week views)
// ---------------------------------------------------------------------------
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const GRID_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const hours = Array.from(
  { length: DAY_END_HOUR - DAY_START_HOUR },
  (_, i) => DAY_START_HOUR + i,
);

/**
 * The grid body is not a fixed 720px any more: it fills the column (so a
 * tall window gets taller hours instead of a blank band under 7p) with
 * GRID_MINUTES px as its floor (so a short window scrolls). Everything
 * positioned inside it is therefore placed as a PERCENTAGE of the day,
 * never in px-per-minute — hour lines, hour labels and cards all go
 * through these two helpers so the three cannot drift apart.
 */
const pctOfDay = (minutes: number) => `${(minutes / GRID_MINUTES) * 100}%`;
const hourTop = (h: number) => pctOfDay((h - DAY_START_HOUR) * 60);

/**
 * POSITION only. Colour used to be set here too; it now lives in
 * ScheduleAppointmentCard, once, for every view (the tint fill + colour
 * left edge that says whose appointment this is).
 */
function blockStyle(appt: Appt) {
  // SCAR: browser-local hours — see the two-timezone seam note above
  // fetchRange. Deliberately unchanged.
  const start = new Date(appt.starts_at);
  const end = new Date(appt.ends_at);
  const startMin =
    start.getHours() * 60 + start.getMinutes() - DAY_START_HOUR * 60;
  const lengthMin = (end.getTime() - start.getTime()) / 60_000;
  return {
    top: pctOfDay(Math.max(startMin, 0)),
    height: pctOfDay(lengthMin),
    minHeight: "24px",
  };
}
// timeLabel / shortTime moved to app/utils/appointmentTime.ts (auto-imported),
// shared with the card component.

// ---------------------------------------------------------------------------
// Day view: staff columns
// ---------------------------------------------------------------------------
const { data: staffList } = await useAsyncData("schedule-staff", async () => {
  const { data, error } = await supabase
    .from("staff")
    .select("id, display_name")
    .eq("active", true)
    .eq("bookable", true)
    .order("display_name");
  if (error) throw error;
  return data ?? [];
});

/**
 * A provider's lane for the SELECTED DAY — read through apptsByDay, the
 * same date-keyed map the week and month views use, so all three views
 * decide "is this appointment on screen" in one place. Filtering the raw
 * list by staff alone assumed the list held only today, which is false
 * for the moment after a view switch: useAsyncData keeps the previous
 * range's rows until the new query resolves, and a whole week of
 * appointments flickered into today's lanes at their hour before the
 * day query landed. Keyed by date, stale rows are at worst a superset
 * that filters down correctly.
 */
function blocksFor(staffId: string) {
  return (apptsByDay.value[selectedDate.value] ?? []).filter(
    (a) => a.staff_id === staffId,
  );
}

// ---------------------------------------------------------------------------
// Week view: collision layout
// ---------------------------------------------------------------------------
/**
 * WHY THIS EXISTS. The day view gives each provider a lane, so the
 * no-double-booking constraint guarantees its cards never collide. The
 * week view has ONE lane per day shared by every provider, so two
 * providers working at the same time — perfectly valid, and at realistic
 * volume it happens on most working days — used to be drawn in the same
 * horizontal space, the later start on top. Translucent fills blended
 * the two into unreadable overprint; the opaque-fill reskin made the
 * lower card vanish entirely. Neither was a layout. This is: cards that
 * overlap in time share the lane's width side by side, all readable,
 * and a card that overlaps nothing keeps the full width.
 *
 * Per day: sort by start; chain overlapping appointments into clusters
 * (an appointment joins the open cluster if it starts before the
 * cluster's latest end); inside a cluster assign columns greedily (the
 * first column whose last appointment has ended, else a new one). Every
 * card in the cluster is 1/columns wide at column × that offset.
 */
interface Slot {
  col: number;
  cols: number;
}
const weekLayout = computed(() => {
  const slots = new Map<string, Slot>();
  for (const day of weekDays.value) {
    const appts = [...(apptsByDay.value[day.dateStr] ?? [])].sort((a, b) =>
      a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0,
    );
    let cluster: Appt[] = [];
    let clusterEnd = "";
    let columnEnds: string[] = [];
    const flush = () => {
      for (const a of cluster) slots.get(a.id)!.cols = columnEnds.length;
      cluster = [];
      columnEnds = [];
    };
    for (const appt of appts) {
      if (cluster.length && appt.starts_at >= clusterEnd) flush();
      let col = columnEnds.findIndex((end) => end <= appt.starts_at);
      if (col === -1) col = columnEnds.push("") - 1;
      columnEnds[col] = appt.ends_at;
      cluster.push(appt);
      clusterEnd = clusterEnd > appt.ends_at ? clusterEnd : appt.ends_at;
      slots.set(appt.id, { col, cols: 1 });
    }
    flush();
  }
  return slots;
});

/** blockStyle's vertical geometry plus the cluster's horizontal share. */
function weekCardStyle(appt: Appt) {
  const { col, cols } = weekLayout.value.get(appt.id) ?? { col: 0, cols: 1 };
  const GAP = 4; // px between neighbours, matching the lane's inset
  return {
    ...blockStyle(appt),
    left: `calc(${(col / cols) * 100}% + ${GAP}px)`,
    width: `calc(${100 / cols}% - ${GAP * (col === cols - 1 ? 2 : 1.5)}px)`,
  };
}

/** Full alone, name + time beside one neighbour, name only beside more. */
function weekDensity(appt: Appt): "full" | "compact" | "minimal" {
  const cols = weekLayout.value.get(appt.id)?.cols ?? 1;
  return cols === 1 ? "full" : cols === 2 ? "compact" : "minimal";
}

// ---------------------------------------------------------------------------
// Month view helpers
// ---------------------------------------------------------------------------
const MAX_CHIPS = 3;

function openDay(dateStr: string) {
  selectedDate.value = dateStr;
  view.value = "day";
}

// ---------------------------------------------------------------------------
// Appointment detail + status transitions
// ---------------------------------------------------------------------------
const detailAppt = ref<Appt | null>(null);

const NEXT_STATUSES: Record<string, { to: string; label: string }[]> = {
  booked: [
    { to: "confirmed", label: "Confirm" },
    { to: "checked_in", label: "Check in" },
  ],
  confirmed: [{ to: "checked_in", label: "Check in" }],
  checked_in: [{ to: "in_progress", label: "Start" }],
  in_progress: [{ to: "completed", label: "Complete" }],
};

async function transition(appt: Appt, status: string) {
  const { error } = await supabase
    .from("appointments")
    .update({ status })
    .eq("id", appt.id);
  if (error) return toast.error("Could not update", error.message);
  toast.success("Updated", `Appointment ${status.replace("_", " ")}`);
  detailAppt.value = null;
  await refreshAppointments();
}

async function cancelAppt(appt: Appt) {
  const reason = prompt("Cancellation reason (optional):") ?? "";
  const { data: me } = await supabase.rpc("current_staff_id");
  const { error } = await supabase
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason || null,
      cancelled_by: me,
    })
    .eq("id", appt.id);
  if (error) return toast.error("Could not cancel", error.message);
  toast.success("Appointment cancelled");
  detailAppt.value = null;
  await refreshAppointments();
}

async function markNoShow(appt: Appt) {
  if (!confirm("Mark this appointment as a no-show?")) return;
  const { error } = await supabase
    .from("appointments")
    .update({ status: "no_show" })
    .eq("id", appt.id);
  if (error) return toast.error("Could not update", error.message);
  toast.success("Marked as no-show");
  detailAppt.value = null;
  await refreshAppointments();
}

// ---------------------------------------------------------------------------
// Booking dialog
// ---------------------------------------------------------------------------
const bookingOpen = ref(false);
const bClientId = ref("");
const bServiceId = ref("");
const bStaffId = ref("");
const slots = ref<
  { startsAt: string; roomId: string | null; roomName: string | null }[]
>([]);
const slotsLoading = ref(false);
const booking = ref(false);
const slotsFetched = ref(false);

const { data: clientOptions } = await useAsyncData(
  "booking-clients",
  async () => {
    if (!can("appointments.create")) return [];
    const { data } = await supabase
      .from("clients")
      .select("id, first_name, last_name")
      .eq("active", true)
      .order("last_name");
    return data ?? [];
  },
);

const { data: serviceOptions } = await useAsyncData(
  "booking-services",
  async () => {
    if (!can("appointments.create")) return [];
    const { data } = await supabase
      .from("services")
      .select("id, name, duration_minutes, service_staff(staff_id)")
      .eq("active", true)
      .order("name");
    return data ?? [];
  },
);

const qualifiedStaff = computed(() => {
  const service = serviceOptions.value?.find((s) => s.id === bServiceId.value);
  if (!service) return [];
  const qualifiedIds = new Set(
    service.service_staff.map((ss: { staff_id: string }) => ss.staff_id),
  );
  return (staffList.value ?? []).filter((s) => qualifiedIds.has(s.id));
});

watch(bServiceId, () => {
  bStaffId.value = "";
  slots.value = [];
  slotsFetched.value = false;
});
watch([bStaffId, selectedDate], () => {
  slots.value = [];
  slotsFetched.value = false;
});

async function findSlots() {
  if (!bServiceId.value || !bStaffId.value) return;
  slotsLoading.value = true;
  try {
    const result = await $fetch<{ slots: typeof slots.value }>(
      "/api/appointments/slots",
      {
        query: {
          serviceId: bServiceId.value,
          staffId: bStaffId.value,
          date: selectedDate.value,
        },
      },
    );
    slots.value = result.slots;
    slotsFetched.value = true;
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not load times",
      err.data?.statusMessage ?? "Something went wrong.",
    );
  } finally {
    slotsLoading.value = false;
  }
}

async function book(slot: { startsAt: string; roomId: string | null }) {
  if (!bClientId.value) return toast.error("Pick a client first");
  booking.value = true;
  try {
    await $fetch("/api/appointments", {
      method: "POST",
      body: {
        clientId: bClientId.value,
        serviceId: bServiceId.value,
        staffId: bStaffId.value,
        startsAt: slot.startsAt,
        roomId: slot.roomId ?? undefined,
      },
    });
    toast.success("Appointment booked", timeLabel(slot.startsAt));
    bookingOpen.value = false;
    bClientId.value = "";
    bServiceId.value = "";
    bStaffId.value = "";
    slots.value = [];
    slotsFetched.value = false;
    await refreshAppointments();
  } catch (e: unknown) {
    const err = e as { statusCode?: number; data?: { statusMessage?: string } };
    if (
      err.statusCode === 409 ||
      err.data?.statusMessage?.includes("just taken")
    ) {
      toast.warning("Slot just taken", "Refreshing available times…");
      await findSlots();
    } else {
      toast.error(
        "Could not book",
        err.data?.statusMessage ?? "Something went wrong.",
      );
    }
  } finally {
    booking.value = false;
  }
}
</script>

<template>
  <div class="flex h-[calc(100dvh-3rem)] flex-col p-6 md:p-8">
    <!-- The page owns the viewport, the same way clients/index.vue does:
         the layout header is h-12 (3rem), this root fills the rest as a
         flex column, everything above the calendar is shrink-0, and the
         calendar card takes whatever height is left (flex-1, min-h-0).
         Inside the card the grid scrolls and the column headings stay put
         (sticky top), so a short window never hides which column is
         whose. -->
    <!-- Header -->
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-semibold">Schedule</h1>

        <!-- View toggle -->
        <div class="flex rounded-lg border p-0.5">
          <button
            v-for="option in VIEWS"
            :key="option.key"
            class="rounded-md px-3 py-1 text-sm transition"
            :class="
              view === option.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-secondary'
            "
            @click="view = option.key"
          >
            {{ option.label }}
          </button>
        </div>

        <div class="flex items-center gap-1">
          <UiButton
            variant="outline"
            size="sm"
            :aria-label="`Previous ${view}`"
            @click="shiftPeriod(-1)"
          >
            <Icon name="lucide:chevron-left" class="size-4" />
          </UiButton>
          <UiButton
            variant="outline"
            size="sm"
            @click="selectedDate = toDateStr(new Date())"
          >
            Today
          </UiButton>
          <UiButton
            variant="outline"
            size="sm"
            :aria-label="`Next ${view}`"
            @click="shiftPeriod(1)"
          >
            <Icon name="lucide:chevron-right" class="size-4" />
          </UiButton>
        </div>
        <p class="text-muted-foreground text-sm">{{ headerLabel }}</p>
      </div>
      <UiButton
        v-if="can('appointments.create')"
        size="sm"
        @click="bookingOpen = true"
      >
        <Icon name="lucide:plus" class="size-4" />
        New appointment
      </UiButton>
    </div>

    <p v-if="apptError" class="text-destructive mt-4 shrink-0 text-sm">
      Couldn't load appointments: {{ apptError.message }}
    </p>

    <!-- ================= DAY VIEW (staff columns) ================= -->
    <div
      v-if="view === 'day'"
      class="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div class="min-h-0 flex-1 overflow-auto">
        <div class="flex min-h-full min-w-fit">
          <div class="flex w-14 shrink-0 flex-col border-r">
            <div class="sticky top-0 z-20 h-10 border-b bg-card" />
            <div
              class="relative flex-1"
              :style="{ minHeight: `${GRID_MINUTES}px` }"
            >
              <p
                v-for="h in hours"
                :key="h"
                class="text-muted-foreground absolute translate-y-2 pr-2 text-right text-xs"
                :style="{ top: hourTop(h), right: '4px' }"
              >
                {{ h % 12 === 0 ? 12 : h % 12 }}{{ h < 12 ? "a" : "p" }}
              </p>
            </div>
          </div>

          <div
            v-for="member in staffList"
            :key="member.id"
            class="flex min-w-44 flex-1 flex-col border-r last:border-r-0"
          >
            <div
              class="sticky top-0 z-20 flex h-10 items-center justify-center gap-2 border-b bg-card px-2"
            >
              <span
                class="size-2 rounded-full"
                :style="{ backgroundColor: providerColor(member.id) }"
                aria-hidden="true"
              />
              <p class="truncate text-sm font-medium">
                {{ member.display_name }}
              </p>
            </div>
            <div
              class="relative flex-1"
              :style="{ minHeight: `${GRID_MINUTES}px` }"
            >
              <div
                v-for="h in hours"
                :key="h"
                class="border-border/50 absolute w-full border-t"
                :style="{ top: hourTop(h) }"
              />
              <ScheduleAppointmentCard
                v-for="appt in blocksFor(member.id)"
                :key="appt.id"
                :appointment="appt"
                variant="day"
                class="absolute inset-x-1"
                :style="blockStyle(appt)"
                @select="detailAppt = appt"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= WEEK VIEW (day columns, time grid) ================= -->
    <div
      v-else-if="view === 'week'"
      class="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div class="min-h-0 flex-1 overflow-auto">
        <div class="flex min-h-full min-w-fit">
          <div class="flex w-14 shrink-0 flex-col border-r">
            <div class="sticky top-0 z-20 h-14 border-b bg-card" />
            <div
              class="relative flex-1"
              :style="{ minHeight: `${GRID_MINUTES}px` }"
            >
              <p
                v-for="h in hours"
                :key="h"
                class="text-muted-foreground absolute translate-y-2 pr-2 text-right text-xs"
                :style="{ top: hourTop(h), right: '4px' }"
              >
                {{ h % 12 === 0 ? 12 : h % 12 }}{{ h < 12 ? "a" : "p" }}
              </p>
            </div>
          </div>

          <div
            v-for="day in weekDays"
            :key="day.dateStr"
            class="flex min-w-36 flex-1 flex-col border-r last:border-r-0"
          >
            <!-- Day header: click through to day view -->
            <button
              class="sticky top-0 z-20 flex h-14 w-full flex-col items-center justify-center gap-1 border-b bg-card transition hover:bg-secondary/50"
              @click="openDay(day.dateStr)"
            >
              <!-- span, not p: main.css gives every <p> text-base and a
                   margin, which overflowed the 56px header and sat the
                   today circle on the border. -->
              <span
                class="text-xs leading-none"
                :class="
                  day.isWeekend
                    ? 'text-destructive/70'
                    : 'text-muted-foreground'
                "
              >
                {{ day.dayName }}
              </span>
              <span
                class="inline-flex size-7 items-center justify-center rounded-full text-sm"
                :class="
                  day.dateStr === todayStr
                    ? 'bg-primary text-primary-foreground font-semibold'
                    : ''
                "
              >
                {{ day.dayNum }}
              </span>
            </button>

            <div
              class="relative flex-1"
              :style="{ minHeight: `${GRID_MINUTES}px` }"
            >
              <div
                v-for="h in hours"
                :key="h"
                class="border-border/50 absolute w-full border-t"
                :style="{ top: hourTop(h) }"
              />
              <ScheduleAppointmentCard
                v-for="appt in apptsByDay[day.dateStr] ?? []"
                :key="appt.id"
                :appointment="appt"
                variant="week"
                :density="weekDensity(appt)"
                class="absolute"
                :style="weekCardStyle(appt)"
                @select="detailAppt = appt"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= MONTH VIEW ================= -->
    <div
      v-else
      class="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div class="grid shrink-0 grid-cols-7 border-b">
        <p
          v-for="d in ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']"
          :key="d"
          class="text-muted-foreground px-2 py-2 text-center text-xs font-medium"
        >
          {{ d }}
        </p>
      </div>
      <!-- Rows share the remaining height (1fr) down to a 7rem floor; below
           that the grid scrolls under the pinned weekday row. -->
      <div
        class="grid min-h-0 flex-1 auto-rows-[minmax(7rem,1fr)] grid-cols-7 overflow-y-auto"
      >
        <div
          v-for="day in monthGrid.days"
          :key="day.dateStr"
          class="border-border/60 cursor-pointer border-b border-r p-1.5 transition hover:bg-secondary/40"
          :class="!day.inMonth && 'bg-secondary/20'"
          @click="openDay(day.dateStr)"
        >
          <div class="flex justify-end">
            <span
              class="inline-flex size-6 items-center justify-center rounded-full text-xs"
              :class="[
                day.dateStr === todayStr
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : '',
                !day.inMonth && day.dateStr !== todayStr
                  ? 'text-muted-foreground/50'
                  : '',
              ]"
            >
              {{ day.dayNum }}
            </span>
          </div>

          <div class="mt-1 space-y-1">
            <ScheduleAppointmentCard
              v-for="appt in (apptsByDay[day.dateStr] ?? []).slice(
                0,
                MAX_CHIPS,
              )"
              :key="appt.id"
              :appointment="appt"
              variant="chip"
              @click.stop
              @select="detailAppt = appt"
            />
            <p
              v-if="(apptsByDay[day.dateStr]?.length ?? 0) > MAX_CHIPS"
              class="text-muted-foreground px-1.5 text-[11px]"
            >
              +{{ apptsByDay[day.dateStr]!.length - MAX_CHIPS }} more
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Appointment detail (shared by all views) -->
    <UiDialog
      :open="!!detailAppt"
      @update:open="(v) => !v && (detailAppt = null)"
    >
      <UiDialogContent v-if="detailAppt" class="sm:max-w-md">
        <UiDialogHeader>
          <UiDialogTitle>
            {{
              detailAppt.client
                ? `${detailAppt.client.first_name} ${detailAppt.client.last_name}`
                : "Appointment"
            }}
          </UiDialogTitle>
          <UiDialogDescription>
            {{ detailAppt.appointment_services[0]?.name_snapshot }} ·
            {{ timeLabel(detailAppt.starts_at) }}–{{
              timeLabel(detailAppt.ends_at)
            }}
            <span v-if="detailAppt.resource">
              · {{ detailAppt.resource.name }}</span
            >
          </UiDialogDescription>
        </UiDialogHeader>

        <p class="text-sm">
          Status:
          <span class="font-medium capitalize">{{
            detailAppt.status.replace("_", " ")
          }}</span>
        </p>
        <p v-if="detailAppt.notes" class="text-muted-foreground text-sm">
          {{ detailAppt.notes }}
        </p>
        <NuxtLink
          :to="`/clients/${detailAppt.client_id}`"
          class="text-sm underline-offset-4 hover:underline"
        >
          View client profile →
        </NuxtLink>

        <UiDialogFooter class="flex-wrap gap-2">
          <UiButton
            v-if="
              ['checked_in', 'in_progress', 'completed'].includes(
                detailAppt.status,
              ) && can('pos.checkout')
            "
            size="sm"
            :to="`/checkout?appointment=${detailAppt.id}`"
          >
            <Icon name="lucide:credit-card" class="size-4" />
            Checkout
          </UiButton>
          <UiButton
            v-for="next in NEXT_STATUSES[detailAppt.status] ?? []"
            :key="next.to"
            size="sm"
            @click="transition(detailAppt, next.to)"
          >
            {{ next.label }}
          </UiButton>
          <UiButton
            v-if="!['completed', 'no_show'].includes(detailAppt.status)"
            size="sm"
            variant="outline"
            class="text-destructive"
            @click="markNoShow(detailAppt)"
          >
            No-show
          </UiButton>
          <UiButton
            v-if="!['completed', 'no_show'].includes(detailAppt.status)"
            size="sm"
            variant="ghost"
            class="text-destructive"
            @click="cancelAppt(detailAppt)"
          >
            Cancel appointment
          </UiButton>
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialog>

    <!-- Booking dialog -->
    <UiDialog v-model:open="bookingOpen">
      <UiDialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <UiDialogHeader>
          <UiDialogTitle>New appointment</UiDialogTitle>
          <UiDialogDescription>
            {{
              new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })
            }}
          </UiDialogDescription>
        </UiDialogHeader>

        <div class="grid gap-4">
          <div>
            <label class="text-sm font-medium" for="b-client">Client</label>
            <UiSelect v-model="bClientId">
              <UiSelectTrigger id="b-client" class="mt-1.5" placeholder="Select a client…" />
              <UiSelectContent>
                <UiSelectItem v-for="c in clientOptions" :key="c.id" :value="c.id">
                  {{ c.last_name }}, {{ c.first_name }}
                </UiSelectItem>
              </UiSelectContent>
            </UiSelect>
          </div>

          <div>
            <label class="text-sm font-medium" for="b-service">Service</label>
            <UiSelect v-model="bServiceId">
              <UiSelectTrigger id="b-service" class="mt-1.5" placeholder="Select a service…" />
              <UiSelectContent>
                <UiSelectItem v-for="s in serviceOptions" :key="s.id" :value="s.id">
                  {{ s.name }} ({{ s.duration_minutes }} min)
                </UiSelectItem>
              </UiSelectContent>
            </UiSelect>
          </div>

          <div v-if="bServiceId">
            <label class="text-sm font-medium" for="b-staff">Staff</label>
            <UiSelect v-model="bStaffId">
              <UiSelectTrigger
                id="b-staff"
                class="mt-1.5"
                :placeholder="
                  qualifiedStaff.length
                    ? 'Select a staff member…'
                    : 'No qualified staff for this service'
                "
              />
              <UiSelectContent>
                <UiSelectItem
                  v-for="s in qualifiedStaff"
                  :key="s.id"
                  :value="s.id"
                  :text="s.display_name"
                />
              </UiSelectContent>
            </UiSelect>
            <p
              v-if="bServiceId && !qualifiedStaff.length"
              class="text-muted-foreground mt-1 text-xs"
            >
              Assign staff to this service on the Services page first.
            </p>
          </div>

          <p v-if="view !== 'day'" class="text-muted-foreground text-xs">
            Booking against the selected date shown above — click a specific day
            in the
            {{ view }} grid first if that isn't the day you want.
          </p>

          <UiButton
            v-if="bStaffId"
            variant="outline"
            :disabled="slotsLoading"
            :text="slotsLoading ? 'Finding times…' : 'Find available times'"
            @click="findSlots"
          />

          <div v-if="slotsFetched">
            <p class="text-sm font-medium">Available times</p>
            <div v-if="slots.length" class="mt-2 flex flex-wrap gap-2">
              <UiButton
                v-for="slot in slots"
                :key="slot.startsAt"
                size="sm"
                variant="outline"
                :disabled="booking"
                @click="book(slot)"
              >
                {{ timeLabel(slot.startsAt) }}
              </UiButton>
            </div>
            <p v-else class="text-muted-foreground mt-2 text-sm">
              No open times that day — check the staff member's weekly hours, or
              try another date.
            </p>
          </div>
        </div>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
