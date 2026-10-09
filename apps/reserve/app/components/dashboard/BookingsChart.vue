<script setup lang="ts">
import type { ApexOptions } from "apexcharts";
import { dayOfMonth, daysInMonth, monthLabel, periodRange, previousPeriod, todayKey, type PeriodRange } from "~~/shared/time/period";
import { localDateKey } from "~~/shared/time/zone";

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
 * Both months are the LOCATION's calendar months (business time,
 * CLAUDE.md): periodRange bounds each by the spa's midnights, and an
 * appointment is filed under the day it falls on at the spa, never the
 * day the viewer's browser puts it on.
 */
const supabase = useSupabaseClient();
const { can } = usePermissions();

const allowed = computed(() => can("appointments.view.any"));

const { data: timezone } = await useLocationTimezone();
const today = todayKey(timezone.value);
const thisMonth = periodRange({ period: "month", anchor: today }, timezone.value);
const lastMonth = periodRange(previousPeriod({ period: "month", anchor: today }), timezone.value);
const daysIn = (month: PeriodRange) => daysInMonth(month.fromKey);
const monthName = (month: PeriodRange) => monthLabel(month.fromKey);

const { data: rows, pending } = await useAsyncData(
  "dashboard-bookings-by-day",
  async () => {
    if (!allowed.value) return null;
    // Two months of a busy spa pass PostgREST's 1,000-row cap; without
    // paging, this month is the part that fell off the end (utils/allRows).
    return allRows((from, to) =>
      supabase
        .from("appointments")
        .select("starts_at, status")
        .gte("starts_at", lastMonth.from.toISOString())
        .lt("starts_at", thisMonth.to.toISOString())
        .order("starts_at")
        .order("id")
        .range(from, to),
    );
  },
);

/** Same rule as the KPI cards and the schedule: everything but cancelled. */
const counts = computed(() => {
  const current = new Array<number>(daysIn(thisMonth)).fill(0);
  const previous = new Array<number>(daysIn(lastMonth)).fill(0);
  for (const r of rows.value ?? []) {
    if (r.status === "cancelled") continue;
    const key = localDateKey(r.starts_at, timezone.value);
    const bucket = key < thisMonth.fromKey ? previous : current;
    bucket[dayOfMonth(key) - 1]!++;
  }
  return { thisMonth: current, lastMonth: previous };
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

const dayCount = computed(() => Math.max(daysIn(thisMonth), daysIn(lastMonth)));

/** A month shorter than the axis gets nulls past its last day, not zeros. */
const pad = (arr: number[]) =>
  Array.from({ length: dayCount.value }, (_, i) => arr[i] ?? null);

const series = computed(() => [
  { name: monthName(thisMonth), data: pad(counts.value.thisMonth) },
  { name: monthName(lastMonth), data: pad(counts.value.lastMonth) },
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
        x: dayOfMonth(today),
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
  return `${t.thisMonth} booking${t.thisMonth === 1 ? "" : "s"} on the calendar in ${monthName(thisMonth)}, ${t.lastMonth} in ${monthName(lastMonth)}.`;
});
</script>

<template>
  <UiCard v-if="allowed" class="rounded-md">
    <UiCardHeader class="p-4 pb-0">
      <UiCardTitle class="text-base">Bookings by day</UiCardTitle>
      <UiCardDescription>
        {{ monthName(thisMonth) }} over {{ monthName(lastMonth) }}, aligned by
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
          {{ summary }} Solid line is {{ monthName(thisMonth) }}, dashed line is
          {{ monthName(lastMonth) }}.
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
            {{ monthName(lastMonth) }}
          </span>
          <span
            v-else-if="belowBaseline"
            class="text-muted-foreground flex items-center gap-1"
          >
            <Icon name="lucide:info" class="size-4" />
            No comparison yet — fewer than {{ TREND_MIN_BASELINE }} bookings in
            {{ monthName(lastMonth) }}
          </span>
          <span class="text-muted-foreground">{{ summary }}</span>
        </div>
      </template>
    </UiCardContent>
  </UiCard>
</template>
