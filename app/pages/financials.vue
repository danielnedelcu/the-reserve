<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "financials.view_summary" });
useSeoMeta({ title: "Financials — The Reserve" });

const supabase = useSupabaseClient();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

// ---------------------------------------------------------------------------
// Period state: day / week / month / year, with prev/next navigation
// ---------------------------------------------------------------------------
type Period = "day" | "week" | "month" | "year" | "custom";
const period = ref<Period>("month");

// Custom range (UiDatepicker). Picking dates switches the page into
// "custom" mode; clicking any period button switches back.
function daysAgo(n: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}
const dateRange = ref<{ start: Date; end: Date }>({
  start: daysAgo(6),
  end: daysAgo(0),
});
watch(dateRange, () => (period.value = "custom"), { deep: true });
const PERIODS: { key: Period; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
];

const anchor = ref(new Date());

const range = computed(() => {
  if (period.value === "custom") {
    const from = new Date(dateRange.value.start);
    from.setHours(0, 0, 0, 0);
    const to = new Date(dateRange.value.end);
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() + 1); // inclusive end date
    return { from, to };
  }
  const a = new Date(anchor.value);
  a.setHours(0, 0, 0, 0);
  const from = new Date(a);
  const to = new Date(a);
  if (period.value === "day") {
    to.setDate(to.getDate() + 1);
  } else if (period.value === "week") {
    from.setDate(from.getDate() - from.getDay()); // Sunday start
    to.setTime(from.getTime());
    to.setDate(to.getDate() + 7);
  } else if (period.value === "month") {
    from.setDate(1);
    to.setTime(from.getTime());
    to.setMonth(to.getMonth() + 1);
  } else {
    from.setMonth(0, 1);
    to.setTime(from.getTime());
    to.setFullYear(to.getFullYear() + 1);
  }
  return { from, to };
});

const rangeLabel = computed(() => {
  const { from, to } = range.value;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  if (period.value === "day")
    return from.toLocaleDateString("en-US", { weekday: "long", ...opts });
  if (period.value === "month")
    return from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  if (period.value === "year") return String(from.getFullYear());
  if (period.value === "custom") {
    const end = new Date(to);
    end.setDate(end.getDate() - 1);
    return `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", opts)}`;
  }
  const end = new Date(to);
  end.setDate(end.getDate() - 1);
  return `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", opts)}`;
});

// ---------------------------------------------------------------------------
// Data: ledger + appointments + availability for the window
// ---------------------------------------------------------------------------
const fetchKey = computed(
  () => `${period.value}-${range.value.from.toISOString()}`,
);

const {
  data: ledger,
  refresh: refreshLedger,
  pending: ledgerPending,
} = await useAsyncData(
  () => `fin-ledger-${fetchKey.value}`,
  async () => {
    const { data, error } = await supabase
      .from("transactions")
      .select(
        `id, created_at, total_cents, subtotal_cents, discount_cents, tax_cents, tip_cents,
         refunds_transaction_id, note,
         clients(first_name, last_name),
         cashier:staff!transactions_checked_out_by_fkey(display_name),
         transaction_items(kind, staff_id, name_snapshot, quantity, total_cents, tax_cents),
         payments(method, amount_cents, reference)`,
      )
      .order("created_at", { ascending: false })
      .gte("created_at", range.value.from.toISOString())
      .lt("created_at", range.value.to.toISOString());
    if (error) throw error;
    return data ?? [];
  },
  { watch: [fetchKey] },
);

const { data: appointments } = await useAsyncData(
  () => `fin-appts-${fetchKey.value}`,
  async () => {
    const { data, error } = await supabase
      .from("appointments")
      .select("staff_id, starts_at, ends_at, status")
      .gte("starts_at", range.value.from.toISOString())
      .lt("starts_at", range.value.to.toISOString());
    if (error) throw error;
    return data ?? [];
  },
  { watch: [fetchKey] },
);

const { data: staffList } = await useAsyncData("fin-staff", async () => {
  const { data } = await supabase
    .from("staff")
    .select("id, display_name")
    .eq("active", true)
    .eq("bookable", true)
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
  () => `fin-exceptions-${fetchKey.value}`,
  async () => {
    const { data } = await supabase
      .from("availability_exceptions")
      .select("staff_id, starts_at, ends_at, kind, status")
      .eq("status", "approved")
      .lt("starts_at", range.value.to.toISOString())
      .gte("ends_at", range.value.from.toISOString());
    return data ?? [];
  },
  { watch: [fetchKey] },
);

const { data: giftLiability } = await useAsyncData(
  "fin-gift-liability",
  async () => {
    const { data } = await supabase
      .from("gift_cards")
      .select("balance_cents")
      .eq("active", true);
    return (data ?? []).reduce((sum, card) => sum + card.balance_cents, 0);
  },
);

// ---------------------------------------------------------------------------
// Previous period (same length, immediately before) for trend indicators
// ---------------------------------------------------------------------------
const prevRange = computed(() => {
  const span = range.value.to.getTime() - range.value.from.getTime();
  return {
    from: new Date(range.value.from.getTime() - span),
    to: new Date(range.value.from.getTime()),
  };
});

const { data: prevLedger } = await useAsyncData(
  () => `fin-prev-ledger-${fetchKey.value}`,
  async () => {
    const { data, error } = await supabase
      .from("transactions")
      .select(
        "total_cents, discount_cents, tax_cents, refunds_transaction_id, transaction_items(kind, total_cents)",
      )
      .gte("created_at", prevRange.value.from.toISOString())
      .lt("created_at", prevRange.value.to.toISOString());
    if (error) throw error;
    return data ?? [];
  },
  { watch: [fetchKey] },
);

// ---------------------------------------------------------------------------
// Financial rollups (refund rows carry negative amounts, so plain sums
// net refunds automatically; gift_card SALE items are excluded from revenue)
// ---------------------------------------------------------------------------
const money = computed(() => {
  const summary = {
    serviceRevenue: 0,
    retailRevenue: 0,
    tips: 0,
    discounts: 0,
    taxCollected: 0,
    giftCardsSold: 0,
    refundTotal: 0,
    txnCount: 0,
    positiveTxnTotal: 0,
  };
  for (const txn of ledger.value ?? []) {
    if (txn.refunds_transaction_id) {
      summary.refundTotal += -txn.total_cents;
    } else {
      summary.txnCount += 1;
      summary.positiveTxnTotal += txn.total_cents;
    }
    summary.discounts += txn.discount_cents;
    summary.taxCollected += txn.tax_cents;
    for (const item of txn.transaction_items ?? []) {
      if (item.kind === "service") summary.serviceRevenue += item.total_cents;
      else if (item.kind === "product")
        summary.retailRevenue += item.total_cents;
      else if (item.kind === "tip") summary.tips += item.total_cents;
      else if (item.kind === "gift_card")
        summary.giftCardsSold += item.total_cents;
    }
  }
  return summary;
});

const revenue = computed(
  () => money.value.serviceRevenue + money.value.retailRevenue,
);
const avgTicket = computed(() =>
  money.value.txnCount
    ? Math.round(money.value.positiveTxnTotal / money.value.txnCount)
    : 0,
);
const retailShare = computed(() =>
  revenue.value
    ? Math.round((money.value.retailRevenue / revenue.value) * 100)
    : 0,
);

// Previous-period rollup (same shape as `money`, lighter fields)
const prevMoney = computed(() => {
  const summary = {
    revenue: 0,
    tips: 0,
    discounts: 0,
    taxCollected: 0,
    refundTotal: 0,
    txnCount: 0,
    giftCardsSold: 0,
  };
  for (const txn of prevLedger.value ?? []) {
    if (txn.refunds_transaction_id) summary.refundTotal += -txn.total_cents;
    else summary.txnCount += 1;
    summary.discounts += txn.discount_cents;
    summary.taxCollected += txn.tax_cents;
    for (const item of txn.transaction_items ?? []) {
      if (item.kind === "service" || item.kind === "product")
        summary.revenue += item.total_cents;
      else if (item.kind === "tip") summary.tips += item.total_cents;
      else if (item.kind === "gift_card")
        summary.giftCardsSold += item.total_cents;
    }
  }
  return summary;
});

// Trend: percent change vs previous period.
// `invert` flips goodness for metrics where UP is BAD (refunds, discounts).
interface Trend {
  pct: number;
  up: boolean;
  good: boolean;
}
function trend(
  current: number,
  previous: number,
  invert = false,
): Trend | null {
  if (!previous) return null; // no prior data: show nothing rather than a fake ∞%
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return null;
  const up = pct > 0;
  return { pct: Math.abs(pct), up, good: invert ? !up : up };
}

const trends = computed(() => ({
  revenue: trend(revenue.value, prevMoney.value.revenue),
  txns: trend(money.value.txnCount, prevMoney.value.txnCount),
  tips: trend(money.value.tips, prevMoney.value.tips),
  tax: trend(money.value.taxCollected, prevMoney.value.taxCollected),
  discounts: trend(money.value.discounts, prevMoney.value.discounts, true),
  refunds: trend(money.value.refundTotal, prevMoney.value.refundTotal, true),
  giftSold: trend(money.value.giftCardsSold, prevMoney.value.giftCardsSold),
}));

// ---------------------------------------------------------------------------
// Provider utilization
// booked minutes ÷ scheduled minutes, where scheduled = weekly rules expanded
// over the period, minus approved time off (extra shifts add time).
// ---------------------------------------------------------------------------
function overlapMinutes(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date) {
  const start = Math.max(aFrom.getTime(), bFrom.getTime());
  const end = Math.min(aTo.getTime(), bTo.getTime());
  return Math.max(0, (end - start) / 60_000);
}

const utilization = computed(() => {
  const now = new Date();
  const effectiveTo = range.value.to < now ? range.value.to : now; // don't count the unarrived future
  const rows = (staffList.value ?? []).map((member) => {
    // scheduled minutes: expand weekly rules across the period's elapsed days
    let scheduled = 0;
    const cursor = new Date(range.value.from);
    while (cursor < effectiveTo) {
      const dow = cursor.getDay();
      for (const rule of (rules.value ?? []).filter(
        (r) => r.staff_id === member.id && r.day_of_week === dow,
      )) {
        const [sh, sm] = rule.start_time.split(":").map(Number);
        const [eh, em] = rule.end_time.split(":").map(Number);
        const ruleFrom = new Date(cursor);
        ruleFrom.setHours(sh!, sm!, 0, 0);
        const ruleTo = new Date(cursor);
        ruleTo.setHours(eh!, em!, 0, 0);
        let minutes = Math.max(
          0,
          (ruleTo.getTime() - ruleFrom.getTime()) / 60_000,
        );
        // subtract approved time off overlapping this rule window
        for (const exception of (exceptions.value ?? []).filter(
          (e) => e.staff_id === member.id && e.kind !== "extra_shift",
        )) {
          minutes -= overlapMinutes(
            ruleFrom,
            ruleTo,
            new Date(exception.starts_at),
            new Date(exception.ends_at),
          );
        }
        scheduled += Math.max(0, minutes);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    // extra shifts add scheduled time
    for (const exception of (exceptions.value ?? []).filter(
      (e) => e.staff_id === member.id && e.kind === "extra_shift",
    )) {
      scheduled += overlapMinutes(
        range.value.from,
        effectiveTo,
        new Date(exception.starts_at),
        new Date(exception.ends_at),
      );
    }

    // booked minutes + outcome counts
    let booked = 0;
    let completed = 0;
    let noShows = 0;
    let cancelled = 0;
    for (const appt of (appointments.value ?? []).filter(
      (a) => a.staff_id === member.id,
    )) {
      if (appt.status === "cancelled") {
        cancelled += 1;
        continue;
      }
      if (appt.status === "no_show") {
        noShows += 1;
        continue;
      }
      booked +=
        (new Date(appt.ends_at).getTime() -
          new Date(appt.starts_at).getTime()) /
        60_000;
      if (appt.status === "completed") completed += 1;
    }

    // revenue + tips attributed from the ledger
    let svcRevenue = 0;
    let tipTotal = 0;
    for (const txn of ledger.value ?? []) {
      for (const item of txn.transaction_items ?? []) {
        if (item.staff_id !== member.id) continue;
        if (item.kind === "service") svcRevenue += item.total_cents;
        else if (item.kind === "tip") tipTotal += item.total_cents;
      }
    }

    return {
      id: member.id,
      name: member.display_name,
      scheduledMin: Math.round(scheduled),
      bookedMin: Math.round(booked),
      pct: scheduled > 0 ? Math.round((booked / scheduled) * 100) : null,
      completed,
      noShows,
      cancelled,
      svcRevenue,
      tipTotal,
    };
  });
  return rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
});

const hoursLabel = (minutes: number) => `${(minutes / 60).toFixed(1)}h`;

// ---------------------------------------------------------------------------
// Transactions table (period-scoped, searchable)
// ---------------------------------------------------------------------------
const search = ref("");

const METHOD_LABELS: Record<string, string> = {
  card_external: "Card",
  gift_card: "Gift card",
  cash: "Cash",
};

function txnClient(txn: Record<string, any>) {
  return txn.clients
    ? `${txn.clients.first_name} ${txn.clients.last_name}`
    : "Walk-in";
}
function txnWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function txnItemsSummary(txn: Record<string, any>) {
  const names = (txn.transaction_items ?? [])
    .filter((item: any) => !["tip", "discount"].includes(item.kind))
    .map((item: any) => item.name_snapshot);
  if (!names.length) return "—";
  return names.length > 2
    ? `${names[0]} +${names.length - 1} more`
    : names.join(", ");
}

const filteredTransactions = computed(() => {
  const q = search.value.trim().toLowerCase();
  const rows = (ledger.value ?? []) as Record<string, any>[];
  if (!q) return rows;
  return rows.filter((txn) => {
    const haystack = [
      txnClient(txn),
      txn.cashier?.display_name ?? "",
      txn.note ?? "",
      (txn.total_cents / 100).toFixed(2),
      ...(txn.transaction_items ?? []).map((item: any) => item.name_snapshot),
      ...(txn.payments ?? []).map(
        (p: any) =>
          `${METHOD_LABELS[p.method] ?? p.method} ${p.reference ?? ""}`,
      ),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
});

// ---------------------------------------------------------------------------
// TanStack table: columns (sortable when/client/total), row-action menu
// ---------------------------------------------------------------------------
const { can } = usePermissions();
const toast = useToast();

type Txn = Record<string, any>;

const txnColumns = [
  {
    id: "when",
    accessorFn: (txn: Txn) => txn.created_at,
    header: "When",
    enableSorting: true,
  },
  {
    id: "client",
    accessorFn: (txn: Txn) => txnClient(txn),
    header: "Client",
    enableSorting: true,
  },
  { id: "items", header: "Items", enableSorting: false },
  { id: "payment", header: "Payment", enableSorting: false },
  {
    id: "total",
    accessorFn: (txn: Txn) => txn.total_cents,
    header: "Total",
    enableSorting: true,
  },
  { id: "actions", header: "", enableSorting: false },
];

// Provider utilization columns (numeric accessors so sorting is arithmetic)
type UtilRow = {
  id: string;
  name: string;
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
  {
    id: "name",
    accessorFn: (r: UtilRow) => r.name,
    header: "Provider",
    enableSorting: true,
  },
  {
    id: "pct",
    accessorFn: (r: UtilRow) => r.pct ?? -1,
    header: "Utilization",
    enableSorting: true,
  },
  {
    id: "hours",
    accessorFn: (r: UtilRow) => r.bookedMin,
    header: "Booked / scheduled",
    enableSorting: true,
  },
  {
    id: "completed",
    accessorFn: (r: UtilRow) => r.completed,
    header: "Completed",
    enableSorting: true,
  },
  {
    id: "noShows",
    accessorFn: (r: UtilRow) => r.noShows,
    header: "No-shows",
    enableSorting: true,
  },
  {
    id: "cancelled",
    accessorFn: (r: UtilRow) => r.cancelled,
    header: "Cancelled",
    enableSorting: true,
  },
  {
    id: "svcRevenue",
    accessorFn: (r: UtilRow) => r.svcRevenue,
    header: "Service revenue",
    enableSorting: true,
  },
  {
    id: "tips",
    accessorFn: (r: UtilRow) => r.tipTotal,
    header: "Tips",
    enableSorting: true,
  },
];

// ids of transactions already refunded (within the loaded period)
const refundedIds = computed(() => {
  const ids = new Set<string>();
  for (const txn of (ledger.value ?? []) as Txn[]) {
    if (txn.refunds_transaction_id) ids.add(txn.refunds_transaction_id);
  }
  return ids;
});

function refundable(txn: Txn) {
  return (
    can("pos.refund") &&
    !txn.refunds_transaction_id &&
    !refundedIds.value.has(txn.id) &&
    txn.total_cents > 0
  );
}

// View
const detail = ref<Txn | null>(null);

// Refund
const refunding = ref(false);
const confirmingRefund = ref(false);

// leaving the dialog or switching transactions resets the confirm state
watch(detail, () => (confirmingRefund.value = false));

async function refundTxn() {
  const txn = detail.value;
  if (!txn) return;
  confirmingRefund.value = false;
  refunding.value = true;
  try {
    await $fetch(`/api/transactions/${txn.id}/refund`, { method: "POST" });
    toast.success("Refunded", dollars(txn.total_cents));
    detail.value = null;
    await refreshLedger();
  } catch (error: unknown) {
    const err = error as { data?: { statusMessage?: string } };
    toast.error("Refund failed", err.data?.statusMessage ?? "Unknown error");
  } finally {
    refunding.value = false;
  }
}

// Printable receipt (browser print dialog — save as PDF from there)
function printReceipt(txn: Txn) {
  const rows = (txn.transaction_items ?? [])
    .map(
      (item: Txn) =>
        `<tr><td style="padding:4px 0;">${item.name_snapshot}${item.quantity > 1 ? ` × ${item.quantity}` : ""}</td>
         <td style="padding:4px 0;text-align:right;">${dollars(item.total_cents + item.tax_cents)}</td></tr>`,
    )
    .join("");
  const pays = (txn.payments ?? [])
    .map(
      (p: Txn) =>
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
      <script>window.print();<\/script>
    </body></html>`);
  win.document.close();
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Financials</h1>
        <p class="text-muted-foreground mt-1 text-sm">{{ rangeLabel }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex rounded-lg border p-0.5">
          <button
            v-for="option in PERIODS"
            :key="option.key"
            class="rounded-md px-3 py-1 text-sm transition"
            :class="
              period === option.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-secondary'
            "
            @click="period = option.key"
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
              <span class="hidden sm:inline">
                {{
                  dateRange.start.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                }}
                –
                {{
                  dateRange.end.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                }}
              </span>
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
          {{ dollars(revenue) }}
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
                trends.revenue.up
                  ? 'lucide:trending-up'
                  : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.revenue.pct }}%
          </span>
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          {{ dollars(money.serviceRevenue) }} services ·
          {{ dollars(money.retailRevenue) }} retail
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Transactions</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
        >
          {{ money.txnCount }}
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
                trends.txns.up ? 'lucide:trending-up' : 'lucide:trending-down'
              "
              class="size-3.5"
            />
            {{ trends.txns.pct }}%
          </span>
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          avg ticket {{ dollars(avgTicket) }}
        </p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Tips</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
        >
          {{ dollars(money.tips) }}
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
                trends.tips.up ? 'lucide:trending-up' : 'lucide:trending-down'
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
          {{ dollars(giftLiability ?? 0) }}
        </p>
        <p class="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
          outstanding balances · {{ dollars(money.giftCardsSold) }} sold this
          period
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
                trends.giftSold.up
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
    <div class="mt-4 grid gap-4 sm:grid-cols-3">
      <div class="rounded-xl border bg-card p-4">
        <p class="text-muted-foreground text-xs">Tax collected</p>
        <p
          class="mt-1 flex items-baseline gap-2 text-lg font-semibold tabular-nums"
        >
          {{ dollars(money.taxCollected) }}
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
                trends.tax.up ? 'lucide:trending-up' : 'lucide:trending-down'
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
          {{ dollars(money.discounts) }}
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
                trends.discounts.up
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
        <p class="text-muted-foreground text-xs">Refunds</p>
        <p
          class="text-destructive mt-1 flex items-baseline gap-2 text-lg font-semibold tabular-nums"
        >
          {{ dollars(money.refundTotal) }}
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
                trends.refunds.up
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
    <div v-if="revenue" class="mt-4 rounded-xl border bg-card p-4">
      <div class="flex justify-between text-xs">
        <span>Services {{ 100 - retailShare }}%</span>
        <span>Retail {{ retailShare }}%</span>
      </div>
      <div class="bg-secondary mt-2 flex h-2.5 overflow-hidden rounded-full">
        <div class="bg-primary" :style="{ width: `${100 - retailShare}%` }" />
        <div class="bg-primary/40" :style="{ width: `${retailShare}%` }" />
      </div>
    </div>

    <!-- Transactions (period-scoped, searchable, sortable) -->
    <section class="mt-8">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-medium">Transactions</h2>
        <UiInput
          v-model="search"
          placeholder="Search client, item, amount, reference…"
          class="max-w-xs"
        />
      </div>
      <div class="mt-3 border bg-card">
        <UiTanStackTable
          :data="filteredTransactions"
          :columns="txnColumns"
          :loading="ledgerPending"
          :show-selected-count="false"
          :show-rows-per-page="false"
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
              v-else-if="refundedIds.has(row.original.id)"
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
                (row.original.payments ?? [])
                  .map((p: any) => METHOD_LABELS[p.method] ?? p.method)
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
                <UiButton variant="ghost" size="icon-sm" class="rounded-full">
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
        </UiTanStackTable>
      </div>
    </section>

    <!-- Provider utilization -->
    <section class="mt-8">
      <h2 class="font-medium">Provider utilization</h2>
      <p class="text-muted-foreground mt-1 text-xs">
        Booked hours ÷ scheduled hours (weekly availability minus approved time
        off, through {{ period === "day" ? "the day" : "today" }}). Healthy spa
        range is roughly 65–85%.
      </p>
      <div class="mt-3 border bg-card">
        <UiTanStackTable
          :data="utilization"
          :columns="utilColumns"
          :show-selected-count="false"
          :show-rows-per-page="false"
          :show-pagination="false"
        >
          <template #name-cell="{ row }">
            <span class="font-medium">{{ row.original.name }}</span>
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
              :class="row.original.noShows && 'text-destructive'"
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
          <template #footer="{ table }">
            <div
              class="text-muted-foreground flex w-full items-center justify-between border-t px-4 py-3 text-sm"
            >
              <p>
                Page {{ table.getState().pagination.pageIndex + 1 }} of
                {{ table.getPageCount() }}
              </p>
              <div class="flex items-center gap-2">
                <UiButton
                  variant="outline"
                  size="sm"
                  :disabled="!table.getCanPreviousPage()"
                  @click="table.previousPage()"
                >
                  Previous
                </UiButton>
                <UiButton
                  variant="outline"
                  size="sm"
                  :disabled="!table.getCanNextPage()"
                  @click="table.nextPage()"
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
            {{ detail.cashier?.display_name ?? "—" }}
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
                v-for="(item, i) in detail.transaction_items"
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
