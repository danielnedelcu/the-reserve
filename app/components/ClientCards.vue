<script setup lang="ts">
/**
 * ClientCards — saved cards on the client profile + the "Add card" flow.
 * Drop into app/pages/clients/[id].vue:
 *   <ClientCards v-if="can('cards.view')" :client-id="clientId" class="mt-8" />
 *
 * Flow: consent checkbox (policy text shown) → SetupIntent → Stripe Payment
 * Element collects the card (PAN never touches our code) → confirmSetup →
 * save route writes consent + mirror row.
 */
import {
  loadStripe,
  type Stripe,
  type StripeElements,
} from "@stripe/stripe-js";

const props = defineProps<{ clientId: string }>();

const supabase = useSupabaseClient();
const toast = useToast();
const { can } = usePermissions();
const config = useRuntimeConfig();
const setupClientSecret = ref<string | null>(null);

// TODO(business-settings): this text belongs on the /business page alongside
// the cancellation policy; hardcoded v1. The SNAPSHOT stored per consent
// makes moving it later safe — old consents keep their exact language.
const POLICY_TEXT =
  "I authorize The Reserve Wellness Club to securely store this card and to charge it for services rendered, agreed-upon fees, and applicable cancellation or no-show fees per the posted cancellation policy.";

// ---------------------------------------------------------------------------
// Saved cards
// ---------------------------------------------------------------------------
const { data: cards, refresh: refreshCards } = await useAsyncData(
  `client-cards-${props.clientId}`,
  async () => {
    const { data } = await supabase
      .from("client_payment_methods")
      .select("id, brand, last4, exp_month, exp_year, created_at")
      .eq("client_id", props.clientId)
      .eq("active", true)
      .order("created_at", { ascending: false });
    return data ?? [];
  },
);

const brandLabel = (brand: string) =>
  ({
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "Amex",
    discover: "Discover",
  })[brand] ?? brand;

// ---------------------------------------------------------------------------
// Add-card dialog: consent gate → Elements mount → confirm → save
// ---------------------------------------------------------------------------
const addOpen = ref(false);
const consented = ref(false);
const mounting = ref(false);
const saving = ref(false);
const elementsHost = ref<HTMLElement | null>(null);

let stripe: Stripe | null = null;
let elements: StripeElements | null = null;

watch(addOpen, (open) => {
  if (!open) {
    consented.value = false;
    elements = null; // element unmounts with the dialog DOM
  }
});

// Consent checked → create the SetupIntent and mount the Payment Element.
watch(consented, async (yes) => {
  if (!yes || elements) return;
  mounting.value = true;
  try {
    stripe ??= await loadStripe(config.public.stripePublishableKey as string);
    if (!stripe) throw new Error("Stripe failed to load");

    const { clientSecret } = await $fetch<{ clientSecret: string }>(
      `/api/clients/${props.clientId}/setup-intent`,
      { method: "POST" },
    );
    setupClientSecret.value = clientSecret;

    elements = stripe.elements();
    const cardElement = elements.create("card"); // plain card input — no Link, no wallets
    await nextTick();
    if (elementsHost.value) cardElement.mount(elementsHost.value);
  } catch (error: unknown) {
    const err = error as {
      data?: { statusMessage?: string };
      message?: string;
    };
    toast.error(
      "Could not start card setup",
      err.data?.statusMessage ?? err.message ?? "",
    );
    consented.value = false;
  } finally {
    mounting.value = false;
  }
});
async function saveCard() {
  if (!stripe || !elements || !setupClientSecret.value) return;
  saving.value = true;
  try {
    const card = elements.getElement("card");
    if (!card) return;
    const result = await stripe.confirmCardSetup(setupClientSecret.value, {
      payment_method: { card },
    });
    if (result.error) {
      return toast.error(
        "Card not saved",
        result.error.message ?? "Card was declined",
      );
    }
    await $fetch(`/api/clients/${props.clientId}/payment-methods`, {
      method: "POST",
      body: { setupIntentId: result.setupIntent.id, policyText: POLICY_TEXT },
    });
    toast.success("Card saved");
    addOpen.value = false;
    await refreshCards();
  } catch (error: unknown) {
    const err = error as { data?: { statusMessage?: string } };
    toast.error(
      "Could not save card",
      err.data?.statusMessage ?? "Unknown error",
    );
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section>
    <div class="flex items-center justify-between">
      <div>
        <h2 class="font-medium">Cards on file</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          Saved with consent for checkout and cancellation fees.
        </p>
      </div>
      <UiButton
        v-if="can('cards.manage')"
        size="sm"
        variant="outline"
        @click="addOpen = true"
      >
        <Icon name="lucide:credit-card" class="size-4" />
        Add card
      </UiButton>
    </div>

    <ul v-if="cards?.length" class="mt-3 space-y-2">
      <li
        v-for="card in cards"
        :key="card.id"
        class="bg-card flex items-center justify-between rounded-xl border px-4 py-3"
      >
        <div class="flex items-center gap-3">
          <Icon
            name="lucide:credit-card"
            class="text-muted-foreground size-4"
          />
          <span class="text-sm font-medium"
            >{{ brandLabel(card.brand) }} •••• {{ card.last4 }}</span
          >
        </div>
        <span class="text-muted-foreground text-xs tabular-nums">
          exp {{ String(card.exp_month).padStart(2, "0") }}/{{
            String(card.exp_year).slice(-2)
          }}
        </span>
      </li>
    </ul>
    <p v-else class="text-muted-foreground mt-3 text-sm">No cards on file.</p>

    <!-- Add card dialog -->
    <UiDialog v-model:open="addOpen">
      <UiDialogContent class="sm:max-w-md">
        <UiDialogHeader>
          <UiDialogTitle>Add a card on file</UiDialogTitle>
          <UiDialogDescription>
            The card is stored securely by Stripe — it never touches our
            systems.
          </UiDialogDescription>
        </UiDialogHeader>

        <!-- Consent gate: the card form does not exist until this is checked -->
        <label class="bg-secondary/50 flex cursor-pointer gap-3 rounded-lg p-3">
          <input
            v-model="consented"
            type="checkbox"
            class="accent-primary mt-0.5 size-4 shrink-0"
          />
          <span class="text-xs leading-relaxed">{{ POLICY_TEXT }}</span>
        </label>

        <div v-if="consented">
          <p
            v-if="mounting"
            class="text-muted-foreground py-4 text-center text-sm"
          >
            Loading secure card form…
          </p>
          <div ref="elementsHost" />
        </div>

        <UiDialogFooter>
          <UiButton variant="outline" @click="addOpen = false">Cancel</UiButton>
          <UiButton
            :disabled="!consented || mounting || saving"
            :text="saving ? 'Saving…' : 'Save card'"
            @click="saveCard"
          />
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialog>
  </section>
</template>
