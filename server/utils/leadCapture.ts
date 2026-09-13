import type { SupabaseClient } from "@supabase/supabase-js";
import type { H3CorsOptions } from "h3";
import type { Database } from "~~/shared/types/database";
import { WINDOW_MINUTES } from "./formRateLimit";

/**
 * Server-side plumbing for the public lead capture endpoint — the app's
 * second unauthenticated write path, and the more exposed of the two:
 * OPEN, with no token bounding who may call it.
 *
 * Everything here fails CLOSED. A missing setting makes the route refuse
 * to serve (503) rather than guess, because every guess available — a
 * default organisation, a wildcard origin, an unkeyed hash — is a silent
 * weakening that leaves the tests green.
 */

type Db = SupabaseClient<Database>;

/**
 * WHICH ORGANISATION a public lead belongs to.
 *
 * A landing-page POST carries no session and no token, so nothing in the
 * request can be trusted to name the org: if the page said "org X", anyone
 * could post leads into any org. The org is therefore a SERVER-SIDE fact,
 * set once in configuration. Single-org today, so this is the whole answer;
 * the bounded upgrade when a second org needs its own landing pages is a
 * per-page capture key that maps to an org in the database — a lookup
 * this function would perform instead of reading config. Deliberately not
 * "the first organisations row": that is a hardcode wearing a query.
 */
export function leadOrganizationId(): string {
  const id = useRuntimeConfig().leadsOrganizationId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw createError({
      statusCode: 503,
      statusMessage:
        "Lead capture is not configured on this server (missing LEADS_ORGANIZATION_ID).",
    });
  }
  return id;
}

/**
 * WHICH ORIGINS may call this from a browser.
 *
 * The landing pages live on the marketing site — a different origin from
 * this app — so the browser will preflight. The allowlist is exact origins
 * from configuration, never `*`: a wildcard would let any page on the web
 * embed a form that posts here. Unset means NO cross-origin caller is
 * allowed, which is the safe default for a setting someone forgot.
 *
 * Honest limit: CORS is enforced by browsers. A script with no Origin
 * header (curl, a bot) is not stopped by this, and cannot be — an open
 * endpoint is open. The origin check keeps other WEBSITES from using the
 * form; the honeypot and the rate limit are what stand against scripts.
 */
export function leadAllowedOrigins(): string[] {
  const raw = useRuntimeConfig().leadsAllowedOrigins;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^/\s]+$/i.test(s));
}

export function leadCorsOptions(): H3CorsOptions {
  return {
    origin: leadAllowedOrigins(),
    methods: ["POST"],
    allowHeaders: ["content-type"],
    credentials: false,
    maxAge: "600",
  };
}

/** True when the request names an Origin that is not on the allowlist. */
export function originIsForbidden(origin: string | undefined): boolean {
  if (!origin) return false; // no Origin: not a browser CORS request
  return !leadAllowedOrigins().includes(origin.replace(/\/+$/, ""));
}

/**
 * Attempts allowed from one address per WINDOW_MINUTES. Tighter than the
 * prospect form's 20 because nothing else bounds this endpoint: a person
 * fills a landing page once, perhaps twice after a typo. Per-IP limiting
 * blunts a single abuser and is evaded by a distributed one — that is the
 * KNOWN RESIDUAL, recorded in docs/design/leads-design.md, and CAPTCHA is
 * the escalation keyed to observed abuse, not built pre-emptively.
 */
export const LEAD_IP_ATTEMPT_LIMIT = 5;

/**
 * Lead attempts share form_submission_attempts with the prospect form —
 * same table, same HMAC'd IP, same 24-hour purge — and are told apart by
 * `token is null`: the prospect route records the URL token on EVERY
 * attempt, including garbage ones, so a null token is a lead attempt and
 * nothing else. That discriminator is a convention, not a constraint;
 * verify:leads asserts it holds. Counting only lead attempts here keeps a
 * lead-spam burst from locking a legitimate prospect out from the same
 * address, and vice versa.
 */
export async function checkLeadRateLimit(
  db: Db,
  ipHash: string,
): Promise<{ allowed: boolean; attempts: number }> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await db
    .from("form_submission_attempts")
    .select("id", { count: "exact", head: true })
    .is("token", null)
    .eq("ip_hash", ipHash)
    .gte("created_at", since);
  const attempts = count ?? 0;
  return { allowed: attempts < LEAD_IP_ATTEMPT_LIMIT, attempts };
}

/**
 * Records a lead attempt, accepted or not. Every attempt counts — the
 * rejected ones are the ones worth a record, and counting them is what
 * stops a caller retrying for free. A failure to record is a failure to
 * rate limit, surfaced loudly rather than served around.
 */
export async function recordLeadAttempt(
  db: Db,
  input: { ipHash: string; outcome: "accepted" | "rejected"; organizationId: string },
): Promise<void> {
  const { error } = await db.from("form_submission_attempts").insert({
    token: null,
    ip_hash: input.ipHash,
    outcome: input.outcome,
    organization_id: input.organizationId,
  });
  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: `Could not record lead attempt: ${error.message}`,
    });
  }
}
