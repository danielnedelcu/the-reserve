<script setup lang="ts">
definePageMeta({ layout: "default" });

const route = useRoute();
const router = useRouter();
const supabase = useSupabaseClient();
const token = route.params.token as string;

interface InviteDetails {
  email: string;
  displayName: string | null;
  title: string | null;
  organizationName: string;
}

// Load invite details (404/410 handled by error state)
const { data: invite, error: loadError } = await useFetch<InviteDetails>(
  `/api/invites/${token}`,
);

const displayName = ref(invite.value?.displayName ?? "");
const title = ref(invite.value?.title ?? "");
const password = ref("");
const confirmPassword = ref("");
const errorMessage = ref("");
const submitting = ref(false);

const loadErrorMessage = computed(
  () =>
    (loadError.value?.data as { statusMessage?: string } | undefined)
      ?.statusMessage ?? "This invite link is not valid.",
);

async function accept() {
  errorMessage.value = "";
  if (password.value !== confirmPassword.value) {
    errorMessage.value = "Passwords do not match.";
    return;
  }
  submitting.value = true;
  try {
    await $fetch("/api/invites/accept", {
      method: "POST",
      body: {
        token,
        displayName: displayName.value,
        title: title.value,
        password: password.value,
      },
    });
    // Account created — sign straight in
    const { error } = await supabase.auth.signInWithPassword({
      email: invite.value!.email,
      password: password.value,
    });
    if (error) throw new Error(error.message);
    await usePermissions().load(true);
    router.push("/");
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }; message?: string };
    errorMessage.value =
      err.data?.statusMessage ?? err.message ?? "Something went wrong.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen grid place-items-center bg-reserve-ink px-4">
    <div class="w-full max-w-md">
      <div class="mb-10 text-center">
        <p class="text-xs tracking-[0.35em] uppercase text-reserve-teal">
          {{ invite?.organizationName || "The Reserve" }}
        </p>
        <h1 class="mt-2 text-2xl font-semibold text-white">
          {{ loadError ? "Invite unavailable" : "Create your account" }}
        </h1>
      </div>

      <!-- Invalid / expired / used -->
      <div
        v-if="loadError"
        class="rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/30"
      >
        <p class="text-sm text-gray-700">
          {{ loadErrorMessage }}
        </p>
        <p class="mt-3 text-sm text-gray-500">
          Ask an administrator to send a new invitation.
        </p>
      </div>

      <!-- Acceptance form -->
      <div v-else class="rounded-2xl bg-white p-8 shadow-xl shadow-black/30">
        <p class="mb-6 text-sm text-gray-600">
          You're joining as
          <span class="font-medium text-reserve-ink">{{ invite?.email }}</span>
        </p>

        <div class="space-y-5">
          <div>
            <label for="name" class="block text-sm font-medium text-reserve-ink"
              >Your name</label
            >
            <input
              id="name"
              v-model="displayName"
              type="text"
              required
              class="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-reserve-primary focus:outline-none focus:ring-2 focus:ring-reserve-soft/40"
            />
          </div>

          <div>
            <label
              for="title"
              class="block text-sm font-medium text-reserve-ink"
            >
              Title <span class="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="title"
              v-model="title"
              type="text"
              placeholder="Licensed Massage Therapist"
              class="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-reserve-primary focus:outline-none focus:ring-2 focus:ring-reserve-soft/40"
            />
          </div>

          <div>
            <label
              for="password"
              class="block text-sm font-medium text-reserve-ink"
              >Password</label
            >
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
              class="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-reserve-primary focus:outline-none focus:ring-2 focus:ring-reserve-soft/40"
            />
            <p class="mt-1 text-xs text-gray-400">At least 8 characters.</p>
          </div>

          <div>
            <label
              for="confirm"
              class="block text-sm font-medium text-reserve-ink"
              >Confirm password</label
            >
            <input
              id="confirm"
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              required
              class="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-reserve-primary focus:outline-none focus:ring-2 focus:ring-reserve-soft/40"
            />
          </div>

          <p v-if="errorMessage" class="text-sm text-red-600" role="alert">
            {{ errorMessage }}
          </p>

          <button
            type="button"
            :disabled="
              submitting || !displayName || !password || !confirmPassword
            "
            class="w-full rounded-lg bg-reserve-primary py-2.5 text-sm font-semibold text-white transition hover:bg-reserve-soft disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-reserve-teal"
            @click="accept"
          >
            {{ submitting ? "Creating account…" : "Create account" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
