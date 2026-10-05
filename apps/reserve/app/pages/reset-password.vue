<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

// No middleware: the recovery link must land here logged-out, and the
// exchanged recovery session must not bounce through guards. The route is
// excluded from the auth redirect in nuxt.config.
useSeoMeta({ title: "Reset password — The Reserve" });

const supabase = useSupabaseClient();
const user = useSupabaseUser();
const toast = useToast();

// ---------------------------------------------------------------------------
// Recovery-session detection.
// The email link redirects here with a ?code=; the Supabase module's
// detectSessionInUrl exchanges it (PKCE) shortly after mount. We wait a
// bounded moment for the session to materialize before declaring the link bad.
// ---------------------------------------------------------------------------
const checking = ref(true);
const linkValid = ref(false);

onMounted(() => {
  // Session may already be there, or arrive within a beat of the code exchange
  const started = Date.now();
  const timer = setInterval(() => {
    if (user.value) {
      linkValid.value = true;
      checking.value = false;
      clearInterval(timer);
    } else if (Date.now() - started > 5000) {
      checking.value = false; // no session after 5s: expired/invalid/reused link
      clearInterval(timer);
    }
  }, 250);
});

// ---------------------------------------------------------------------------
// New password form
// ---------------------------------------------------------------------------
const ResetSchema = z
  .object({
    password: z.string().min(8, "At least 8 characters"),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });

const { handleSubmit, isSubmitting } = useForm({
  validationSchema: toTypedSchema(ResetSchema),
});

const done = ref(false);

const saveNewPassword = handleSubmit(async (values) => {
  const { error } = await supabase.auth.updateUser({
    password: values.password,
  });
  if (error) {
    if (error.message.toLowerCase().includes("different from the old")) {
      return toast.error(
        "Same password",
        "Choose a password you haven't used before.",
      );
    }
    return toast.error("Could not reset password", error.message);
  }
  done.value = true;
  toast.success("Password updated");
  // The recovery session is now a normal session — head into the app
  setTimeout(() => navigateTo("/"), 1200);
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
        <!-- Waiting for the code exchange -->
        <template v-if="checking">
          <div class="text-muted-foreground flex items-center gap-3 text-sm">
            <Icon name="lucide:loader-2" class="size-4 animate-spin" />
            Verifying your reset link…
          </div>
        </template>

        <!-- Valid recovery session: the form -->
        <template v-else-if="linkValid && !done">
          <h1 class="text-lg font-semibold">Choose a new password</h1>
          <p class="text-muted-foreground mt-1 text-sm">
            You're resetting the password for {{ user?.email }}.
          </p>

          <form class="mt-5" @submit="saveNewPassword">
            <fieldset :disabled="isSubmitting" class="grid gap-4">
              <UiVeeInput
                label="New password"
                name="password"
                type="password"
                autocomplete="new-password"
              />
              <UiVeeInput
                label="Confirm password"
                name="confirm"
                type="password"
                autocomplete="new-password"
              />
              <UiButton
                type="submit"
                :text="isSubmitting ? 'Saving…' : 'Reset password'"
              />
            </fieldset>
          </form>
        </template>

        <!-- Success -->
        <template v-else-if="done">
          <div class="flex items-start gap-3">
            <Icon
              name="lucide:check-circle-2"
              class="text-primary mt-0.5 size-5 shrink-0"
            />
            <div>
              <h1 class="text-lg font-semibold">Password updated</h1>
              <p class="text-muted-foreground mt-1 text-sm">
                Taking you to your dashboard…
              </p>
            </div>
          </div>
        </template>

        <!-- No session: bad/expired link -->
        <template v-else>
          <div class="flex items-start gap-3">
            <Icon
              name="lucide:link-2-off"
              class="text-destructive mt-0.5 size-5 shrink-0"
            />
            <div>
              <h1 class="text-lg font-semibold">This link isn't valid</h1>
              <p class="text-muted-foreground mt-1 text-sm">
                Reset links expire quickly and can only be used once — and they
                must be opened in the same browser that requested them.
              </p>
              <UiButton class="mt-4" size="sm" to="/forgot-password">
                Request a new link
              </UiButton>
            </div>
          </div>
        </template>
      </div>

      <p class="text-muted-foreground mt-4 text-center text-sm">
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
