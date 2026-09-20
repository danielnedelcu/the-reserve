<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "pos.checkout" });
useSeoMeta({ title: "Checkout — The Reserve" });

const supabase = useSupabaseClient();
const route = useRoute();
const toast = useToast();

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

// ---------------------------------------------------------------------------
// Cart state
// ---------------------------------------------------------------------------
interface CartLine {
  key: string;
  kind: "service" | "product" | "gift_card" | "discount" | "tip";
  label: string;
  detail?: string;
  quantity: number;
  totalCents: number; // pre-tax; negative for discounts
  taxable: boolean;
  locked?: boolean; // service lines from the appointment can't be edited here
  // payload for the API
  productId?: string;
  amountCents?: number;
  reason?: string;
  staffId?: string;
  recipientName?: string;
  recipientEmail?: string;
}

const cart = ref<CartLine[]>([]);
const clientId = ref<string | null>(null);
const appointmentId = ref<string | null>(null);
const appointmentLabel = ref("");
const serviceStaffId = ref<string | null>(null); // tip attribution default

// ---------------------------------------------------------------------------
// Appointment entry point: /checkout?appointment=<id>
// ---------------------------------------------------------------------------
const { data: context } = await useAsyncData("checkout-context", async () => {
  const apptId = route.query.appointment as string | undefined;
  if (!apptId) return null;
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, status, staff_id, client_id, starts_at, clients(first_name, last_name), staff!appointments_staff_id_fkey(display_name), appointment_services(name_snapshot, price_cents)",
    )
    .eq("id", apptId)
    .maybeSingle();
  if (error) throw error;
  return data;
});

if (context.value) {
  const appt = context.value;
  appointmentId.value = appt.id;
  clientId.value = appt.client_id;
  serviceStaffId.value = appt.staff_id;
  appointmentLabel.value = `${appt.clients?.first_name ?? ""} ${appt.clients?.last_name ?? ""} · ${appt.staff?.display_name ?? ""} · ${new Date(appt.starts_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  cart.value.push({
    key: `service-${appt.id}`,
    kind: "service",
    label: (appt.appointment_services ?? [])
      .map((s: { name_snapshot: string }) => s.name_snapshot)
      .join(" + "),
    detail: `with ${appt.staff?.display_name ?? "provider"}`,
    quantity: 1,
    totalCents: (appt.appointment_services ?? []).reduce(
      (sum: number, s: { price_cents: number }) => sum + s.price_cents,
      0,
    ),
    taxable: false,
    locked: true,
  });
}

// Saved cards for the selected client (stripe_card tender)
interface SavedCard {
  stripe_payment_method_id: string;
  brand: string;
  last4: string;
}
const savedCards = ref<SavedCard[]>([]);
const chargeMethod = ref<"terminal" | string>("terminal"); // pm id when a saved card is picked

watch(
  clientId,
  async (id) => {
    chargeMethod.value = "terminal";
    savedCards.value = [];
    if (!id) return;
    const { data } = await supabase
      .from("client_payment_methods")
      .select("stripe_payment_method_id, brand, last4")
      .eq("client_id", id)
      .eq("active", true)
      .order("created_at", { ascending: false });
    savedCards.value = (data ?? []) as SavedCard[];
  },
  { immediate: true },
);
// ---------------------------------------------------------------------------
// Clients (standalone flow) + products + tax rate
// ---------------------------------------------------------------------------
const { data: clients } = await useAsyncData("checkout-clients", async () => {
  const { data } = await supabase
    .from("clients")
    .select("id, first_name, last_name")
    .eq("active", true)
    .order("last_name");
  return data ?? [];
});

const { data: products } = await useAsyncData("checkout-products", async () => {
  const { data } = await supabase
    .from("products")
    .select("id, name, price_cents, taxable, stock_quantity")
    .eq("active", true)
    .order("name");
  return data ?? [];
});

const { data: location } = await useAsyncData("checkout-location", async () => {
  const { data } = await supabase
    .from("locations")
    .select("tax_rate_bps")
    .limit(1)
    .maybeSingle();
  return data;
});
const taxRate = computed(() => location.value?.tax_rate_bps ?? 0);

const { data: bookableStaff } = await useAsyncData(
  "checkout-staff",
  async () => {
    const { data } = await supabase
      .from("staff")
      .select("id, display_name")
      .eq("active", true)
      .eq("bookable", true)
      .order("display_name");
    return data ?? [];
  },
);

// ---------------------------------------------------------------------------
// Add lines
// ---------------------------------------------------------------------------
const productSearch = ref("");
const productMatches = computed(() => {
  const q = productSearch.value.trim().toLowerCase();
  if (!q) return [];
  return (products.value ?? [])
    .filter((p) => p.name.toLowerCase().includes(q))
    .slice(0, 6);
});

function addProduct(product: {
  id: string;
  name: string;
  price_cents: number;
  taxable: boolean;
}) {
  const existing = cart.value.find(
    (line) => line.kind === "product" && line.productId === product.id,
  );
  if (existing) {
    existing.quantity += 1;
    existing.totalCents = existing.quantity * product.price_cents;
  } else {
    cart.value.push({
      key: `product-${product.id}`,
      kind: "product",
      label: product.name,
      quantity: 1,
      totalCents: product.price_cents,
      taxable: product.taxable,
      productId: product.id,
    });
  }
  productSearch.value = "";
}

const giftAmount = ref<number | null>(null);
const giftRecipient = ref("");
function addGiftCard() {
  const amount = Math.round((giftAmount.value ?? 0) * 100);
  if (amount < 500) return toast.error("Gift card minimum is $5");
  cart.value.push({
    key: `gift-${Date.now()}`,
    kind: "gift_card",
    label: `Gift card${giftRecipient.value ? ` for ${giftRecipient.value}` : ""}`,
    quantity: 1,
    totalCents: amount,
    taxable: false,
    amountCents: amount,
    recipientName: giftRecipient.value || undefined,
  });
  giftAmount.value = null;
  giftRecipient.value = "";
}

const discountAmount = ref<number | null>(null);
const discountReason = ref("");
function addDiscount() {
  const amount = Math.round((discountAmount.value ?? 0) * 100);
  if (amount < 1 || !discountReason.value.trim()) {
    return toast.error("Discount needs an amount and a reason");
  }
  cart.value.push({
    key: `discount-${Date.now()}`,
    kind: "discount",
    label: `Discount — ${discountReason.value.trim()}`,
    quantity: 1,
    totalCents: -amount,
    taxable: false,
    amountCents: amount,
    reason: discountReason.value.trim(),
  });
  discountAmount.value = null;
  discountReason.value = "";
}

// Tip: dollar entry + quick % of the service subtotal
const tipDollars = ref<number | null>(null);
const serviceSubtotal = computed(() =>
  cart.value
    .filter((line) => line.kind === "service")
    .reduce((sum, line) => sum + line.totalCents, 0),
);
function quickTip(pct: number) {
  tipDollars.value = Math.round(serviceSubtotal.value * pct) / 10000; // pct of cents → dollars
  tipDollars.value = Number(
    ((serviceSubtotal.value * (pct / 100)) / 100).toFixed(2),
  );
}
const tipStaffId = ref<string | null>(null);
watch(serviceStaffId, (value) => (tipStaffId.value = value), {
  immediate: true,
});

function removeLine(key: string) {
  cart.value = cart.value.filter((line) => line.key !== key);
}

// ---------------------------------------------------------------------------
// Totals (display only — the server recomputes everything)
// ---------------------------------------------------------------------------
const subtotalCents = computed(() =>
  cart.value
    .filter((line) => ["service", "product", "gift_card"].includes(line.kind))
    .reduce((sum, line) => sum + line.totalCents, 0),
);
const discountCents = computed(
  () =>
    -cart.value
      .filter((l) => l.kind === "discount")
      .reduce((sum, l) => sum + l.totalCents, 0),
);
const taxCents = computed(() =>
  cart.value
    .filter((line) => line.taxable)
    .reduce(
      (sum, line) =>
        sum + Math.round((line.totalCents * taxRate.value) / 10000),
      0,
    ),
);
const tipCents = computed(() => Math.round((tipDollars.value ?? 0) * 100));
const totalCents = computed(
  () =>
    subtotalCents.value - discountCents.value + taxCents.value + tipCents.value,
);

// ---------------------------------------------------------------------------
// Tender
// ---------------------------------------------------------------------------
const giftCode = ref("");
const appliedGift = ref<{
  code: string;
  amountCents: number;
  balance: number;
} | null>(null);
const lookingUpGift = ref(false);

async function applyGiftCard() {
  const code = giftCode.value.trim().toUpperCase();
  if (!code) return;
  lookingUpGift.value = true;
  const { data: card } = await supabase
    .from("gift_cards")
    .select("code, balance_cents, active")
    .eq("code", code)
    .maybeSingle();
  lookingUpGift.value = false;
  if (!card || !card.active) return toast.error("Gift card not found");
  if (card.balance_cents < 1) return toast.error("Gift card has no balance");
  const applied = Math.min(card.balance_cents, totalCents.value);
  appliedGift.value = {
    code: card.code,
    amountCents: applied,
    balance: card.balance_cents,
  };
  toast.success(
    "Gift card applied",
    `${dollars(applied)} (balance ${dollars(card.balance_cents)})`,
  );
}

const cardReference = ref("");
const remainderCents = computed(
  () => totalCents.value - (appliedGift.value?.amountCents ?? 0),
);

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------
const submitting = ref(false);

async function completeCheckout() {
  if (!cart.value.length) return toast.error("Cart is empty");
  if (tipCents.value > 0 && !tipStaffId.value) {
    return toast.error("Pick who the tip goes to");
  }
  submitting.value = true;

  const items: Record<string, unknown>[] = [];
  if (
    appointmentId.value &&
    cart.value.some((line) => line.kind === "service")
  ) {
    items.push({ kind: "service", appointmentId: appointmentId.value });
  }
  for (const line of cart.value) {
    if (line.kind === "product") {
      items.push({
        kind: "product",
        productId: line.productId,
        quantity: line.quantity,
      });
    } else if (line.kind === "gift_card") {
      items.push({
        kind: "gift_card",
        amountCents: line.amountCents,
        recipientName: line.recipientName,
      });
    } else if (line.kind === "discount") {
      items.push({
        kind: "discount",
        amountCents: line.amountCents,
        reason: line.reason,
      });
    }
  }
  if (tipCents.value > 0) {
    items.push({
      kind: "tip",
      amountCents: tipCents.value,
      staffId: tipStaffId.value,
    });
  }

  const payments: Record<string, unknown>[] = [];
  if (appliedGift.value) {
    payments.push({
      method: "gift_card",
      code: appliedGift.value.code,
      amountCents: appliedGift.value.amountCents,
    });
  }
  if (remainderCents.value > 0) {
    if (chargeMethod.value !== "terminal") {
      payments.push({
        method: "stripe_card",
        paymentMethodId: chargeMethod.value,
        amountCents: remainderCents.value,
      });
    } else {
      payments.push({
        method: "card_external",
        amountCents: remainderCents.value,
        reference: cardReference.value || undefined,
      });
    }
  }

  try {
    const result = await $fetch<{ id: string; totalCents: number }>(
      "/api/checkout",
      {
        method: "POST",
        body: {
          clientId: clientId.value,
          appointmentId: appointmentId.value,
          items,
          payments,
        },
      },
    );
    toast.success("Checkout complete", dollars(result.totalCents));
    navigateTo("/transactions");
  } catch (error: unknown) {
    const err = error as {
      statusMessage?: string;
      data?: { statusMessage?: string };
    };
    toast.error(
      "Checkout failed",
      err.data?.statusMessage ?? err.statusMessage ?? "Unknown error",
    );
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <h1 class="text-2xl font-semibold">Checkout</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      {{ appointmentLabel || "Walk-in sale — add items below." }}
    </p>

    <div class="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
      <!-- LEFT: cart building -->
      <div class="space-y-5">
        <!-- Client (standalone only) -->
        <section v-if="!appointmentId" class="rounded-xl border bg-card p-4">
          <label class="text-sm font-medium" for="co-client"
            >Client (optional)</label
          >
          <UiSelect v-model="clientId">
            <UiSelectTrigger
              id="co-client"
              class="mt-1.5"
              placeholder="Walk-in / no client"
            />
            <UiSelectContent>
              <UiSelectItem :value="null as never" text="Walk-in / no client" />
              <UiSelectItem
                v-for="client in clients"
                :key="client.id"
                :value="client.id"
                :text="`${client.last_name}, ${client.first_name}`"
              />
            </UiSelectContent>
          </UiSelect>
          <p class="text-muted-foreground mt-1.5 text-xs">
            Attaching a client emails them a receipt and links the sale to their
            history.
          </p>
        </section>

        <!-- Cart lines -->
        <section class="rounded-xl border bg-card p-4">
          <h2 class="text-sm font-medium">Items</h2>
          <ul class="mt-2 divide-y">
            <li
              v-for="line in cart"
              :key="line.key"
              class="flex items-center justify-between gap-3 py-2.5"
            >
              <div class="min-w-0">
                <p
                  class="truncate text-sm"
                  :class="line.kind === 'discount' && 'text-destructive'"
                >
                  {{ line.label }}
                  <span v-if="line.quantity > 1" class="text-muted-foreground"
                    >× {{ line.quantity }}</span
                  >
                </p>
                <p v-if="line.detail" class="text-muted-foreground text-xs">
                  {{ line.detail }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span class="text-sm tabular-nums">{{
                  dollars(line.totalCents)
                }}</span>
                <button
                  v-if="!line.locked"
                  class="text-muted-foreground hover:text-destructive"
                  aria-label="Remove"
                  @click="removeLine(line.key)"
                >
                  <Icon name="lucide:x" class="size-4" />
                </button>
              </div>
            </li>
            <li
              v-if="!cart.length"
              class="text-muted-foreground py-4 text-center text-sm"
            >
              Nothing yet — add products or a gift card below.
            </li>
          </ul>
        </section>

        <!-- Add product -->
        <section class="rounded-xl border bg-card p-4">
          <label class="text-sm font-medium" for="co-product"
            >Add retail product</label
          >
          <UiInput
            id="co-product"
            v-model="productSearch"
            placeholder="Search products…"
            class="mt-1.5"
          />
          <ul
            v-if="productMatches.length"
            class="mt-2 overflow-hidden rounded-md border"
          >
            <li v-for="product in productMatches" :key="product.id">
              <button
                class="hover:bg-secondary/60 flex w-full items-center justify-between px-3 py-2 text-left text-sm"
                @click="addProduct(product)"
              >
                <span>
                  {{ product.name }}
                  <span
                    v-if="product.stock_quantity === 0"
                    class="text-destructive text-xs"
                  >
                    (out of stock)
                  </span>
                </span>
                <span class="tabular-nums">{{
                  dollars(product.price_cents)
                }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- Gift card + discount, side by side -->
        <div class="grid gap-5 sm:grid-cols-2">
          <section class="rounded-xl border bg-card p-4">
            <h2 class="text-sm font-medium">Sell a gift card</h2>
            <div class="mt-2 grid gap-2">
              <UiInput
                v-model.number="giftAmount"
                type="number"
                min="5"
                step="5"
                placeholder="Amount ($)"
              />
              <UiInput
                v-model="giftRecipient"
                placeholder="Recipient name (optional)"
              />
              <UiButton size="sm" variant="outline" @click="addGiftCard"
                >Add to sale</UiButton
              >
            </div>
          </section>

          <section class="rounded-xl border bg-card p-4">
            <h2 class="text-sm font-medium">Discount</h2>
            <div class="mt-2 grid gap-2">
              <UiInput
                v-model.number="discountAmount"
                type="number"
                min="1"
                step="1"
                placeholder="Amount ($)"
              />
              <UiInput
                v-model="discountReason"
                placeholder="Reason (required)"
              />
              <UiButton size="sm" variant="outline" @click="addDiscount"
                >Apply discount</UiButton
              >
            </div>
          </section>
        </div>

        <!-- Tip -->
        <section class="rounded-xl border bg-card p-4">
          <h2 class="text-sm font-medium">Gratuity</h2>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <UiInput
              v-model.number="tipDollars"
              type="number"
              min="0"
              step="1"
              placeholder="0.00"
              class="max-w-28"
            />
            <UiButton
              v-for="pct in [18, 20, 25]"
              :key="pct"
              size="sm"
              variant="outline"
              :disabled="!serviceSubtotal"
              @click="quickTip(pct)"
            >
              {{ pct }}%
            </UiButton>
          </div>
          <div v-if="tipCents > 0" class="mt-3">
            <label class="text-sm font-medium" for="co-tip-staff"
              >Tip goes to</label
            >
            <UiSelect v-model="tipStaffId">
              <UiSelectTrigger
                id="co-tip-staff"
                class="mt-1.5 sm:max-w-60"
                placeholder="Select provider"
              />
              <UiSelectContent>
                <UiSelectItem
                  v-for="member in bookableStaff"
                  :key="member.id"
                  :value="member.id"
                  :text="member.display_name"
                />
              </UiSelectContent>
            </UiSelect>
          </div>
          <p v-if="serviceSubtotal" class="text-muted-foreground mt-2 text-xs">
            Percentages are calculated on the pre-tax service amount ({{
              dollars(serviceSubtotal)
            }}).
          </p>
        </section>
      </div>

      <!-- RIGHT: totals + tender -->
      <div class="space-y-5">
        <section class="rounded-xl border bg-card p-4">
          <h2 class="text-sm font-medium">Total</h2>
          <dl class="mt-2 space-y-1.5 text-sm">
            <div class="flex justify-between">
              <dt class="text-muted-foreground">Subtotal</dt>
              <dd class="tabular-nums">{{ dollars(subtotalCents) }}</dd>
            </div>
            <div
              v-if="discountCents"
              class="flex justify-between text-destructive"
            >
              <dt>Discount</dt>
              <dd class="tabular-nums">−{{ dollars(discountCents) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">Tax</dt>
              <dd class="tabular-nums">{{ dollars(taxCents) }}</dd>
            </div>
            <div v-if="tipCents" class="flex justify-between">
              <dt class="text-muted-foreground">Gratuity</dt>
              <dd class="tabular-nums">{{ dollars(tipCents) }}</dd>
            </div>
            <div class="border-t pt-1.5 font-medium flex justify-between">
              <dt>Total</dt>
              <dd class="tabular-nums">{{ dollars(totalCents) }}</dd>
            </div>
          </dl>
        </section>

        <section class="rounded-xl border bg-card p-4">
          <h2 class="text-sm font-medium">Payment</h2>

          <!-- Gift card redemption -->
          <div class="mt-2">
            <label class="text-muted-foreground text-xs" for="co-gift-code"
              >Gift card code</label
            >
            <div class="mt-1 flex gap-2">
              <UiInput
                id="co-gift-code"
                v-model="giftCode"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                class="uppercase"
              />
              <UiButton
                size="sm"
                variant="outline"
                :disabled="lookingUpGift"
                @click="applyGiftCard"
              >
                Apply
              </UiButton>
            </div>
            <p v-if="appliedGift" class="text-primary mt-1.5 text-xs">
              {{ appliedGift.code }}:
              {{ dollars(appliedGift.amountCents) }} applied
              <button
                class="text-muted-foreground ml-1 underline"
                @click="appliedGift = null"
              >
                remove
              </button>
            </p>
          </div>

          <!-- Card remainder -->
          <!-- Charge method + card remainder -->
          <div
            v-if="savedCards.length && remainderCents > 0"
            class="mt-4 space-y-1.5"
          >
            <p class="text-muted-foreground text-xs">Charge method</p>
            <label
              v-for="card in savedCards"
              :key="card.stripe_payment_method_id"
              class="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                v-model="chargeMethod"
                type="radio"
                :value="card.stripe_payment_method_id"
                class="accent-primary size-4"
              />
              Card on file — {{ card.brand }} •••• {{ card.last4 }}
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                v-model="chargeMethod"
                type="radio"
                value="terminal"
                class="accent-primary size-4"
              />
              Card terminal (external)
            </label>
          </div>

          <div v-if="chargeMethod === 'terminal'" class="mt-4">
            <p class="text-sm">
              Card (terminal):
              <span class="font-medium tabular-nums">{{
                dollars(Math.max(remainderCents, 0))
              }}</span>
            </p>
            <UiInput
              v-model="cardReference"
              placeholder="Terminal receipt # (optional)"
              class="mt-1.5"
            />
            <p class="text-muted-foreground mt-1.5 text-xs">
              Charge this amount on the card terminal, then complete the sale
              here.
            </p>
          </div>
          <p v-else class="mt-4 text-sm">
            Charge on file:
            <span class="font-medium tabular-nums">{{
              dollars(Math.max(remainderCents, 0))
            }}</span>
            <span class="text-muted-foreground block text-xs">
              Charged through Stripe when you complete.
            </span>
          </p>

          <UiButton
            class="mt-4 w-full"
            :disabled="submitting || !cart.length || totalCents < 0"
            :text="
              submitting ? 'Completing…' : `Complete — ${dollars(totalCents)}`
            "
            @click="completeCheckout"
          />
        </section>
      </div>
    </div>
  </div>
</template>
