<template>
  <div class="flex h-screen items-center justify-between">
    <!-- Left: form -->
    <div class="w-full md:w-1/2">
      <div class="mx-auto w-full max-w-[330px] px-5">
        <h1 class="mt-2 text-2xl font-bold tracking-tight lg:text-3xl">
          Log in
        </h1>
        <p class="text-muted-foreground mt-1">
          Enter your email & password to log in.
        </p>

        <form class="mt-10" @submit="submit">
          <fieldset :disabled="isSubmitting" class="grid gap-5">
            <div>
              <UiVeeInput
                label="Email"
                type="email"
                name="email"
                autocomplete="email"
                placeholder="you@thereserve.com"
              />
            </div>
            <div>
              <UiVeeInput
                label="Password"
                type="password"
                name="password"
                autocomplete="current-password"
              />
            </div>
            <div>
              <UiButton
                class="w-full"
                type="submit"
                :text="isSubmitting ? 'Logging in…' : 'Log in'"
              />
            </div>
          </fieldset>
        </form>

        <p class="mt-8 text-sm">
          <NuxtLink
            class="text-primary font-semibold underline-offset-2 hover:underline"
            to="/forgot-password"
          >
            Forgot password?
          </NuxtLink>
        </p>
        <p class="text-muted-foreground mt-4 text-sm">
          Access is by invitation. Contact an administrator if you need an
          account.
        </p>
      </div>
    </div>

    <!-- Right: brand panel -->
    <div
      class="reserve-paper hidden h-screen md:flex md:w-1/2 items-center justify-center"
    >
      <div class="px-8 text-center">
        <BrandLaurel />

        <h2
          class="mt-5 font-serif text-4xl font-medium tracking-[0.18em] text-[#3b2f1e] lg:text-5xl"
        >
          THE RESERVE
        </h2>
        <p class="mt-3 font-serif text-sm tracking-[0.38em] text-[#4a3d2a]">
          WELLNESS CLUB
        </p>

        <div class="mx-auto mt-5 h-px w-16 bg-[#b6975a]" />

        <p
          class="mt-5 text-[11px] font-medium tracking-[0.28em] text-[#4a3d2a]"
        >
          RESTORE&ensp;&bull;&ensp;RECONNECT&ensp;&bull;&ensp;RENEW
        </p>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";
import BrandLaurel from "~/components/brand/BrandLaurel.vue";

definePageMeta({ layout: false, middleware: "guest" });

useSeoMeta({
  title: "Log in — The Reserve",
  description: "Enter your email & password to log in.",
});

const supabase = useSupabaseClient();
const router = useRouter();
const toast = useToast();

const LoginSchema = z.object({
  email: z.email("Email must be a valid email"),
  password: z.string().min(1, "Password is required"),
});

const { handleSubmit, isSubmitting, setFieldError } = useForm({
  validationSchema: toTypedSchema(LoginSchema),
});

const submit = handleSubmit(async (values: z.infer<typeof LoginSchema>) => {
  const { error } = await supabase.auth.signInWithPassword({
    email: values.email,
    password: values.password,
  });

  if (error) {
    if (error.message === "Invalid login credentials") {
      setFieldError("password", "Email or password is incorrect.");
    } else {
      toast.error("Could not log in", error.message);
    }
    return;
  }

  await usePermissions().load(true);
  toast.success("Logged in", "Welcome back.");
  router.push("/");
});
</script>

<style scoped>
/* Cream paper: base tone + soft tonal drift + fine grain (SVG noise, no image asset) */
.reserve-paper {
  background-color: #ece3d0;
  background-image:
    radial-gradient(
      ellipse 120% 80% at 20% 10%,
      rgba(255, 251, 240, 0.55),
      transparent 60%
    ),
    radial-gradient(
      ellipse 100% 90% at 85% 90%,
      rgba(196, 178, 143, 0.28),
      transparent 55%
    ),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E");
}
</style>
