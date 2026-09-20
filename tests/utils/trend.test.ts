// @vitest-environment node
import { describe, it, expect } from "vitest";
import { trend, TREND_MIN_BASELINE } from "../../app/utils/trend";

// The one period-over-period rule for the KPI cards and the bookings chart.
// Every case is a boundary: the ones a rewrite would get wrong while every
// ordinary month still looked right.
describe("trend", () => {
  it("is null when the previous period is zero — no division, no ∞%", () => {
    expect(trend(5, 0)).toBeNull();
  });

  it("is null below the baseline floor, even for a large change", () => {
    expect(trend(30, TREND_MIN_BASELINE - 1)).toBeNull();
  });

  it("reports at exactly the floor (the floor is inclusive)", () => {
    expect(trend(20, TREND_MIN_BASELINE)).toEqual({
      pct: 100,
      direction: "up",
      good: true,
    });
  });

  it("is null for a zero change — nothing to say", () => {
    expect(trend(12, 12)).toBeNull();
  });

  it("says down, and not good, when the current period is lower", () => {
    expect(trend(10, 20)).toEqual({ pct: 50, direction: "down", good: false });
  });

  it("rounds the percentage", () => {
    expect(trend(13, 12)?.pct).toBe(8); // 8.33…
  });

  it("invert flips goodness only — a falling no-show rate is down AND good", () => {
    expect(trend(5, 20, { invert: true })).toEqual({
      pct: 75,
      direction: "down",
      good: true,
    });
    expect(trend(20, 10, { invert: true })).toEqual({
      pct: 100,
      direction: "up",
      good: false,
    });
  });

  it("an explicit minBaseline of 1 restores the pre-floor behaviour (the KPI placeholders)", () => {
    expect(trend(3, 1, { minBaseline: 1 })).toEqual({
      pct: 200,
      direction: "up",
      good: true,
    });
    expect(trend(3, 0, { minBaseline: 1 })).toBeNull();
  });
});
