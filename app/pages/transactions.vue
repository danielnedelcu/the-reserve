<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "transactions.view" });
useSeoMeta({ title: "Transactions — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

interface TxnRow {
  id: string;
  created_at: string;
  total_cents: number;
  tip_cents: number;
  refunds_transaction_id: string | null;
  note: string | null;
  clients: { first_name: string; last_name: string } | null;
  staff: { display_name: string } | null;
  transaction_items: {
    id: string;
    kind: string;
    name_snapshot: string;
    quantity: number;
    total_cents: number;
    tax_cents: number;
  }[];
  payments: {
    id: string;
    method: string;
    amount_cents: number;
    reference: string | null;
  }[];
}

const { data: transactions, refresh } = await useAsyncData(
  "transactions-list",
  async () => {
    const { data, error } = await supabase
      .from("transactions")
      .select(
        `id, created_at, total_cents, tip_cents, refunds_transaction_id, note,
       clients(first_name, last_name),
       staff!transactions_checked_out_by_fkey(display_name),
       transaction_items(id, kind, name_snapshot, quantity, total_cents, tax_cents),
       payments(id, method, amount_cents, reference)`,
      )
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data ?? []) as unknown as TxnRow[];
  },
);

// ids of transactions that HAVE been refunded (a refund row points at them)
const refundedIds = computed(() => {
  const ids = new Set<string>();
  for (const txn of transactions.value ?? []) {
    if (txn.refunds_transaction_id) ids.add(txn.refunds_transaction_id);
  }
  return ids;
});

const METHOD_LABELS: Record<string, string> = {
  card_external: "Card",
  gift_card: "Gift card",
  cash: "Cash",
};

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function clientName(txn: TxnRow) {
  return txn.clients
    ? `${txn.clients.first_name} ${txn.clients.last_name}`
    : "Walk-in";
}

// ---------------------------------------------------------------------------
// Detail dialog + refund
// ---------------------------------------------------------------------------
const detail = ref<TxnRow | null>(null);
const refunding = ref(false);

async function refund(txn: TxnRow) {
  if (
    !confirm(
      `Refund ${dollars(txn.total_cents)} to ${clientName(txn)}? This can't be undone.`,
    )
  )
    return;
  refunding.value = true;
  try {
    await $fetch(`/api/transactions/${txn.id}/refund`, { method: "POST" });
    toast.success("Refunded", dollars(txn.total_cents));
    detail.value = null;
    await refresh();
  } catch (error: unknown) {
    const err = error as { data?: { statusMessage?: string } };
    toast.error("Refund failed", err.data?.statusMessage ?? "Unknown error");
  } finally {
    refunding.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl p-6 md:p-10">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold">Transactions</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          The ledger — most recent 50.
        </p>
      </div>
      <UiButton size="sm" to="/checkout">
        <Icon name="lucide:plus" class="size-4" />
        New sale
      </UiButton>
    </div>

    <ul class="mt-6 space-y-2">
      <li
        v-for="txn in transactions"
        :key="txn.id"
        class="hover:bg-secondary/40 cursor-pointer rounded-xl border bg-card px-5 py-3.5 transition"
        @click="detail = txn"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-medium">
              {{ clientName(txn) }}
              <span
                v-if="txn.refunds_transaction_id"
                class="bg-destructive/10 text-destructive ml-2 rounded-full px-2 py-0.5 text-xs"
              >
                refund
              </span>
              <span
                v-else-if="refundedIds.has(txn.id)"
                class="bg-secondary text-muted-foreground ml-2 rounded-full px-2 py-0.5 text-xs"
              >
                refunded
              </span>
            </p>
            <p class="text-muted-foreground mt-0.5 text-xs">
              {{ when(txn.created_at) }} · rung up by
              {{ txn.staff?.display_name ?? "—" }} ·
              {{
                txn.payments
                  .map((p) => METHOD_LABELS[p.method] ?? p.method)
                  .join(" + ") || "—"
              }}
            </p>
          </div>
          <p
            class="text-sm font-semibold tabular-nums"
            :class="txn.total_cents < 0 && 'text-destructive'"
          >
            {{ dollars(txn.total_cents) }}
          </p>
        </div>
      </li>
      <li
        v-if="!transactions?.length"
        class="text-muted-foreground rounded-xl border border-dashed px-5 py-8 text-center text-sm"
      >
        No transactions yet — the ledger fills as checkouts happen.
      </li>
    </ul>

    <!-- Detail dialog -->
    <UiDialog
      :open="!!detail"
      @update:open="(open: boolean) => !open && (detail = null)"
    >
      <UiDialogContent v-if="detail" class="sm:max-w-lg">
        <UiDialogHeader>
          <UiDialogTitle
            >{{ clientName(detail) }} —
            {{ dollars(detail.total_cents) }}</UiDialogTitle
          >
          <UiDialogDescription>{{
            when(detail.created_at)
          }}</UiDialogDescription>
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
                v-for="item in detail.transaction_items"
                :key="item.id"
                class="flex justify-between py-1.5"
              >
                <span :class="item.total_cents < 0 && 'text-destructive'">
                  {{ item.name_snapshot }}
                  <span v-if="item.quantity > 1" class="text-muted-foreground"
                    >× {{ item.quantity }}</span
                  >
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
                v-for="payment in detail.payments"
                :key="payment.id"
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

        <UiDialogFooter>
          <UiButton
            v-if="
              can('pos.refund') &&
              !detail.refunds_transaction_id &&
              !refundedIds.has(detail.id) &&
              detail.total_cents > 0
            "
            variant="outline"
            class="text-destructive"
            :disabled="refunding"
            :text="refunding ? 'Refunding…' : 'Refund'"
            @click="refund(detail)"
          />
          <UiButton variant="outline" @click="detail = null">Close</UiButton>
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
