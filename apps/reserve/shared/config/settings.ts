/**
 * The app's server-side settings, ONE registry (docs/deployment.md,
 * "Secrets at runtime"). Every entry is read at run time from
 * runtimeConfig under its NUXT_ name; nuxt.config.ts gives each an empty
 * default, never process.env, so nothing is baked into a build.
 *
 * Read by: server/plugins/config-report.ts (the startup report),
 * scripts/verify-build-secrets.mjs (the sentinel build and the startup
 * probe), tests/guards/runtimeConfigDefaults.test.ts (the structural
 * guard), and docs/deployment.md is written from it by hand.
 */
export interface Setting {
  /** The environment variable Vercel (or a laptop's .env) sets. */
  env: string;
  /** Where it lands in useRuntimeConfig(): a dotted path. */
  config: string;
  /** Secret (never logged, never baked, never public) or plain configuration. */
  secret: boolean;
  /** What refuses, in words, when it is missing. */
  without: string;
  /** Needed at build time as well (public values the module validates), or run time only. */
  build: boolean;
}

export const SETTINGS: Setting[] = [
  { env: "NUXT_STRIPE_SECRET_KEY", config: "stripeSecretKey", secret: true, build: false, without: "card-on-file checkout, card refunds, the late-cancellation fee charge and the webhook answer 503" },
  { env: "NUXT_STRIPE_WEBHOOK_SECRET", config: "stripeWebhookSecret", secret: true, build: false, without: "POST /api/stripe/webhook answers 503" },
  { env: "NUXT_ANTHROPIC_API_KEY", config: "anthropicApiKey", secret: true, build: false, without: "Ask answers 503" },
  { env: "NUXT_ASK_DATABASE_URL", config: "askDatabaseUrl", secret: true, build: false, without: "Ask's read-only connection refuses" },
  { env: "NUXT_FORM_IP_PEPPER", config: "formIpPepper", secret: true, build: false, without: "the public form submission routes answer 503" },
  { env: "NUXT_COMMUNICATIONS_JOB_SECRET", config: "communicationsJobSecret", secret: true, build: false, without: "POST /api/jobs/communications answers 503" },
  { env: "NUXT_RESEND_WEBHOOK_SECRET", config: "resendWebhookSecret", secret: true, build: false, without: "POST /api/webhooks/resend answers 503" },
  { env: "NUXT_RESEND_API_KEY", config: "resendApiKey", secret: true, build: false, without: "no email is sent (sendMail logs and returns false)" },
  { env: "NUXT_SUPABASE_SECRET_KEY", config: "supabase.secretKey", secret: true, build: false, without: "every service-role route refuses" },
  { env: "NUXT_MAIL_FROM", config: "mailFrom", secret: false, build: false, without: "no email is sent" },
  { env: "NUXT_LEADS_ORGANIZATION_ID", config: "leadsOrganizationId", secret: false, build: false, without: "POST /api/public/leads answers 503" },
  { env: "NUXT_LEADS_ALLOWED_ORIGINS", config: "leadsAllowedOrigins", secret: false, build: false, without: "no browser origin may post a lead" },
  { env: "NUXT_PUBLIC_SITE_URL", config: "public.siteUrl", secret: false, build: false, without: "emailed links fall back to the request's own origin" },
  { env: "NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", config: "public.stripePublishableKey", secret: false, build: false, without: "the card-on-file form cannot load Stripe Elements" },
  { env: "NUXT_PUBLIC_SUPABASE_URL", config: "public.supabase.url", secret: false, build: true, without: "nothing works: no database" },
  { env: "NUXT_PUBLIC_SUPABASE_KEY", config: "public.supabase.key", secret: false, build: true, without: "nothing works: no database" },
];

/** Read a dotted path off a config object. */
export function readSetting(config: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), config);
}
