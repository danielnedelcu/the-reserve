/**
 * Period-over-period change, ONE rule for every dashboard trend.
 *
 * A percentage over a tiny baseline misleads: with 3 bookings last
 * period, one more this period is "+33%", one fewer is "-33%", and a
 * new spa's first dashboard would open on a red arrow computed from a
 * handful of trial bookings. So below TREND_MIN_BASELINE there is no
 * percentage at all — callers show the plain totals instead. The
 * baseline is the PREVIOUS period's value: it is the denominator, and
 * it is what has to be big enough for a ratio to mean anything.
 *
 * Shared by the KPI cards and the bookings chart so the two cannot
 * disagree about when a change is worth stating.
 */
export const TREND_MIN_BASELINE = 10;

export interface Trend {
  /** Absolute percentage, rounded. */
  pct: number;
  direction: "up" | "down";
  /** Whether the direction is welcome (a falling no-show rate is good). */
  good: boolean;
}

export function trend(
  current: number,
  previous: number,
  opts: { invert?: boolean; minBaseline?: number } = {},
): Trend | null {
  const min = opts.minBaseline ?? TREND_MIN_BASELINE;
  if (!(previous >= min) || previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return null;
  const up = pct > 0;
  return {
    pct: Math.abs(pct),
    direction: up ? "up" : "down",
    good: opts.invert ? !up : up,
  };
}
