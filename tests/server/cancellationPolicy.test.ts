// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  LATE_CANCELLATION_FEE_CENTS,
  isLateCancellation,
  decideFeeOutcome,
  consumesWaiver,
  feeOwedCents,
  type FeeOutcome,
} from "../../server/utils/cancellationPolicy";

/**
 * The fee policy at its edges (client communications, phase 4). Every
 * case here is a place where a rewrite could disagree with the policy
 * while the ordinary "cancelled a week early" path still looked right.
 */
const START = "2026-09-29T13:15:00Z";

describe("the 24-hour window", () => {
  it("is late strictly AFTER the cutoff; at the cutoff is on time", () => {
    const cutoff = new Date("2026-09-28T13:15:00Z");
    expect(isLateCancellation(START, cutoff)).toBe(false);
    expect(isLateCancellation(START, new Date(cutoff.getTime() + 1))).toBe(
      true,
    );
    expect(isLateCancellation(START, new Date(cutoff.getTime() - 1))).toBe(
      false,
    );
  });

  it("a week early is never late; an hour before is", () => {
    expect(isLateCancellation(START, new Date("2026-09-22T13:15:00Z"))).toBe(
      false,
    );
    expect(isLateCancellation(START, new Date("2026-09-29T12:15:00Z"))).toBe(
      true,
    );
  });
});

describe("the fee decision", () => {
  it("outside the window nothing else matters", () => {
    for (const waiverUsed of [true, false]) {
      for (const hasCard of [true, false]) {
        expect(decideFeeOutcome({ late: false, waiverUsed, hasCard })).toBe(
          "outside_window",
        );
      }
    }
  });

  it("late, first time: waived — whether or not a card is on file", () => {
    expect(
      decideFeeOutcome({ late: true, waiverUsed: false, hasCard: true }),
    ).toBe("waived");
    expect(
      decideFeeOutcome({ late: true, waiverUsed: false, hasCard: false }),
    ).toBe("waived");
  });

  it("late, waiver spent: charge with a card, uncollected without", () => {
    expect(
      decideFeeOutcome({ late: true, waiverUsed: true, hasCard: true }),
    ).toBe("charge");
    expect(
      decideFeeOutcome({ late: true, waiverUsed: true, hasCard: false }),
    ).toBe("uncollected");
  });
});

describe("what each outcome does to the client's record", () => {
  it("only a forgiven late cancellation spends the waiver", () => {
    // The no-card case in particular: the client never received the
    // waiver's benefit, so it must survive for next time.
    const spends: Record<FeeOutcome, boolean> = {
      outside_window: false,
      waived: true,
      charge: false,
      uncollected: false,
    };
    for (const [outcome, expected] of Object.entries(spends)) {
      expect(consumesWaiver(outcome as FeeOutcome)).toBe(expected);
    }
  });

  it("the fee is owed under charge AND uncollected, and is $50", () => {
    expect(LATE_CANCELLATION_FEE_CENTS).toBe(5000);
    expect(feeOwedCents("charge")).toBe(5000);
    expect(feeOwedCents("uncollected")).toBe(5000);
    expect(feeOwedCents("waived")).toBe(0);
    expect(feeOwedCents("outside_window")).toBe(0);
  });
});
