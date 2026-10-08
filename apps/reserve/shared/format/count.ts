/**
 * "12,345" — a row count or any whole number for a person to read. The
 * one place numbers are grouped, so `toLocaleString` can be banned from
 * app/ outright (tests/guards/browserClock.test.ts) without the guard
 * having to tell a number from a date.
 */
const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatCount(n: number): string {
  return COUNT.format(n);
}
