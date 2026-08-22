<script setup lang="ts">
/**
 * GiftCardLookup — the front-desk "how much is left on my card?" answer.
 * Opened from the command palette (and anywhere else via v-model:open).
 * Read-only; gated by gift_cards.view at the RLS layer (the query simply
 * returns nothing for staff without the permission).
 */
const open = defineModel<boolean>("open", { required: true });

const supabase = useSupabaseClient();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

interface CardResult {
  id: string;
  code: string;
  initial_balance_cents: number;
  balance_cents: number;
  active: boolean;
  recipient_name: string | null;
  created_at: string;
  purchaser: { id: string; first_name: string; last_name: string } | null;
}

const code = ref("");
const looking = ref(false);
const searched = ref(false);
const card = ref<CardResult | null>(null);

watch(open, (isOpen) => {
  if (!isOpen) {
    code.value = "";
    card.value = null;
    searched.value = false;
  }
});

async function lookup() {
  const query = code.value.trim().toUpperCase();
  if (!query) return;
  looking.value = true;
  const { data } = await supabase
    .from("gift_cards")
    .select(
      "id, code, initial_balance_cents, balance_cents, active, recipient_name, created_at, purchaser:clients(id, first_name, last_name)",
    )
    .eq("code", query)
    .maybeSingle();
  looking.value = false;
  searched.value = true;
  card.value = (data as unknown as CardResult) ?? null;
}

function soldDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
</script>

<template>
  <UiDialog v-model:open="open">
    <UiDialogContent class="sm:max-w-sm">
      <UiDialogHeader>
        <UiDialogTitle>Gift card lookup</UiDialogTitle>
        <UiDialogDescription>
          Enter the code from the card or receipt.
        </UiDialogDescription>
      </UiDialogHeader>

      <div class="flex gap-2">
        <UiInput
          v-model="code"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          class="uppercase"
          @keydown.enter.prevent="lookup"
        />
        <UiButton :disabled="looking || !code.trim()" @click="lookup">
          {{ looking ? "…" : "Look up" }}
        </UiButton>
      </div>

      <!-- Found -->
      <div v-if="card" class="rounded-xl border p-4">
        <div class="flex items-baseline justify-between">
          <p class="text-muted-foreground text-xs">Remaining balance</p>
          <UiBadge
            variant="outline"
            class="rounded-full"
            :class="
              card.active
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
                : 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-400'
            "
          >
            {{ card.active ? "active" : "inactive" }}
          </UiBadge>
        </div>
        <p class="mt-1 text-3xl font-semibold tabular-nums">
          {{ dollars(card.balance_cents) }}
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          of {{ dollars(card.initial_balance_cents) }} original
        </p>
        <div
          class="text-muted-foreground mt-3 space-y-0.5 border-t pt-3 text-xs"
        >
          <p>
            Sold {{ soldDate(card.created_at) }}
            <template v-if="card.purchaser">
              to
              <NuxtLink
                :to="`/clients/${card.purchaser.id}`"
                class="underline underline-offset-2"
                @click="open = false"
              >
                {{ card.purchaser.first_name }} {{ card.purchaser.last_name }}
              </NuxtLink>
            </template>
          </p>
          <p v-if="card.recipient_name">For {{ card.recipient_name }}</p>
        </div>
      </div>

      <!-- Not found -->
      <p v-else-if="searched && !looking" class="text-muted-foreground text-sm">
        No gift card matches that code. Check for typos — codes never contain 0,
        1, I, or O.
      </p>
    </UiDialogContent>
  </UiDialog>
</template>
