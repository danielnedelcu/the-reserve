/**
 * The prefix a refund's mirror lines carry in name_snapshot: the refund
 * route writes `${REFUND_PREFIX}${original name}`, and Ask's "top
 * services" preset strips it so a refunded service nets against its
 * original under one name. ONE constant, so the two cannot drift
 * (tests/shared/refundPrefix.test.ts fails if either stops using it).
 *
 * It must stay what the ledger already holds: the ledger is append-only,
 * so stored names are never renamed. Every refund line on hosted carries
 * exactly this prefix (checked 2026-10-08).
 */
export const REFUND_PREFIX = "Refund — ";
