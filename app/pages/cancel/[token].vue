<script setup lang="ts">
/**
 * /cancel/<token> — the public cancel-via-link page. PHASE 2 STUB.
 *
 * The confirmation email (and, in phase 3, the reminders) carries this
 * link, so the route has to exist and be honest before the real page is
 * built in phase 4: a client who clicks it today lands on a clear
 * message, not a 404. Public on purpose — reached from an email by
 * someone with no account, so it is excluded from the auth redirect in
 * nuxt.config (like /join/**), and it deliberately does NOT read the
 * token yet: nothing here confirms to a stranger whether a token exists.
 * Styled like the public intake page (its own shell, brand colours).
 */
definePageMeta({ layout: false });
useSeoMeta({ title: "Cancel an appointment — The Reserve" });
</script>

<template>
  <div class="min-h-screen bg-reserve-ink px-4 py-10">
    <div class="mx-auto w-full max-w-xl">
      <p
        class="text-center text-xs uppercase tracking-[0.35em] text-reserve-teal"
      >
        The Reserve
      </p>
      <div
        class="mt-8 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <Icon
          name="lucide:calendar-x"
          class="mx-auto mb-3 size-8 text-reserve-primary"
          aria-hidden="true"
        />
        <h1 class="text-xl font-semibold text-reserve-ink">
          Cancelling online is coming soon
        </h1>
        <p class="mt-3 text-base text-gray-700">
          This page will let you cancel your appointment in a future update.
        </p>
        <p class="mt-3 text-base text-gray-700">
          For now, please call us or reply to your confirmation email and we
          will take care of it for you.
        </p>
      </div>
    </div>
  </div>
</template>
