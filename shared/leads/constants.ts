/**
 * The lead vocabulary, in one dependency-free module.
 *
 * These sets ALSO live in the database as check constraints
 * (leads_interest_check, leads_status_check, migration 20260913153010).
 * Two languages deciding one predicate is the bug class CLAUDE.md names,
 * and one shared implementation is impossible here, so verify:leads reads
 * the constraint definitions back from Postgres and asserts they equal
 * these arrays exactly. Change one, and that check tells you to change the
 * other. Kept free of imports so a Node harness can load it directly.
 */

/**
 * What a lead is interested in. A generic, TIER-INDEPENDENT set —
 * deliberately not tied to membership tiers, which do not exist yet (§3,
 * owner-blocked). Refinable when tiers land; not dependent on them.
 */
export const LEAD_INTERESTS = ["membership", "service", "inquiry"] as const;
export type LeadInterest = (typeof LEAD_INTERESTS)[number];

/** new → contacted → qualified → converted | lost. Five, on purpose. */
export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * The honeypot field name. A landing page renders it hidden (CSS, not
 * `type=hidden`, so a browser never fills it and a naive bot does); a
 * submission that fills it is discarded while being answered exactly like
 * a success, so the bot learns nothing. Named to look worth filling.
 */
export const LEAD_HONEYPOT_FIELD = "website" as const;
