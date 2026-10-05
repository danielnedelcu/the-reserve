<script setup lang="ts">
/**
 * GiftCardsSection — the ledger-adjacent gift card registry.
 * Drop into transactions.vue below the transactions list:
 *   <GiftCardsSection v-if="can('gift_cards.view')" class="mt-10" />
 * (RLS enforces the permission regardless; the v-if just hides the shell.)
 */
const supabase = useSupabaseClient();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

interface CardRow {
  id: string;
  code: string;
  initial_balance_cents: number;
  balance_cents: number;
  active: boolean;
  recipient_name: string | null;
  created_at: string;
  purchaser: { id: string; first_name: string; last_name: string } | null;
}

const { data: cards } = await useAsyncData("gift-cards-list", async () => {
  const { data, error } = await supabase
    .from("gift_cards")
    .select(
      "id, code, initial_balance_cents, balance_cents, active, recipient_name, created_at, purchaser:clients(id, first_name, last_name)",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as CardRow[];
});

const search = ref("");
const showSpent = ref(false);

function purchaserName(card: CardRow) {
  return card.purchaser
    ? `${card.purchaser.first_name} ${card.purchaser.last_name}`
    : "—";
}

const visibleCards = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (cards.value ?? []).filter((card) => {
    if (!showSpent.value && (card.balance_cents === 0 || !card.active))
      return false;
    if (!q) return true;
    return [card.code, purchaserName(card), card.recipient_name ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
});

const outstanding = computed(() =>
  (cards.value ?? [])
    .filter((card) => card.active)
    .reduce((sum, card) => sum + card.balance_cents, 0),
);

const revealed = useToggleSet();

function maskCode(code: string) {
  const groups = code.split("-");
  return `${groups[0]}-****-****-****`;
  // last-4 alternative: return `****-****-****-${groups[groups.length - 1]}`;
}
const cardColumns = [
  {
    id: "code",
    accessorFn: (card: CardRow) => card.code,
    header: "Code",
    enableSorting: true,
  },
  {
    id: "balance",
    accessorFn: (card: CardRow) => card.balance_cents,
    header: "Remaining",
    enableSorting: true,
  },
  {
    id: "original",
    accessorFn: (card: CardRow) => card.initial_balance_cents,
    header: "Original",
    enableSorting: true,
  },
  {
    id: "who",
    accessorFn: (card: CardRow) => purchaserName(card),
    header: "Purchaser / recipient",
    enableSorting: true,
  },
  {
    id: "sold",
    accessorFn: (card: CardRow) => card.created_at,
    header: "Sold",
    enableSorting: true,
  },
];

function soldDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="font-medium">Gift cards</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          {{ dollars(outstanding) }} outstanding across active cards.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-4">
        <label
          class="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            v-model="showSpent"
            type="checkbox"
            class="size-4 accent-primary"
          />
          Show spent &amp; inactive
        </label>
        <UiInput
          v-model="search"
          placeholder="Search code or name…"
          class="max-w-56"
        />
      </div>
    </div>

    <div class="mt-3 rounded-xl border bg-card">
      <UiTanStackTable
        :data="visibleCards"
        :columns="cardColumns"
        :show-selected-count="false"
        :show-rows-per-page="false"
      >
        <template #code-cell="{ row }">
          <div class="flex items-center gap-1">
            <span class="font-mono text-xs tracking-wide">
              {{
                revealed.has(row.original.id)
                  ? row.original.code
                  : maskCode(row.original.code)
              }}
            </span>
            <UiTooltip>
              <UiTooltipTrigger as-child>
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground size-6"
                  :aria-label="
                    revealed.has(row.original.id) ? 'Hide code' : 'Show code'
                  "
                  @click="revealed.toggle(row.original.id)"
                >
                  <Icon
                    :name="
                      revealed.has(row.original.id)
                        ? 'lucide:eye-off'
                        : 'lucide:eye'
                    "
                    class="size-3.5"
                  />
                </UiButton>
              </UiTooltipTrigger>
              <UiTooltipContent>
                {{ revealed.has(row.original.id) ? "Hide code" : "Show code" }}
              </UiTooltipContent>
            </UiTooltip>
            <UiBadge
              v-if="!row.original.active"
              variant="outline"
              class="ml-1 rounded-full border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-400"
            >
              inactive
            </UiBadge>
          </div>
        </template>

        <template #balance-cell="{ row }">
          <span
            class="font-medium tabular-nums"
            :class="row.original.balance_cents === 0 && 'text-muted-foreground'"
          >
            {{ dollars(row.original.balance_cents) }}
          </span>
        </template>

        <template #original-cell="{ row }">
          <span class="text-muted-foreground tabular-nums">
            {{ dollars(row.original.initial_balance_cents) }}
          </span>
        </template>

        <template #who-cell="{ row }">
          <NuxtLink
            v-if="row.original.purchaser"
            :to="`/clients/${row.original.purchaser.id}`"
            class="hover:underline"
          >
            {{ purchaserName(row.original) }}
          </NuxtLink>
          <span v-else class="text-muted-foreground">Walk-in</span>
          <p
            v-if="row.original.recipient_name"
            class="text-muted-foreground text-xs"
          >
            for {{ row.original.recipient_name }}
          </p>
        </template>

        <template #sold-cell="{ row }">
          <span class="text-muted-foreground whitespace-nowrap text-xs">
            {{ soldDate(row.original.created_at) }}
          </span>
        </template>
      </UiTanStackTable>
    </div>
  </section>
</template>
