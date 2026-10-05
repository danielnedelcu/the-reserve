import { lateCancellationCutoff } from "./communicationJobs";

/**
 * The cancellation-fee policy as pure logic (client communications, phase
 * 4 — docs/design/client-communications-design.md, "The cancellation fee
 * engine"). The public cancel route does the I/O; everything that DECIDES
 * lives here so it can be unit-tested at the edges where a rewrite would
 * quietly disagree with the policy: the exact cutoff instant, a waiver
 * already spent, a card that is on file but inactive.
 *
 * The policy, in one place:
 *  - Window: a cancellation is "late" when it happens strictly after the
 *    cutoff, which is 24 hours before the appointment starts. AT the
 *    cutoff is still on time.
 *  - Fee: $50 flat.
 *  - One lifetime waiver per client: the first late cancellation is
 *    forgiven and consumes it.
 *  - No card on file: the cancellation proceeds, the fee goes
 *    UNCOLLECTED, staff are told so they can settle it at the next visit,
 *    and the waiver is NOT consumed — the client never received its
 *    benefit.
 */

export const LATE_CANCELLATION_FEE_CENTS = 5000;

export type FeeOutcome =
  /** Cancelled with more than 24 hours' notice. Nothing owed. */
  | "outside_window"
  /** Late, first time: the lifetime waiver is spent, nothing charged. */
  | "waived"
  /** Late, waiver already spent, card on file: the fee is charged. */
  | "charge"
  /** Late, waiver already spent, no usable card: fee owed, staff notified. */
  | "uncollected";

/** Late means strictly after the cutoff; at the cutoff is on time. */
export function isLateCancellation(startsAtIso: string, now: Date): boolean {
  return now.getTime() > lateCancellationCutoff(startsAtIso).getTime();
}

export function decideFeeOutcome(input: {
  late: boolean;
  waiverUsed: boolean;
  hasCard: boolean;
}): FeeOutcome {
  if (!input.late) return "outside_window";
  if (!input.waiverUsed) return "waived";
  return input.hasCard ? "charge" : "uncollected";
}

/** Only a forgiven late cancellation spends the waiver. */
export function consumesWaiver(outcome: FeeOutcome): boolean {
  return outcome === "waived";
}

/** What the client owes under this outcome, in cents. */
export function feeOwedCents(outcome: FeeOutcome): number {
  return outcome === "charge" || outcome === "uncollected"
    ? LATE_CANCELLATION_FEE_CENTS
    : 0;
}
