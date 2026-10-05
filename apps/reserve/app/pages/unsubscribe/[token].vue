<script setup lang="ts">
/**
 * /unsubscribe/<token> — the one-click unsubscribe page behind every
 * marketing campaign email (marketing campaigns, phase 1). Public, no
 * account, excluded from the auth redirect in nuxt.config like
 * /cancel/**. The token in the URL is the only thing sent to the server.
 *
 * Loading the page IS the action: the route claims the token and flips
 * communication_opted_in on that token's client. Two states. The
 * success copy says what was and was not unsubscribed — appointment
 * confirmations and reminders keep coming, and a person must not leave
 * this page thinking otherwise. Public-page styling diverges from the
 * staff tools on purpose; see the join page for the reasoning.
 */
definePageMeta({ layout: false });
useSeoMeta({ title: "Unsubscribe — The Reserve" });

const route = useRoute();
const token = route.params.token as string;

const { error } = await useFetch(`/api/public/unsubscribe/${token}`);
</script>

<template>
  <div class="min-h-screen bg-reserve-ink px-4 py-10">
    <div class="mx-auto w-full max-w-xl">
      <p class="text-center text-xs uppercase tracking-[0.35em] text-reserve-teal">
        The Reserve
      </p>

      <div
        v-if="error"
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:link-2-off"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">
          This link cannot be used
        </h1>
        <p class="mt-3 text-base text-gray-700">
          This unsubscribe link has already been used or is invalid.
        </p>
        <p class="mt-3 text-base text-gray-700">
          If you still receive promotional emails from us, reply to one and
          we will take care of it.
        </p>
      </div>

      <div
        v-else
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:circle-check"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">You are unsubscribed</h1>
        <p class="mt-3 text-base text-gray-700">
          You've been unsubscribed from promotional emails from The Reserve.
        </p>
        <p class="mt-3 text-base text-gray-700">
          You will still receive appointment confirmations and reminders
          about your bookings.
        </p>
      </div>
    </div>
  </div>
</template>
