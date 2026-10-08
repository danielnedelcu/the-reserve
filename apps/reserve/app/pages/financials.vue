<script setup lang="ts">
import { formatCount } from "~~/shared/format/count";
import { dateTimeLabel } from "~~/shared/time/format";
import { pickedKey, pickerDate } from "~~/shared/time/picker";
import { oneOf, uuid, day } from "~~/shared/tables/url";
import { localToUtc, dayOfWeek } from "~~/shared/time/zone";
import {
  periodFromQuery,
  periodRange,
  previousPeriod,
  shiftDays,
  shiftPeriod,
  todayKey,
  DEFAULT_PERIOD,
  type PeriodKind,
} from "~~/shared/time/period";

// Both keys (build order step 3): the summary permission for the page,
// and the ledger's read permission for every figure on it — a holder of
// one without the other would see zeros with no error. The nav and the
// command palette gate the same way.
definePageMeta({
  middleware: "can",
  permission: ["financials.view_summary", "transactions.view"],
});
useSeoMeta({ title: "Financials — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

// ---------------------------------------------------------------------------
// The location's zone: every day and every window on this page is the
// location's (CLAUDE.md, business time), known before anything loads.
// ---------------------------------------------------------------------------
const { data: timezone } = await useLocationTimezone();
const tz = () => timezone.value;

// ---------------------------------------------------------------------------
// The URL is the state (docs/design/server-tables-design.md, decision 3):
// `period` + `anchor` (anchor dropped when it is today, period dropped
// when it is the default month), or `from`/`to` for a custom range of
// inclusive days. They are table filters, so a change of period goes
// through the same checked URL state as a filter, resets the page, pushes
// history (Back walks back through periods), and reloads the rows.
// The range is derived ONCE from that state and drives the table AND the
// totals; transactions_page never re-derives it.
// ---------------------------------------------------------------------------
interface TxnRow {
  id: string;
  created_at: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  refunds_transaction_id: string | null;
  /** Any refund references this transaction, whenever it was issued. */
  refunded: boolean;
  note: string | null;
  /** True for a real client even when `client` is null (the caller may not read clients). */
  has_client: boolean;
  client: { first_name: string; last_name: string } | null;
  cashier_id: string;
  cashier: string | null;
  items: { kind: string; name_snapshot: string; quantity: number; total_cents: number; tax_cents: number; staff_id: string | null }[];
  payments: { method: string; amount_cents: number; reference: string | null }[];
}
interface Totals {
  service_cents: number;
  retail_cents: number;
  revenue_cents: number;
  tips_cents: number;
  discounts_cents: number;
  tax_cents: number;
  gift_cards_sold_cents: number;
  fees_cents: number;
  refunds_cents: number;
  txn_count: number;
  avg_ticket_cents: number;
}
interface ByStaff {
  staff_id: string;
  display_name: string | null;
  active: boolean | null;
  service_cents: number;
  tips_cents: number;
}
const EMPTY_TOTALS: Totals = {
  service_cents: 0, retail_cents: 0, revenue_cents: 0, tips_cents: 0, discounts_cents: 0, tax_cents: 0,
  gift_cards_sold_cents: 0, fees_cents: 0, refunds_cents: 0, txn_count: 0, avg_ticket_cents: 0,
};

const METHODS = ["card_external", "gift_card", "cash", "stripe_card"] as const;
const METHOD_LABELS: Record<string, string> = {
  card_external: "Card",
  gift_card: "Gift card",
  cash: "Cash",
  stripe_card: "Card (Stripe)",
};

const table = await useServerTable({
  key: "financials-transactions",
  filters: {
    period: oneOf("day", "week", "month", "year"),
    anchor: day,
    from: day,
    to: day,
    kind: oneOf("sale", "refund", "fee"),
    method: oneOf(...METHODS),
    staff: uuid,
  },
  sorts: ["when", "client", "total"] as const,
  defaultDesc: true,
  async load({ q, filters, page, sort, desc }, signal) {
    const r = periodRange(periodFromQuery(filters, tz()), tz());
    const { data, error } = await supabase
      .rpc("transactions_page", {
        p_from: r.from.toISOString(),
        p_to: r.to.toISOString(),
        p_q: q || undefined,
        p_kind: filters.kind ?? undefined,
        p_method: filters.method ?? undefined,
        p_staff_id: filters.staff ?? undefined,
        p_sort: sort,
        p_desc: desc,
        p_page: page,
        p_page_size: 25,
      })
      .abortSignal(signal);
    return asServerPage<TxnRow>(data, error);
  },
});

const spec = computed(() => periodFromQuery(table.query.value.filters, tz()));
const range = computed(() => periodRange(spec.value, tz()));
const period = computed<PeriodKind | "custom">(() => ("period" in spec.value ? spec.value.period : "custom"));
const rangeLabel = computed(() => range.value.label);

const PERIODS: { key: PeriodKind; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
];
function periodFilters(kind: PeriodKind, anchor: string) {
  return {
    period: kind === DEFAULT_PERIOD ? null : kind,
    anchor: anchor === todayKey(tz()) ? null : anchor,
    from: null,
    to: null,
  };
}
function setPeriod(kind: PeriodKind) {
  const anchor = "period" in spec.value ? spec.value.anchor : range.value.fromKey;
  return table.setFilters(periodFilters(kind, anchor));
}
function step(delta: number) {
  if ("period" in spec.value) {
    return table.setFilters(periodFilters(spec.value.period, shiftPeriod(spec.value.period, spec.value.anchor, delta)));
  }
  // A custom range steps by its own length.
  const days = Math.round((Date.parse(range.value.toKey) - Date.parse(range.value.fromKey)) / 86_400_000) + 1;
  return table.setFilters({ from: shiftDays(range.value.fromKey, days * delta), to: shiftDays(range.value.toKey, days * delta), period: null, anchor: null });
}

// The picker works in browser Dates; what matters is the calendar day
// picked, read back as a key — through shared/time/picker.ts, the one
// bridge between keys and a picker's Dates. The picker ECHOES its model back through v-model whenever the model
// changes (a period button, Back), so an "update" equal to the current
// range is the echo and is ignored; only a different pair is a pick.
const dateRange = computed({
  get: () => ({ start: pickerDate(range.value.fromKey), end: pickerDate(range.value.toKey) }),
  set: (r: { start: Date; end: Date }) => {
    const from = pickedKey(r.start);
    const to = pickedKey(r.end);
    if (from === range.value.fromKey && to === range.value.toKey) return;
    void table.setFilters({ from, to, period: null, anchor: null });
  },
});

const kindFilter = computed({
  get: () => table.query.value.filters.kind ?? "any",
  set: (v: string) => void table.setFilter("kind", v === "any" ? null : v),
});
const methodFilter = computed({
  get: () => table.query.value.filters.method ?? "any",
  set: (v: string) => void table.setFilter("method", v === "any" ? null : v),
});
const staffFilter = computed({
  get: () => table.query.value.filters.staff ?? "any",
  set: (v: string) => void table.setFilter("staff", v === "any" ? null : v),
});

// ---------------------------------------------------------------------------
// The totals: the SAME function the table reads, over every match in the
// range (no search, no filter), one row asked for. The previous period
// the same way. There is no second revenue calculation.
// ---------------------------------------------------------------------------
const rangeKey = computed(() => `${range.value.from.toISOString()}-${range.value.to.toISOString()}`);
async function totalsFor(from: Date, to: Date): Promise<{ totals: Totals; by_staff: ByStaff[] }> {
  const { data, error } = await supabase.rpc("transactions_page", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_page_size: 1,
  });
  if (error) throw error;
  const page = data as { totals?: Totals; by_staff?: ByStaff[] } | null;
  return { totals: page?.totals ?? EMPTY_TOTALS, by_staff: page?.by_staff ?? [] };
}
const { data: summary } = await useAsyncData(
  () => `fin-totals-${rangeKey.value}`,
  () => totalsFor(range.value.from, range.value.to),
  { watch: [rangeKey], default: () => ({ totals: EMPTY_TOTALS, by_staff: [] as ByStaff[] }) },
);
const { data: previous } = await useAsyncData(
  () => `fin-prev-totals-${rangeKey.value}`,
  () => {
    const p = periodRange(previousPeriod(spec.value), tz());
    return totalsFor(p.from, p.to);
  },
  { watch: [rangeKey], default: () => ({ totals: EMPTY_TOTALS, by_staff: [] as ByStaff[] }) },
);
const money = computed(() => summary.value.totals);
const prevMoney = computed(() => previous.value.totals);

const retailShare = computed(() =>
  money.value.revenue_cents ? Math.round((money.value.retail_cents / money.value.revenue_cents) * 100) : 0,
);

// Gift-card liability: summed in Postgres (gift_card_liability), all-time.
const { data: giftLiability } = await useAsyncData("fin-gift-liability", async () => {
  if (!can("gift_cards.view")) return null;
  const { data, error } = await supabase.rpc("gift_card_liability");
  if (error) throw error;
  return data as { active_cards: number; liability_cents: number } | null;
});

// Trends: the shared rule (app/utils/trend.ts) with its floor, replacing
// a page-local copy. invert: for discounts and refunds, up is not good.
const trends = computed(() => ({
  revenue: trend(money.value.revenue_cents, prevMoney.value.revenue_cents),
  txns: trend(money.value.txn_count, prevMoney.value.txn_count),
  tips: trend(money.value.tips_cents, prevMoney.value.tips_cents),
  tax: trend(money.value.tax_cents, prevMoney.value.tax_cents),
  discounts: trend(money.value.discounts_cents, prevMoney.value.discounts_cents, { invert: true }),
  refunds: trend(money.value.refunds_cents, prevMoney.value.refunds_cents, { invert: true }),
  fees: trend(money.value.fees_cents, prevMoney.value.fees_cents),
  giftSold: trend(money.value.gift_cards_sold_cents, prevMoney.value.gift_cards_sold_cents),
}));

// ---------------------------------------------------------------------------
// Appointments and availability for the window (utilization)
// ---------------------------------------------------------------------------
const { data: appointments } = await useAsyncData(
  () => `fin-appts-${rangeKey.value}`,
  async () => {
    const { data, error } = await supabase
      .from("appointments")
      .select("staff_id, starts_at, ends_at, status")
      .gte("starts_at", range.value.from.toISOString())
      .lt("starts_at", range.value.to.toISOString());
    if (error) throw error;
    return data ?? [];
  },
  { watch: [rangeKey] },
);

const { data: staffList } = await useAsyncData("fin-staff", async () => {
  const { data } = await supabase
    .from("staff")
    .select("id, display_name, active, bookable")
    .order("display_name");
  return data ?? [];
});

const { data: rules } = await useAsyncData("fin-rules", async () => {
  const { data } = await supabase
    .from("availability_rules")
    .select("staff_id, day_of_week, start_time, end_time");
  return data ?? [];
});

const { data: exceptions } = await useAsyncData(
  () => `fin-exceptions-${rangeKey.value}`,
  async () => {
    const { data } = await supabase
      .from("availability_exceptions")
      .select("staff_id, starts_at, ends_at, kind, status")
      .eq("status", "approved")
      .lt("starts_at", range.value.to.toISOString())
      .gte("ends_at", range.value.from.toISOString());
    return data ?? [];
  },
  { watch: [rangeKey] },
);

// ---------------------------------------------------------------------------
// Provider utilization — booked minutes ÷ scheduled minutes, where
// scheduled = weekly rules expanded over the period's elapsed LOCAL days
// in the location's zone (a rule is "Tuesdays 09:00" at the spa), minus
// approved time off (extra shifts add time). Revenue and tips come from
// by_staff, so a provider with lines in the period appears even when
// deactivated; the roster adds the active, bookable ones with none.
// ---------------------------------------------------------------------------
function overlapMinutes(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date) {
  const start = Math.max(aFrom.getTime(), bFrom.getTime());
  const end = Math.min(aTo.getTime(), bTo.getTime());
  return Math.max(0, (end - start) / 60_000);
}

const utilization = computed(() => {
  const now = new Date();
  const effectiveTo = range.value.to < now ? range.value.to : now; // don't count the unarrived future
  const roster = staffList.value ?? [];
  const attributed = summary.value.by_staff;
  const ids = new Set<string>([
    ...roster.filter((s) => s.active && s.bookable).map((s) => s.id),
    ...attributed.map((a) => a.staff_id),
  ]);
  const rows = [...ids].map((id) => {
    const member = roster.find((s) => s.id === id);
    const money = attributed.find((a) => a.staff_id === id);
    const name = member?.display_name ?? money?.display_name ?? "Former staff";

    // scheduled minutes: the rules, day by LOCAL day, until the window ends or now
    let scheduled = 0;
    for (let key = range.value.fromKey; key <= range.value.toKey; key = shiftDays(key, 1)) {
      if (localToUtc(key, "00:00", tz()) >= effectiveTo) break;
      const dow = dayOfWeek(key);
      for (const rule of (rules.value ?? []).filter((r) => r.staff_id === id && r.day_of_week === dow)) {
        const ruleFrom = localToUtc(key, rule.start_time.slice(0, 5), tz());
        const ruleTo = localToUtc(key, rule.end_time.slice(0, 5), tz());
        let minutes = Math.max(0, (Math.min(ruleTo.getTime(), effectiveTo.getTime()) - ruleFrom.getTime()) / 60_000);
        for (const exception of (exceptions.value ?? []).filter((e) => e.staff_id === id && e.kind !== "extra_shift")) {
          minutes -= overlapMinutes(ruleFrom, ruleTo, new Date(exception.starts_at), new Date(exception.ends_at));
        }
        scheduled += Math.max(0, minutes);
      }
    }
    for (const exception of (exceptions.value ?? []).filter((e) => e.staff_id === id && e.kind === "extra_shift")) {
      scheduled += overlapMinutes(range.value.from, effectiveTo, new Date(exception.starts_at), new Date(exception.ends_at));
    }

    let booked = 0;
    let completed = 0;
    let noShows = 0;
    let cancelled = 0;
    for (const appt of (appointments.value ?? []).filter((a) => a.staff_id === id)) {
      if (appt.status === "cancelled") {
        cancelled += 1;
        continue;
      }
      if (appt.status === "no_show") {
        noShows += 1;
        continue;
      }
      booked += (new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()) / 60_000;
      if (appt.status === "completed") completed += 1;
    }

    return {
      id,
      name,
      active: member?.active ?? money?.active ?? false,
      scheduledMin: Math.round(scheduled),
      bookedMin: Math.round(booked),
      pct: scheduled > 0 ? Math.round((booked / scheduled) * 100) : null,
      completed,
      noShows,
      cancelled,
      svcRevenue: money?.service_cents ?? 0,
      tipTotal: money?.tips_cents ?? 0,
    };
  });
  return rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
});

const hoursLabel = (minutes: number) => `${(minutes / 60).toFixed(1)}h`;

// ---------------------------------------------------------------------------
// Transactions table
// ---------------------------------------------------------------------------
function txnClient(txn: TxnRow) {
  if (txn.client) return `${txn.client.first_name} ${txn.client.last_name}`;
  // A real client the caller may not read is not a walk-in.
  return txn.has_client ? "Client hidden" : "Walk-in";
}
/** The moment of sale, at the spa. */
const txnWhen = (iso: string) => dateTimeLabel(iso, tz());
function txnItemsSummary(txn: TxnRow) {
  const names = txn.items
    .filter((item) => !["tip", "discount"].includes(item.kind))
    .map((item) => item.name_snapshot);
  if (!names.length) return "—";
  return names.length > 2 ? `${names[0]} +${names.length - 1} more` : names.join(", ");
}

const txnColumns = [
  { id: "when", header: "When", meta: { sortKey: "when" } },
  { id: "client", header: "Client", meta: { sortKey: "client" } },
  { id: "items", header: "Items" },
  { id: "payment", header: "Payment" },
  { id: "total", header: "Total", meta: { sortKey: "total" } },
  // No header at all, rather than header: "" — TanStack Table v9 renders an
  // empty string as an empty text node on the client while the server emits
  // nothing, which is a hydration mismatch on every page with this column.
  { id: "actions" },
];

type UtilRow = {
  id: string;
  name: string;
  active: boolean;
  scheduledMin: number;
  bookedMin: number;
  pct: number | null;
  completed: number;
  noShows: number;
  cancelled: number;
  svcRevenue: number;
  tipTotal: number;
};

const utilColumns = [
  { id: "name", accessorFn: (r: UtilRow) => r.name, header: "Provider", enableSorting: true },
  { id: "pct", accessorFn: (r: UtilRow) => r.pct ?? -1, header: "Utilization", enableSorting: true },
  { id: "hours", accessorFn: (r: UtilRow) => r.bookedMin, header: "Booked / scheduled", enableSorting: true },
  { id: "completed", accessorFn: (r: UtilRow) => r.completed, header: "Completed", enableSorting: true },
  { id: "noShows", accessorFn: (r: UtilRow) => r.noShows, header: "No-shows", enableSorting: true },
  { id: "cancelled", accessorFn: (r: UtilRow) => r.cancelled, header: "Cancelled", enableSorting: true },
  { id: "svcRevenue", accessorFn: (r: UtilRow) => r.svcRevenue, header: "Service revenue", enableSorting: true },
  { id: "tips", accessorFn: (r: UtilRow) => r.tipTotal, header: "Tips", enableSorting: true },
];

// The row's own flag: a refund issued in any period, not only the loaded one.
function refundable(txn: TxnRow) {
  return can("pos.refund") && !txn.refunds_transaction_id && !txn.refunded && txn.total_cents > 0;
}

// View
const detail = ref<TxnRow | null>(null);

// Refund
const refunding = ref(false);
const confirmingRefund = ref(false);

// leaving the dialog or switching transactions resets the confirm state
watch(detail, () => (confirmingRefund.value = false));

async function refreshAll() {
  await Promise.all([table.refresh(), refreshNuxtData([`fin-totals-${rangeKey.value}`, `fin-prev-totals-${rangeKey.value}`])]);
}

async function refundTxn() {
  const txn = detail.value;
  if (!txn) return;
  confirmingRefund.value = false;
  refunding.value = true;
  try {
    await $fetch(`/api/transactions/${txn.id}/refund`, { method: "POST" });
    toast.success("Refunded", dollars(txn.total_cents));
    detail.value = null;
    await refreshAll();
  } catch (error: unknown) {
    const err = error as { data?: { statusMessage?: string } };
    toast.error("Refund failed", err.data?.statusMessage ?? "Unknown error");
  } finally {
    refunding.value = false;
  }
}

// Printable receipt (browser print dialog — save as PDF from there)
function printReceipt(txn: TxnRow) {
  const rows = txn.items
    .map(
      (item) =>
        `<tr><td style="padding:4px 0;">${item.name_snapshot}${item.quantity > 1 ? ` × ${item.quantity}` : ""}</td>
         <td style="padding:4px 0;text-align:right;">${dollars(item.total_cents + item.tax_cents)}</td></tr>`,
    )
    .join("");
  const pays = txn.payments
    .map(
      (p) =>
        `<tr><td style="padding:2px 0;color:#666;">${METHOD_LABELS[p.method] ?? p.method}${p.reference ? ` · ${p.reference}` : ""}</td>
         <td style="padding:2px 0;text-align:right;color:#666;">${dollars(p.amount_cents)}</td></tr>`,
    )
    .join("");
  const win = window.open("", "_blank", "width=420,height=640");
  if (!win)
    return toast.error("Popup blocked", "Allow popups to print receipts.");
  win.document.write(`<!doctype html><html><head><title>Receipt</title></head>
    <body style="font-family:Georgia,serif;max-width:360px;margin:24px auto;color:#2a2419;">
      <h2 style="letter-spacing:0.15em;font-weight:normal;text-align:center;">THE RESERVE</h2>
      <p style="text-align:center;color:#666;font-size:13px;">${txnWhen(txn.created_at)} · ${txnClient(txn)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;margin:12px 0;">${rows}</table>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">${pays}</table>
      <p style="text-align:right;font-size:16px;margin-top:8px;">Total: <strong>${dollars(txn.total_cents)}</strong></p>
      <script>window.print();</scr${""}ipt>
    </body></html>`);
  win.document.close();
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Financials</h1>
        <p class="text-muted-foreground mt-1 text-sm" data-range-label>{{ rangeLabel }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-1">
          <UiButton variant="outline" size="sm" aria-label="Previous period" @click="step(-1)">
            <Icon name="lucide:chevron-left" class="size-4" />
          </UiButton>
          <UiButton variant="outline" size="sm" aria-label="Next period" @click="step(1)">
            <Icon name="lucide:chevron-right" class="size-4" />
          </UiButton>
        </div>
        <div class="flex rounded-lg border p-0.5" role="group" aria-label="Period">
          <button
            v-for="option in PERIODS"
            :key="option.key"
            type="button"
            class="rounded-md px-3 py-1 text-sm transition"
            :class="
              period === option.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-secondary'
            "
            :aria-pressed="period === option.key"
            @click="setPeriod(option.key)"
          >
            {{ option.label }}
          </button>
        </div>
        <UiDatepicker v-model.range="dateRange" :columns="2">
          <template #default="{ togglePopover }">
            <UiButton
              variant="outline"
              size="sm"
              class="gap-2"
              :class="period === 'custom' && 'border-primary text-foreground'"
              @click="togglePopover"
            >
              <Icon
                name="lucide:calendar-range"
                class="text-muted-foreground size-4"
              />
              <span class="hidden sm:inline">{{ period === "custom" ? rangeLabel : "Custom dates" }}</span>
              <span class="sm:hidden">Dates</span>
            </UiButton>
          </template>
        </UiDatepicker>
      </div>
    </div>

    <!-- Headline cards -->
    <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Revenue</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
        >
          {{ dollars(money.revenue_cents) }}
          <span
            v-if="trends.revenue"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.revenue.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.revenue.direction === 'up'
                  ? 'lucide:trending-up'
                  : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.revenue.pct }}%
          </span>
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          {{ dollars(money.service_cents) }} services ·
          {{ dollars(money.retail_cents) }} retail
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Transactions</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
        >
          {{ money.txn_count }}
          <span
            v-if="trends.txns"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.txns.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.txns.direction === 'up' ? 'lucide:trending-up' : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.txns.pct }}%
          </span>
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          avg ticket {{ dollars(money.avg_ticket_cents) }}
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Tips</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
        >
          {{ dollars(money.tips_cents) }}
          <span
            v-if="trends.tips"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.tips.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.tips.direction === 'up' ? 'lucide:trending-up' : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.tips.pct }}%
          </span>
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          pass-through to providers
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Gift card liability</p>
        <p class="mt-1 text-2xl font-semibold tabular-nums">
          {{ giftLiability ? dollars(giftLiability.liability_cents) : "—" }}
        </p>
        <p class="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
          <template v-if="giftLiability">{{ giftLiability.active_cards }} active cards ·</template>
          {{ dollars(money.gift_cards_sold_cents) }} sold this period
          <span
            v-if="trends.giftSold"
            class="flex items-center gap-0.5 font-semibold"
            :class="
              trends.giftSold.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.giftSold.direction === 'up'
                  ? 'lucide:trending-up'
                  : 'lucide:trending-down'
              "
              class="size-3"
            />
            {{ trends.giftSold.pct }}%
          </span>
        </p>
      </div>
    </div>

    <!-- Secondary row -->
    <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Tax collected</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-lg font-semibold tabular-nums"
        >
          {{ dollars(money.tax_cents) }}
          <span
            v-if="trends.tax"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.tax.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.tax.direction === 'up' ? 'lucide:trending-up' : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.tax.pct }}%
          </span>
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Discounts given</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-lg font-semibold tabular-nums"
        >
          {{ dollars(money.discounts_cents) }}
          <span
            v-if="trends.discounts"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.discounts.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.discounts.direction === 'up'
                  ? 'lucide:trending-up'
                  : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.discounts.pct }}%
          </span>
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Fees</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-lg font-semibold tabular-nums"
        >
          {{ dollars(money.fees_cents) }}
          <span
            v-if="trends.fees"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.fees.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.fees.direction === 'up' ? 'lucide:trending-up' : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.fees.pct }}%
          </span>
        </p>
        <p class="text-muted-foreground mt-1 text-xs">late-cancellation fees, outside revenue</p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Refunds</p>
        <p
          class="text-destructive mt-1 flex items-baseline gap-2 text-lg font-semibold tabular-nums"
        >
          {{ dollars(money.refunds_cents) }}
          <span
            v-if="trends.refunds"
            class="flex items-center gap-0.5 text-sm font-semibold"
            :class="
              trends.refunds.good
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-500 dark:text-red-400'
            "
            title="vs previous period"
          >
            <Icon
              :name="
                trends.refunds.direction === 'up'
                  ? 'lucide:trending-up'
                  : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.refunds.pct }}%
          </span>
        </p>
      </div>
    </div>

    <!-- Service vs retail bar -->
    <div v-if="money.revenue_cents" class="mt-4 rounded-xl border bg-card p-4">
      <div class="flex justify-between text-xs">
        <span>Services {{ 100 - retailShare }}%</span>
        <span>Retail {{ retailShare }}%</span>
      </div>
      <div class="bg-secondary mt-2 flex h-2.5 overflow-hidden rounded-full">
        <div class="bg-primary" :style="{ width: `${100 - retailShare}%` }" />
        <div class="bg-primary/40" :style="{ width: `${retailShare}%` }" />
      </div>
    </div>

    <!-- Transactions (period-scoped, searched, filtered, sorted and paged in Postgres) -->
    <section class="mt-8">
      <form role="search" class="flex flex-wrap items-center gap-3" @submit.prevent>
        <h2 class="mr-auto font-medium">Transactions</h2>
        <UiSelect v-model="kindFilter">
          <UiSelectTrigger class="w-32" aria-label="Kind" placeholder="Any kind" />
          <UiSelectContent>
            <UiSelectItem value="any" text="Any kind" />
            <UiSelectItem value="sale" text="Sales" />
            <UiSelectItem value="refund" text="Refunds" />
            <UiSelectItem value="fee" text="Fees" />
          </UiSelectContent>
        </UiSelect>
        <UiSelect v-model="methodFilter">
          <UiSelectTrigger class="w-36" aria-label="Payment method" placeholder="Any method" />
          <UiSelectContent>
            <UiSelectItem value="any" text="Any method" />
            <UiSelectItem v-for="m in METHODS" :key="m" :value="m" :text="METHOD_LABELS[m]" />
          </UiSelectContent>
        </UiSelect>
        <UiSelect v-model="staffFilter">
          <UiSelectTrigger class="w-40" aria-label="Staff" placeholder="Any staff" />
          <UiSelectContent>
            <UiSelectItem value="any" text="Any staff" />
            <UiSelectItem v-for="s in staffList" :key="s.id" :value="s.id" :text="s.display_name" />
          </UiSelectContent>
        </UiSelect>
        <TableSearch
          id="transactions-search"
          :value="table.query.value.q"
          placeholder="Search client, item, amount, reference…"
          @search="table.setSearch"
        />
        <p class="text-muted-foreground text-sm" aria-live="polite">
          {{ formatCount(table.total.value) }}
          {{ table.total.value === 1 ? "transaction" : "transactions" }}
        </p>
      </form>
      <p v-if="table.error.value" role="alert" class="text-destructive mt-3 text-sm">
        Could not load transactions.
        {{ (table.error.value as { message?: string }).message ?? "" }}
      </p>
      <div v-else class="mt-3 border rounded-md bg-card">
        <ServerTable
          :rows="table.rows.value"
          :columns="txnColumns"
          :total="table.total.value"
          :page="table.query.value.page"
          :sort="table.query.value.sort"
          :desc="table.query.value.desc"
          :pending="table.pending.value"
          :empty-text="table.filtering.value ? 'No transactions match.' : 'No transactions in this period.'"
          @page="table.setPage"
          @sort="table.setSort"
        >
          <template #when-cell="{ row }">
            <span class="text-muted-foreground whitespace-nowrap">
              {{ txnWhen(row.original.created_at) }}
            </span>
          </template>

          <template #client-cell="{ row }">
            <span class="font-medium">{{ txnClient(row.original) }}</span>
            <span
              v-if="row.original.refunds_transaction_id"
              class="bg-destructive/10 text-destructive ml-1.5 rounded-full px-2 py-0.5 text-xs"
            >
              refund
            </span>
            <span
              v-else-if="row.original.refunded"
              class="bg-secondary text-muted-foreground ml-1.5 rounded-full px-2 py-0.5 text-xs"
            >
              refunded
            </span>
          </template>

          <template #items-cell="{ row }">
            <span class="text-muted-foreground block max-w-56 truncate">
              {{ txnItemsSummary(row.original) }}
            </span>
          </template>

          <template #payment-cell="{ row }">
            <span class="text-muted-foreground">
              {{
                row.original.payments
                  .map((p: TxnRow['payments'][number]) => METHOD_LABELS[p.method] ?? p.method)
                  .join(" + ") || "—"
              }}
            </span>
          </template>

          <template #total-cell="{ row }">
            <span
              class="font-medium tabular-nums"
              :class="row.original.total_cents < 0 && 'text-destructive'"
            >
              {{ dollars(row.original.total_cents) }}
            </span>
          </template>

          <template #actions-cell="{ row }">
            <UiDropdownMenu>
              <UiDropdownMenuTrigger as-child>
                <UiButton variant="ghost" size="icon-sm" class="rounded-full" aria-label="Transaction actions">
                  <Icon
                    name="lucide:ellipsis-vertical"
                    class="text-muted-foreground size-4"
                  />
                </UiButton>
              </UiDropdownMenuTrigger>
              <UiDropdownMenuContent align="end" class="min-w-44">
                <UiDropdownMenuItem
                  icon="lucide:eye"
                  title="View transaction"
                  @select="detail = row.original"
                />
                <UiDropdownMenuItem
                  icon="lucide:receipt-text"
                  title="Print receipt"
                  @select="printReceipt(row.original)"
                />
                <UiDropdownMenuSeparator />
                <UiDropdownMenuItem
                  icon="lucide:rotate-ccw"
                  title="Refund"
                  :disabled="!refundable(row.original)"
                  @select="((detail = row.original), (confirmingRefund = true))"
                />
              </UiDropdownMenuContent>
            </UiDropdownMenu>
          </template>
        </ServerTable>
      </div>
    </section>

    <!-- Provider utilization -->
    <section class="mt-8">
      <h2 class="font-medium">Provider utilization</h2>
      <p class="text-muted-foreground mt-1 text-xs">
        Booked hours ÷ scheduled hours (weekly availability minus approved time
        off, through {{ period === "day" ? "the day" : "today" }}, at the spa's
        clock). Healthy spa range is roughly 65–85%. Revenue and tips are the
        ledger's attribution, so a former provider with sales in the period
        still appears.
      </p>
      <div class="mt-3 border rounded-md bg-card">
        <UiTanStackTable
          :data="utilization"
          :columns="utilColumns"
          :show-selected-count="false"
          :show-rows-per-page="false"
          :show-pagination="false"
        >
          <template #name-cell="{ row }">
            <span class="font-medium" :class="!row.original.active && 'text-muted-foreground'">
              {{ row.original.name }}
              <span v-if="!row.original.active" class="text-xs font-normal"> (inactive)</span>
            </span>
          </template>

          <template #pct-cell="{ row }">
            <div
              v-if="row.original.pct !== null"
              class="flex items-center gap-2"
            >
              <div class="bg-secondary h-1.5 w-20 overflow-hidden rounded-full">
                <div
                  class="bg-primary h-full"
                  :style="{ width: `${Math.min(row.original.pct, 100)}%` }"
                />
              </div>
              <span class="tabular-nums">{{ row.original.pct }}%</span>
            </div>
            <span
              v-else
              class="text-muted-foreground"
              title="No weekly hours set"
              >—</span
            >
          </template>

          <template #hours-cell="{ row }">
            <span class="text-muted-foreground tabular-nums">
              {{ hoursLabel(row.original.bookedMin) }} /
              {{ hoursLabel(row.original.scheduledMin) }}
            </span>
          </template>

          <template #completed-cell="{ row }">
            <span class="tabular-nums">{{ row.original.completed }}</span>
          </template>

          <template #noShows-cell="{ row }">
            <span
              class="tabular-nums"
              :class="row.original.noShows > 0 && 'text-destructive'"
            >
              {{ row.original.noShows }}
            </span>
          </template>

          <template #cancelled-cell="{ row }">
            <span class="text-muted-foreground tabular-nums">{{
              row.original.cancelled
            }}</span>
          </template>

          <template #svcRevenue-cell="{ row }">
            <span class="tabular-nums">{{
              dollars(row.original.svcRevenue)
            }}</span>
          </template>

          <template #tips-cell="{ row }">
            <span class="text-muted-foreground tabular-nums">{{
              dollars(row.original.tipTotal)
            }}</span>
          </template>
          <template #footer="{ table: utilTable }">
            <div
              class="text-muted-foreground flex w-full items-center justify-between border-t px-4 py-3 text-sm"
            >
              <p>
                Page {{ utilTable.atoms.pagination.get().pageIndex + 1 }} of
                {{ utilTable.getPageCount() }}
              </p>
              <div class="flex items-center gap-2">
                <UiButton
                  variant="outline"
                  size="sm"
                  :disabled="!utilTable.getCanPreviousPage()"
                  @click="utilTable.previousPage()"
                >
                  Previous
                </UiButton>
                <UiButton
                  variant="outline"
                  size="sm"
                  :disabled="!utilTable.getCanNextPage()"
                  @click="utilTable.nextPage()"
                >
                  Next
                </UiButton>
              </div>
            </div>
          </template>
        </UiTanStackTable>
      </div>
    </section>

    <!-- Transaction detail dialog -->
    <UiDialog
      :open="!!detail"
      @update:open="(open: boolean) => !open && (detail = null)"
    >
      <UiDialogContent v-if="detail" class="sm:max-w-lg">
        <UiDialogHeader>
          <UiDialogTitle
            >{{ txnClient(detail) }} —
            {{ dollars(detail.total_cents) }}</UiDialogTitle
          >
          <UiDialogDescription>
            {{ txnWhen(detail.created_at) }} · rung up by
            {{ detail.cashier ?? "—" }}
          </UiDialogDescription>
        </UiDialogHeader>
        <div class="space-y-4">
          <div>
            <p
              class="text-muted-foreground text-xs font-medium uppercase tracking-wide"
            >
              Items
            </p>
            <ul class="mt-1.5 divide-y text-sm">
              <li
                v-for="(item, i) in detail.items"
                :key="i"
                class="flex justify-between py-1.5"
              >
                <span :class="item.total_cents < 0 && 'text-destructive'">
                  {{ item.name_snapshot
                  }}<span v-if="item.quantity > 1"> × {{ item.quantity }}</span>
                </span>
                <span class="tabular-nums">{{
                  dollars(item.total_cents + item.tax_cents)
                }}</span>
              </li>
            </ul>
          </div>
          <div>
            <p
              class="text-muted-foreground text-xs font-medium uppercase tracking-wide"
            >
              Payment
            </p>
            <ul class="mt-1.5 text-sm">
              <li
                v-for="(payment, i) in detail.payments"
                :key="i"
                class="flex justify-between py-1"
              >
                <span>
                  {{ METHOD_LABELS[payment.method] ?? payment.method }}
                  <span
                    v-if="payment.reference"
                    class="text-muted-foreground text-xs"
                  >
                    · {{ payment.reference }}
                  </span>
                </span>
                <span class="tabular-nums">{{
                  dollars(payment.amount_cents)
                }}</span>
              </li>
            </ul>
          </div>
          <p v-if="detail.note" class="text-muted-foreground text-sm">
            {{ detail.note }}
          </p>
        </div>
        <UiDialogFooter v-if="!confirmingRefund">
          <UiButton
            v-if="refundable(detail)"
            variant="outline"
            class="text-destructive"
            @click="confirmingRefund = true"
          >
            Refund
          </UiButton>
          <UiButton variant="outline" @click="printReceipt(detail)"
            >Print receipt</UiButton
          >
          <UiButton variant="outline" @click="detail = null">Close</UiButton>
        </UiDialogFooter>

        <div v-else class="space-y-3">
          <div class="flex justify-end gap-2">
            <UiButton variant="outline" @click="confirmingRefund = false"
              >Cancel</UiButton
            >
            <UiButton
              variant="destructive"
              :disabled="refunding"
              :text="
                refunding
                  ? 'Refunding…'
                  : `Refund ${dollars(detail.total_cents)}`
              "
              @click="refundTxn"
            />
          </div>
          <p class="text-muted-foreground text-xs">
            Refunding {{ txnClient(detail) }} ·
            {{ txnWhen(detail.created_at) }}. This creates a permanent refund
            entry, restores product stock and gift card balances, and can't be
            undone.
          </p>
        </div>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
