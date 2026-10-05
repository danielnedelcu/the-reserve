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
 * The statuses a staff member may SET by hand. `converted` is absent on
 * purpose: it is reached only by the conversion action (sending the
 * intake form, phase 4), which also threads prospect_intake.lead_id —
 * picking it from a dropdown would record a conversion that never
 * happened. The status route refuses it and the status control never
 * offers it, both from this one list.
 */
export const LEAD_MANUAL_STATUSES = ["new", "contacted", "qualified", "lost"] as const;
export type LeadManualStatus = (typeof LEAD_MANUAL_STATUSES)[number];

/** What a lead is a lead FOR, in words a staff member reads. */
export const LEAD_INTEREST_LABELS: Record<LeadInterest, string> = {
  membership: "Membership",
  service: "A service",
  inquiry: "General inquiry",
};

/**
 * The honeypot field name. A landing page renders it hidden (CSS, not
 * `type=hidden`, so a browser never fills it and a naive bot does); a
 * submission that fills it is discarded while being answered exactly like
 * a success, so the bot learns nothing. Named to look worth filling.
 */
export const LEAD_HONEYPOT_FIELD = "website" as const;
