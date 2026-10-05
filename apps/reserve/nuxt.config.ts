// NPM Modules
import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  modules: [
    "@nuxt/eslint",
    "@nuxt/icon",
    "@nuxt/test-utils/module",
    "@nuxtjs/supabase",
    "@pinia/nuxt",
    "@vee-validate/nuxt",
    "@vueuse/nuxt",
    "motion-v/nuxt",
    "vue-sonner/nuxt",
    "@nuxtjs/color-mode",
    "@yuta-inoue-ph/nuxt-vcalendar",
  ],
  imports: {
    imports: [
      { from: "tailwind-variants", name: "tv" },
      { from: "tailwind-variants", name: "VariantProps", type: true },
      { from: "vue-sonner", name: "toast", as: "useSonner" },
    ],
  },
  devtools: {
    enabled: true,
  },
  app: {
    head: {
      htmlAttrs: {
        lang: "en",
      },
      title: "The Reserve",
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
      ],
    },
  },
  css: ["~/assets/css/main.css"],
  colorMode: {
    classSuffix: "", // ui-thing/Tailwind expect 'dark' class, not 'dark-mode'
  },
  runtimeConfig: {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    // Ask The Reserve: question + schema go out, result rows never do.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    // Connection string for the ask_readonly role. Its session user IS
    // the safety boundary — never point this at a privileged role.
    askDatabaseUrl: process.env.ASK_DATABASE_URL,
    // Keyed-hash secret for public form submission attempt logs. IPs are
    // HMAC'd under this, never stored raw and never plainly hashed (an
    // unsalted IPv4 digest is precomputable, so plaintext-equivalent).
    // Absent => the public submission route refuses to serve.
    formIpPepper: process.env.FORM_IP_PEPPER,
    // Public lead capture (/api/public/leads). A landing-page POST carries
    // no session and no token, so the organisation a lead belongs to is a
    // SERVER-SIDE fact set here, never a client claim. Absent => the route
    // refuses to serve.
    leadsOrganizationId: process.env.LEADS_ORGANIZATION_ID,
    // Bearer secret the scheduled communications route requires
    // (POST /api/jobs/communications). pg_cron presents the same value
    // from Vault (communications_job_secret). Absent => the route refuses
    // to serve — fail-closed, like the pepper and the leads org.
    communicationsJobSecret: process.env.COMMUNICATIONS_JOB_SECRET,
    // Resend's webhook signing secret (marketing campaigns, phase 2).
    // Fail-closed: the webhook route refuses to serve without it.
    resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    // Exact origins (comma-separated) allowed to call it from a browser —
    // the marketing site. Never `*`. Absent => no cross-origin caller.
    leadsAllowedOrigins: process.env.LEADS_ALLOWED_ORIGINS,
    // ...existing server-side entries...
    public: {
      stripePublishableKey: process.env.NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      // The address links in outbound email point at (the cancel link, and
      // in phase 3 the reminders, which are sent by jobs with no request
      // to take an origin from). Unset in dev => the route falls back to
      // its own request origin, so a link mailed from staging cannot point
      // at production. Set it in every deployed environment.
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL ?? "",
      // ...existing public entries...
    },
  },
  build: {
    transpile: ["@tanstack/vue-table"],
  },
  // Fixed dev port. Nuxt would otherwise fall back to another port when
  // 3000 is busy, and the Supabase redirect URLs and Stripe return URLs
  // are registered for this one (docs/turborepo-migration.md).
  devServer: { port: 3000 },
  compatibilityDate: "2026-07-25",
  vite: {
    plugins: [tailwindcss()],
  },
  typescript: {
    strict: true,
  },
  eslint: {
    config: {
      stylistic: {
        semi: true,
        quotes: "double",
        commaDangle: "always-multiline",
        indent: 2,
      },
    },
  },
  icon: {
    serverBundle: {
      collections: ["lucide"],
    },
  },
  supabase: {
    types: "~~/shared/types/database.ts",
    redirect: true,
    redirectOptions: {
      login: "/login",
      callback: "/confirm",
      // /join/** is the public intake page: reached by a tokenized link
      // by people with no account at all, so the token is the whole
      // authorization. It sits under its own prefix rather than beside
      // the authoring screens at /forms — an exemption on a prefix that
      // also holds staff pages would silently exempt the next one added.
      exclude: [
        "/invite/**",
        "/join/**",
        // /cancel/** is the public cancel-via-link page (client
        // communications, phase 4): reached from an email by a client with
        // no account; the token is the authorization.
        "/cancel/**",
        // /unsubscribe/** is the one-click unsubscribe page in every
        // marketing campaign email (marketing-campaigns-design.md): same
        // token-only door as /cancel/**.
        "/unsubscribe/**",
        "/forgot-password",
        "/reset-password",
      ],
    },
    clientOptions: {
      auth: {
        flowType: "pkce", // Most secure auth flow
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    },
    cookieOptions: {
      maxAge: 60 * 60 * 24 * 7, // 1 week
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  },
  // zod 4 works with vee-validate directly (Standard Schema);
  // the @vee-validate/zod adapter is zod-3-only, so skip the check.
  veeValidate: {
    typedSchemaPackage: "none",
  },
});
