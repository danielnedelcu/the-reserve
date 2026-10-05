<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

definePageMeta({ middleware: "guest" });
useSeoMeta({ title: "Forgot password — The Reserve" });

const supabase = useSupabaseClient();
const toast = useToast();

const ForgotSchema = z.object({
  email: z.email("Enter a valid email"),
});

const { handleSubmit, isSubmitting } = useForm({
  validationSchema: toTypedSchema(ForgotSchema),
});

const sent = ref(false);

const requestReset = handleSubmit(async (values) => {
  const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  // Deliberately identical outcome whether or not the account exists:
  // never reveal which emails have accounts.
  if (error) {
    // Rate limiting is the one error worth surfacing distinctly
    if (error.status === 429) {
      return toast.error(
        "Too many requests",
        "Please wait a minute and try again.",
      );
    }
    console.error("[forgot-password]", error.message);
  }
  sent.value = true;
});
</script>

<template>
  <div class="bg-background flex min-h-svh items-center justify-center p-6">
    <div class="w-full max-w-sm">
      <!-- Brand mark -->
      <div class="mb-8 text-center">
        <div
          class="mx-auto flex size-12 items-center justify-center rounded-xl bg-[#3b2f1e] text-[#e9d9b0]"
        >
          <BrandLaurel class="h-6 w-9" />
        </div>
        <p class="mt-3 font-serif text-sm tracking-[0.2em]">THE RESERVE</p>
      </div>

      <div class="rounded-2xl border bg-card p-6">
        <template v-if="!sent">
          <h1 class="text-lg font-semibold">Forgot your password?</h1>
          <p class="text-muted-foreground mt-1 text-sm">
            Enter the email you sign in with and we'll send a reset link.
          </p>

          <form class="mt-5" @submit="requestReset">
            <fieldset :disabled="isSubmitting" class="grid gap-4">
              <UiVeeInput
                label="Email"
                name="email"
                type="email"
                placeholder="you@example.com"
              />
              <UiButton
                type="submit"
                :text="isSubmitting ? 'Sending…' : 'Send reset link'"
              />
            </fieldset>
          </form>
        </template>

        <template v-else>
          <div class="flex items-start gap-3">
            <Icon
              name="lucide:mail-check"
              class="text-primary mt-0.5 size-5 shrink-0"
            />
            <div>
              <h1 class="text-lg font-semibold">Check your email</h1>
              <p class="text-muted-foreground mt-1 text-sm">
                If an account exists for that address, a password reset link is
                on its way. The link expires after a short time — if it doesn't
                arrive, check spam or try again.
              </p>
            </div>
          </div>
        </template>
      </div>

      <p class="text-muted-foreground mt-4 text-center text-sm">
        Remembered it?
        <NuxtLink
          to="/login"
          class="text-foreground underline-offset-4 hover:underline"
        >
          Back to sign in
        </NuxtLink>
      </p>
    </div>
  </div>
</template>
