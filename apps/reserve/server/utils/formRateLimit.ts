import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~~/shared/types/database";

/**
 * Rate limiting for the public submission endpoint.
 *
 * State lives in the DATABASE, not in process memory. An in-memory counter
 * keeps limiting correctly right up until there is a second instance, at
 * which point it silently stops being a limit — a security control that
 * fails green, which is the specific thing this project has a convention
 * about. There is no deployment-platform config in the repo, so a single
 * instance cannot be assumed.
 *
 * Two limits, doing different jobs:
 *   per TOKEN — the one that actually holds. A token cannot be forged, so
 *               this caps a leaked link hard, and the token is single-use
 *               anyway. This is the limit the threat model rests on.
 *   per IP    — blunts the cheap case. x-forwarded-for is caller-supplied
 *               unless a proxy overwrites it, so this is a speed bump, not
 *               a boundary. Documented as such rather than trusted.
 */

type Db = SupabaseClient<Database>;

/** Attempts allowed against one token before it is locked out. */
export const TOKEN_ATTEMPT_LIMIT = 5;
/** Attempts allowed from one address across all tokens. */
export const IP_ATTEMPT_LIMIT = 20;
/** The window both limits count over. */
export const WINDOW_MINUTES = 60;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Which limit tripped, for the log and the message. */
  reason: "token" | "ip" | null;
  tokenAttempts: number;
  ipAttempts: number;
}

function windowStart(): string {
  return new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
}

/**
 * Counts recent attempts and decides. Reads only — recording is a separate
 * call, so a caller cannot accidentally count an attempt without also
 * having decided on it.
 */
export async function checkRateLimit(
  db: Db,
  token: string,
  ipHash: string,
): Promise<RateLimitVerdict> {
  const since = windowStart();

  const [{ count: tokenCount }, { count: ipCount }] = await Promise.all([
    db
      .from("form_submission_attempts")
      .select("id", { count: "exact", head: true })
      .eq("token", token)
      .gte("created_at", since),
    db
      .from("form_submission_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since),
  ]);

  const tokenAttempts = tokenCount ?? 0;
  const ipAttempts = ipCount ?? 0;

  if (tokenAttempts >= TOKEN_ATTEMPT_LIMIT) {
    return { allowed: false, reason: "token", tokenAttempts, ipAttempts };
  }
  if (ipAttempts >= IP_ATTEMPT_LIMIT) {
    return { allowed: false, reason: "ip", tokenAttempts, ipAttempts };
  }
  return { allowed: true, reason: null, tokenAttempts, ipAttempts };
}

/**
 * Records an attempt. EVERY attempt is recorded, including rejected ones —
 * a rejected attempt is the one worth having a record of, and counting it
 * is what stops a caller retrying forever at the same cost.
 *
 * organizationId is null when the token resolved to nothing: an attempt
 * with a garbage token belongs to no organisation, and those are exactly
 * the attempts most worth keeping.
 */
export async function recordAttempt(
  db: Db,
  input: {
    token: string | null;
    ipHash: string;
    outcome: "accepted" | "rejected";
    organizationId: string | null;
  },
): Promise<void> {
  const { error } = await db.from("form_submission_attempts").insert({
    token: input.token,
    ip_hash: input.ipHash,
    outcome: input.outcome,
    organization_id: input.organizationId,
  });

  // A failure to record is a failure to rate limit. Surfacing it loudly is
  // the point: silently continuing would serve submissions with the limit
  // effectively switched off.
  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: `Could not record submission attempt: ${error.message}`,
    });
  }
}
