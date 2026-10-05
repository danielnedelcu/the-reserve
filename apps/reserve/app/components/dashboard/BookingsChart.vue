<script setup lang="ts">
import type { ApexOptions } from "apexcharts";

/**
 * Bookings by day of month: this month's wave over last month's, aligned
 * day 15 against day 15, so the shape of the month compares — not the
 * calendar month like the wrapper's sample.
 *
 * Built to stay honest once this is a real metric:
 *  - the footer change is COMPUTED from the two months' totals, never a
 *    fixed string; it hides when last month has nothing to compare to
 *    (no division by zero, no "∞%") and says "down" in words when down;
 *  - "this month" counts every non-cancelled appointment ON THE CALENDAR
 *    for the month, past and booked-ahead alike — the same status filter
 *    as the KPI cards and the schedule — and a "Today" marker shows
 *    where the month actually is, so the tail is read as "not booked
 *    yet", not as a collapse;
 *  - the two waves are told apart without colour: last month is dashed,
 *    and the legend and tooltip carry the month names.
 *
 * Gate: `appointments.view.any`. A viewer limited to their own
 * appointments would see their own rhythm drawn as the club's, which is
 * the misleading case this chart exists to avoid.
 *
 * Days are bucketed on the viewer's browser clock, like every other
 * day-granular read on the dashboard and the schedule (the timezone
 * seam, docs/TODO.md).
 */
const supabase = useSupabaseClient();
const { can } = usePermissions();

const allowed = computed(() => can("appointments.view.any"));

const now = new Date();
const thisStart = new Date(now.getFullYear(), now.getMonth(), 1);
const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const nextStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
const daysIn = (monthStart: Date) =>
  new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "long" });

const { data: rows, pending } = await useAsyncData(
  "dashboard-bookings-by-day",
  async () => {
    if (!allowed.value) return null;
    const { data, error } = await supabase
      .from("appointments")
      .select("starts_at, status")
      .gte("starts_at", lastStart.toISOString())
      .lt("starts_at", nextStart.toISOString());
    if (error) throw error;
    return data ?? [];
  },
);

/** Same rule as the KPI cards and the schedule: everything but cancelled. */
const counts = computed(() => {
  const thisMonth = new Array<number>(daysIn(thisStart)).fill(0);
  const lastMonth = new Array<number>(daysIn(lastStart)).fill(0);
  for (const r of rows.value ?? []) {
    if (r.status === "cancelled") continue;
    const d = new Date(r.starts_at);
    const bucket = d < thisStart ? lastMonth : thisMonth;
    bucket[d.getDate() - 1]!++;
  }
  return { thisMonth, lastMonth };
});

const totals = computed(() => ({
  thisMonth: counts.value.thisMonth.reduce((a, b) => a + b, 0),
  lastMonth: counts.value.lastMonth.reduce((a, b) => a + b, 0),
}));

const isEmpty = computed(
  () => totals.value.thisMonth === 0 && totals.value.lastMonth === 0,
);

/**
 * Change vs last month, from the totals, through the shared trend rule:
 * no percentage until last month is a big enough baseline
 * (TREND_MIN_BASELINE), and none for a zero change. The footer then
 * shows the plain totals and says why there is no comparison yet.
 */
const change = computed(() =>
  trend(totals.value.thisMonth, totals.value.lastMonth),
);
const belowBaseline = computed(
  () =>
    totals.value.lastMonth > 0 && totals.value.lastMonth < TREND_MIN_BASELINE,
);

const dayCount = computed(() => Math.max(daysIn(thisStart), daysIn(lastStart)));

/** A month shorter than the axis gets nulls past its last day, not zeros. */
const pad = (arr: number[]) =>
  Array.from({ length: dayCount.value }, (_, i) => arr[i] ?? null);

const series = computed(() => [
  { name: monthName(thisStart), data: pad(counts.value.thisMonth) },
  { name: monthName(lastStart), data: pad(counts.value.lastMonth) },
]);

// Onward palette: purple for this month, teal for last.
const COLORS = ["#572e72", "#92c9d6"];

const options = computed<ApexOptions>(() => ({
  chart: { type: "area", toolbar: { show: false }, zoom: { enabled: false } },
  colors: COLORS,
  stroke: { curve: "smooth", width: 2, dashArray: [0, 6] },
  fill: {
    type: "gradient",
    gradient: { opacityFrom: 0.35, opacityTo: 0.02, stops: [0, 100] },
  },
  legend: { show: true, position: "top", horizontalAlign: "left" },
  markers: { size: 0, hover: { size: 4 } },
  dataLabels: { enabled: false },
  xaxis: {
    categories: Array.from({ length: dayCount.value }, (_, i) => i + 1),
    title: { text: "Day of month" },
    tickAmount: 10,
    tooltip: { enabled: false },
  },
  yaxis: {
    min: 0,
    forceNiceScale: true,
    labels: { formatter: (v: number) => String(Math.round(v)) },
    title: { text: "Bookings" },
  },
  tooltip: {
    shared: true,
    intersect: false,
    x: { formatter: (day: number) => `Day ${day}` },
    y: { formatter: (v: number) => `${v} booking${v === 1 ? "" : "s"}` },
  },
  annotations: {
    xaxis: [
      {
        x: now.getDate(),
        strokeDashArray: 2,
        borderColor: "var(--color-muted-foreground)",
        label: {
          text: "Today",
          orientation: "horizontal",
          borderColor: "var(--color-border)",
          style: {
            background: "var(--color-popover)",
            color: "var(--color-muted-foreground)",
            fontSize: "11px",
          },
        },
      },
    ],
  },
}));

const summary = computed(() => {
  const t = totals.value;
  return `${t.thisMonth} booking${t.thisMonth === 1 ? "" : "s"} on the calendar in ${monthName(thisStart)}, ${t.lastMonth} in ${monthName(lastStart)}.`;
});
</script>

<template>
  <UiCard v-if="allowed" class="rounded-md">
    <UiCardHeader class="p-4 pb-0">
      <UiCardTitle class="text-base">Bookings by day</UiCardTitle>
      <UiCardDescription>
        {{ monthName(thisStart) }} over {{ monthName(lastStart) }}, aligned by
        day of month
      </UiCardDescription>
    </UiCardHeader>

    <UiCardContent class="p-4">
      <div
        v-if="pending && !rows"
        class="h-60 animate-pulse rounded-md bg-muted"
      />

      <div
        v-else-if="isEmpty"
        class="text-muted-foreground flex h-60 flex-col items-center justify-center gap-2 text-sm"
      >
        <Icon name="lucide:calendar-off" class="size-6 opacity-50" />
        No bookings this month or last
      </div>

      <template v-else>
        <div class="h-60">
          <UiApexchart
            type="area"
            height="100%"
            :series="series"
            :options="options"
          />
        </div>
        <p class="sr-only">
          {{ summary }} Solid line is {{ monthName(thisStart) }}, dashed line is
          {{ monthName(lastStart) }}.
        </p>

        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            v-if="change"
            class="flex items-center gap-1 font-medium"
            :class="
              change.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
          >
            <Icon
              :name="
                change.direction === 'up'
                  ? 'lucide:trending-up'
                  : 'lucide:trending-down'
              "
              class="size-4"
            />
            {{ change.direction === "up" ? "Up" : "Down" }} {{ change.pct }}% vs
            {{ monthName(lastStart) }}
          </span>
          <span
            v-else-if="belowBaseline"
            class="text-muted-foreground flex items-center gap-1"
          >
            <Icon name="lucide:info" class="size-4" />
            No comparison yet — fewer than {{ TREND_MIN_BASELINE }} bookings in
            {{ monthName(lastStart) }}
          </span>
          <span class="text-muted-foreground">{{ summary }}</span>
        </div>
      </template>
    </UiCardContent>
  </UiCard>
</template>
