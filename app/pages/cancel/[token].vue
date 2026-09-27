<script setup lang="ts">
/**
 * /cancel/<token> — the public cancel-via-link page (client
 * communications, phase 4). Reached from the confirmation and reminder
 * emails by someone with no account; excluded from the auth redirect in
 * nuxt.config like /join/**.
 *
 * The token in the URL is the only thing this page sends the server.
 * It never reads or forwards a client or appointment id from the query
 * string: a stranger with a guessed id learns nothing here, and a person
 * with a real token already had the email.
 *
 * Written for the people who land here — often older, sometimes
 * low-vision, on a phone — and for the moment they are in: about to
 * cancel, possibly about to be charged. So the fee is stated in words
 * BEFORE the button, in a box that does not rely on colour to carry its
 * meaning, and the confirm button says what it will do. Public-page
 * styling diverges from the staff tools on purpose (own shell, brand
 * colours, larger type); see the join page for the same reasoning.
 */
definePageMeta({ layout: false });
useSeoMeta({ title: "Cancel an appointment — The Reserve" });

const route = useRoute();
const token = route.params.token as string;

type Outcome = "outside_window" | "waived" | "charge" | "uncollected";

interface CancelLinkView {
  state: "ready" | "already_cancelled";
  serviceName: string;
  staffName: string;
  locationName: string;
  startsAt: string;
  timezone: string;
  late?: boolean;
  outcome?: Outcome;
  feeCents?: number;
  policyFeeCents?: number;
  cardLast4?: string | null;
}

const { data: link, error: loadError } = await useFetch<CancelLinkView>(
  `/api/public/cancel/${token}`,
);

const loadErrorMessage = computed(
  () =>
    (loadError.value?.data as { statusMessage?: string } | undefined)
      ?.statusMessage ?? "This link is no longer valid.",
);

const when = computed(() => {
  if (!link.value) return "";
  return new Date(link.value.startsAt).toLocaleString("en-US", {
    timeZone: link.value.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
});

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What confirming will do to the person's money, said before they do it. */
const feeNotice = computed(() => {
  const l = link.value;
  if (!l || l.state !== "ready" || !l.outcome) return null;
  const fee = dollars(l.feeCents ?? 0);
  const policyFee = dollars(l.policyFeeCents ?? 0);
  switch (l.outcome) {
    case "outside_window":
      return {
        title: "No fee",
        body: "You are cancelling with more than 24 hours' notice, so there is no charge.",
      };
    case "waived":
      return {
        title: "Late cancellation, waived as a courtesy",
        body: `This appointment is less than 24 hours away. As a courtesy, your first late cancellation is waived, so there is no charge this time. After this, late cancellations cost ${policyFee}.`,
      };
    case "charge":
      return {
        title: `Late cancellation fee: ${fee}`,
        body: `This appointment is less than 24 hours away and your courtesy waiver has already been used. If you confirm, ${fee} will be charged to your card on file${
          l.cardLast4 ? ` ending in ${l.cardLast4}` : ""
        }.`,
      };
    case "uncollected":
      return {
        title: `Late cancellation fee: ${fee}`,
        body: `This appointment is less than 24 hours away and your courtesy waiver has already been used, so a ${fee} fee applies. We do not have a card on file for you, so we will settle it at your next visit.`,
      };
    default:
      return null;
  }
});

const submitting = ref(false);
const submitError = ref("");
const result = ref<{
  outcome: Outcome;
  feeCents: number;
  policyFeeCents: number;
  cardLast4: string | null;
} | null>(null);

const resultCopy = computed(() => {
  const r = result.value;
  if (!r) return "";
  const fee = dollars(r.feeCents);
  switch (r.outcome) {
    case "outside_window":
      return "There is no charge. Thank you for letting us know early.";
    case "waived":
      return `Your first late cancellation has been waived as a courtesy, so there is no charge. Future late cancellations will cost ${dollars(r.policyFeeCents)}.`;
    case "charge":
      return `The ${fee} late cancellation fee has been charged to your card${
        r.cardLast4 ? ` ending in ${r.cardLast4}` : ""
      }.`;
    case "uncollected":
      return `A ${fee} late cancellation fee applies. We will settle it with you at your next visit.`;
    default:
      return "";
  }
});

async function confirmCancel() {
  submitError.value = "";
  submitting.value = true;
  try {
    result.value = await $fetch<{
      outcome: Outcome;
      feeCents: number;
      policyFeeCents: number;
      cardLast4: string | null;
    }>(`/api/public/cancel/${token}`, { method: "POST" });
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    submitError.value =
      err.data?.statusMessage ??
      "Something went wrong. The appointment has not been cancelled. Please call us.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-reserve-ink px-4 py-10">
    <div class="mx-auto w-full max-w-xl">
      <p
        class="text-center text-xs uppercase tracking-[0.35em] text-reserve-teal"
      >
        The Reserve
      </p>

      <!-- Expired, used, or never real. One message for all three: the
           person's next step is the same, and distinguishing them would
           confirm to a stranger which tokens exist. -->
      <div
        v-if="loadError || !link"
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:link-2-off"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">
          This link cannot be opened
        </h1>
        <p class="mt-3 text-base text-gray-700">{{ loadErrorMessage }}</p>
      </div>

      <!-- Done. -->
      <div
        v-else-if="result"
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:circle-check"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">
          Your appointment is cancelled
        </h1>
        <p class="mt-3 text-base text-gray-700">
          {{ link.serviceName }} on {{ when }} has been cancelled.
        </p>
        <p class="mt-3 text-base text-gray-700">{{ resultCopy }}</p>
        <p class="mt-3 text-base text-gray-700">
          We have sent you an email confirming this. Whenever you are ready
          to rebook, call us or ask at the front desk.
        </p>
      </div>

      <!-- Staff already cancelled it; nothing for the person to do. -->
      <div
        v-else-if="link.state === 'already_cancelled'"
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:calendar-x"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">
          This appointment is already cancelled
        </h1>
        <p class="mt-3 text-base text-gray-700">
          {{ link.serviceName }} on {{ when }} was already cancelled. There is
          nothing else for you to do.
        </p>
      </div>

      <!-- Ready: the details, the fee in words, then the button. -->
      <div
        v-else
        class="mt-8 rounded-2xl bg-white p-6 shadow-xl shadow-black/30 sm:p-8"
      >
        <h1 class="text-2xl font-semibold text-reserve-ink">
          Cancel this appointment?
        </h1>

        <div class="mt-6 rounded-xl bg-gray-100 p-5">
          <div class="text-lg font-semibold text-reserve-ink">
            {{ link.serviceName }}
          </div>
          <div class="mt-1 text-base text-gray-700">{{ when }}</div>
          <div class="mt-1 text-base text-gray-700">
            with {{ link.staffName }}
          </div>
          <div class="mt-1 text-base text-gray-700">{{ link.locationName }}</div>
        </div>

        <!-- The fee, before the button. Icon + heading carry the meaning;
             the border colour is decoration. -->
        <div
          v-if="feeNotice"
          class="mt-6 flex gap-3 rounded-xl border-2 p-5"
          :class="
            link.late ? 'border-reserve-primary' : 'border-gray-200'
          "
          role="status"
        >
          <Icon
            :name="link.late ? 'lucide:triangle-alert' : 'lucide:info'"
            class="mt-0.5 size-6 shrink-0 text-reserve-primary"
            aria-hidden="true"
          />
          <div>
            <div class="text-base font-semibold text-reserve-ink">
              {{ feeNotice.title }}
            </div>
            <div class="mt-1 text-base text-gray-700">{{ feeNotice.body }}</div>
          </div>
        </div>

        <UiButton
          type="button"
          :disabled="submitting"
          class="mt-8 h-12 w-full bg-reserve-primary text-base text-white hover:bg-reserve-primary/90"
          @click="confirmCancel"
        >
          {{
            submitting
              ? "Cancelling…"
              : link.outcome === "charge"
                ? `Yes, cancel and charge ${dollars(link.feeCents ?? 0)}`
                : "Yes, cancel this appointment"
          }}
        </UiButton>

        <!-- The server's own words when it refused: notably a declined
             card, where the appointment is still booked. -->
        <div
          v-if="submitError"
          class="mt-4 flex gap-2 rounded-xl bg-gray-100 p-4 text-base text-reserve-ink"
          role="alert"
        >
          <Icon
            name="lucide:circle-alert"
            class="mt-0.5 size-5 shrink-0 text-reserve-primary"
            aria-hidden="true"
          />
          <span>{{ submitError }}</span>
        </div>

        <p class="mt-6 text-center text-base text-gray-600">
          Changed your mind? Just close this page. Your appointment stays
          booked.
        </p>
      </div>
    </div>
  </div>
</template>
