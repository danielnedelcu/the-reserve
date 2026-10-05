<script setup lang="ts">
const supabase = useSupabaseClient();
const { can } = usePermissions();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

// ---------------------------------------------------------------------------
// Rolling windows: last 7 days, the 7 before that, and the next 7
// ---------------------------------------------------------------------------
function daysFromNow(n: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}
const now = new Date();
const last7 = { from: daysFromNow(-7), to: now };
const prior7 = { from: daysFromNow(-14), to: daysFromNow(-7) };
const next7 = { from: now, to: daysFromNow(7) };

// ---------------------------------------------------------------------------
// Data (each fetch spans -14d..+7d once, sliced client-side)
// ---------------------------------------------------------------------------
const { data: appts } = await useAsyncData("kpi-appts", async () => {
  const { data, error } = await supabase
    .from("appointments")
    .select("starts_at, status")
    .gte("starts_at", prior7.from.toISOString())
    .lt("starts_at", next7.to.toISOString());
  if (error) throw error;
  return data ?? [];
});

const { data: newClients } = await useAsyncData("kpi-clients", async () => {
  if (!can("clients.view")) return null;
  const { data, error } = await supabase
    .from("clients")
    .select("created_at")
    .gte("created_at", prior7.from.toISOString());
  if (error) throw error;
  return data ?? [];
});

const { data: revenueRows } = await useAsyncData("kpi-revenue", async () => {
  if (!can("financials.view_summary")) return null;
  const { data, error } = await supabase
    .from("transactions")
    .select("created_at, transaction_items(kind, total_cents)")
    .gte("created_at", prior7.from.toISOString());
  if (error) throw error;
  return data ?? [];
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function within(iso: string, window: { from: Date; to: Date }) {
  const t = Date.parse(iso);
  return t >= window.from.getTime() && t < window.to.getTime();
}

const apptMetrics = computed(() => {
  const rows = appts.value ?? [];
  const count = (window: { from: Date; to: Date }, statuses?: string[]) =>
    rows.filter(
      (a) =>
        within(a.starts_at, window) &&
        (statuses
          ? statuses.includes(a.status)
          : !["cancelled"].includes(a.status)),
    ).length;
  const noShowRate = (window: { from: Date; to: Date }) => {
    const total = count(window);
    if (!total) return null;
    return Math.round((count(window, ["no_show"]) / total) * 100);
  };
  return {
    last7: count(last7),
    prior7: count(prior7),
    completed7: count(last7, ["completed"]),
    booked7ahead: count(next7),
    noShowLast7: noShowRate(last7),
    noShowPrior7: noShowRate(prior7),
  };
});

const clientMetrics = computed(() => {
  if (!newClients.value) return null;
  return {
    last7: newClients.value.filter((c) => within(c.created_at, last7)).length,
    prior7: newClients.value.filter((c) => within(c.created_at, prior7)).length,
  };
});

const revenueMetrics = computed(() => {
  if (!revenueRows.value) return null;
  const sum = (window: { from: Date; to: Date }) =>
    revenueRows
      .value!.filter((txn) => within(txn.created_at, window))
      .flatMap((txn) => txn.transaction_items ?? [])
      .filter((item) => ["service", "product"].includes(item.kind))
      .reduce((total, item) => total + item.total_cents, 0);
  return { last7: sum(last7), prior7: sum(prior7) };
});

// ---------------------------------------------------------------------------
// Trends — the shared rule in app/utils/trend.ts (direction = arrow,
// goodness = colour; invert for no-shows). Counts use the shared
// baseline floor. The no-show trend compares two RATES and revenue two
// CENT totals, so the count floor does not fit them; both pass an
// explicit floor of 1 (any prior value) to keep their old behaviour —
// noted in docs/TODO.md as a consistency gap to close with floors of
// their own kind.
// ---------------------------------------------------------------------------
interface Card {
  label: string;
  value: string;
  subtitle: string;
  trend: Trend | null;
  icon: string;
}

const cards = computed<Card[]>(() => {
  const list: Card[] = [
    {
      label: "Appointments (7 days)",
      value: String(apptMetrics.value.last7),
      subtitle: `${apptMetrics.value.completed7} completed`,
      trend: trend(apptMetrics.value.last7, apptMetrics.value.prior7),
      icon: "lucide:calendar-check",
    },
    {
      label: "Booked ahead (next 7 days)",
      value: String(apptMetrics.value.booked7ahead),
      subtitle: "on the calendar",
      trend: null, // the future has no prior baseline
      icon: "lucide:calendar-clock",
    },
  ];

  if (apptMetrics.value.noShowLast7 !== null) {
    list.push({
      label: "No-show rate (7 days)",
      value: `${apptMetrics.value.noShowLast7}%`,
      subtitle: "of booked appointments",
      trend:
        apptMetrics.value.noShowPrior7 !== null
          ? trend(
              apptMetrics.value.noShowLast7,
              apptMetrics.value.noShowPrior7,
              { invert: true, minBaseline: 1 },
            )
          : null,
      icon: "lucide:user-x",
    });
  }

  if (clientMetrics.value) {
    list.push({
      label: "New clients (7 days)",
      value: String(clientMetrics.value.last7),
      subtitle: "added to the book",
      trend: trend(clientMetrics.value.last7, clientMetrics.value.prior7),
      icon: "lucide:user-plus",
    });
  }

  if (revenueMetrics.value) {
    list.push({
      label: "Revenue (7 days)",
      value: dollars(revenueMetrics.value.last7),
      subtitle: "services + retail",
      trend: trend(revenueMetrics.value.last7, revenueMetrics.value.prior7, {
        minBaseline: 1,
      }),
      icon: "lucide:banknote",
    });
  }

  return list;
});
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
    <UiCard v-for="card in cards" :key="card.label" class="rounded-md">
      <UiCardContent class="p-4">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-muted-foreground text-xs">{{ card.label }}</p>
            <p
              class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
            >
              {{ card.value }}
              <span
                v-if="card.trend"
                class="flex items-center gap-0.5 text-sm font-semibold"
                :class="
                  card.trend.good
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-500 dark:text-red-400'
                "
                title="vs previous 7 days"
              >
                <Icon
                  :name="
                    card.trend.direction === 'up'
                      ? 'lucide:trending-up'
                      : 'lucide:trending-down'
                  "
                  class="size-3.5"
                />
                {{ card.trend.pct }}%
              </span>
            </p>
            <p class="text-muted-foreground mt-1 text-xs">
              {{ card.subtitle }}
            </p>
          </div>
          <Icon
            :name="card.icon"
            class="text-muted-foreground/40 size-6 shrink-0"
          />
        </div>
      </UiCardContent>
    </UiCard>
  </div>
</template>
