import { localDateKey, localToUtc, zonedParts } from "./zone";

/**
 * The reporting period as the /financials page keeps it in the URL
 * (docs/design/server-tables-design.md, decision 3), turned into ONE
 * half-open UTC window whose edges are the LOCATION's local midnights.
 * The page derives the window once from the URL and hands the two
 * instants to transactions_page; the function never re-derives it.
 *
 * Calendar arithmetic happens on "YYYY-MM-DD" keys; the conversion to an
 * instant happens in the zone through localToUtc, so a day across a DST
 * change comes out 23 or 25 hours long, as it is.
 *
 * WEEKS START ON SUNDAY. The schedule's month grid is Sunday-first and
 * the financials page has always used a Sunday week; the ISO Monday week
 * is not used anywhere a person sees. Stated here so nobody "fixes" it.
 */

export type PeriodKind = "day" | "week" | "month" | "year";
export const PERIOD_KINDS: readonly PeriodKind[] = ["day", "week", "month", "year"];
export const DEFAULT_PERIOD: PeriodKind = "month";

/** A preset around an anchor day, or a custom range of inclusive day keys. */
export type PeriodSpec =
  | { period: PeriodKind; anchor: string }
  | { from: string; to: string };

export interface PeriodRange {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  /** The first day of the window, as a key. */
  fromKey: string;
  /** The LAST day of the window (inclusive), as a key. */
  toKey: string;
  /** "Monday, October 5", "Oct 4 – Oct 10", "October 2026", "2026". From keys, never from a browser Date. */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (key: string) => key.split("-").map(Number) as [number, number, number];

/** Day arithmetic on a key, zone-free (a UTC date is only a calendar here). */
export function shiftDays(key: string, days: number): string {
  const [y, m, d] = parts(key);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return toKey(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}
/** The first day of the month `months` away from the key's month, zone-free. */
export function shiftMonths(key: string, months: number): string {
  const [y, m] = parts(key);
  const at = new Date(Date.UTC(y, m - 1 + months, 1));
  return toKey(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}
/** 0 = Sunday, from the key alone. */
export function weekdayOf(key: string): number {
  const [y, m, d] = parts(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** The first day of the key's month, as a key. */
export function monthStartOf(key: string): string {
  const [y, m] = parts(key);
  return toKey(y, m, 1);
}
/** How many days the key's month has. */
export function daysInMonth(key: string): number {
  return parts(shiftDays(shiftMonths(key, 1), -1))[2];
}
/** The day of the month, 1–31, from the key alone. */
export function dayOfMonth(key: string): number {
  return parts(key)[2];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface KeyLabelOptions {
  /** "Wednesday" or "Wed" before the date; none by default. */
  weekday?: "long" | "short";
  /** "October" or "Oct"; short by default. */
  month?: "long" | "short";
  /** The day of the month; shown by default. */
  day?: boolean;
  /** The year; hidden by default. */
  year?: boolean;
}

/**
 * A "YYYY-MM-DD" key as words, from the key ALONE: "Oct 7", "Wednesday,
 * October 7", "October 7, 2026", "May 3, 1990", "October 2026". No Date,
 * no zone — so a date-only value (a date of birth, a `date` column)
 * displays as stored in every browser. `new Date("1990-05-03")` is UTC
 * midnight and reads as May 2 in a US browser; this never goes there.
 * Instants become keys in the location's zone first (localDateKey).
 */
export function keyLabel(key: string, opts: KeyLabelOptions = {}): string {
  const [y, m, d] = parts(key);
  const month = opts.month === "long" ? MONTHS[m - 1]! : MONTHS[m - 1]!.slice(0, 3);
  const weekday = opts.weekday ? (opts.weekday === "long" ? DAYS[weekdayOf(key)]! : DAYS[weekdayOf(key)]!.slice(0, 3)) : "";
  const date = opts.day === false ? month : `${month} ${d}`;
  const withYear = opts.year ? (opts.day === false ? `${date} ${y}` : `${date}, ${y}`) : date;
  return weekday ? `${weekday}, ${withYear}` : withYear;
}
/** "October", from the key alone. */
export function monthLabel(key: string): string {
  return MONTHS[parts(key)[1] - 1]!;
}
/** "Wed" or "Wednesday", from the key alone. */
export function weekdayLabel(key: string, style: "long" | "short" = "short"): string {
  const name = DAYS[weekdayOf(key)]!;
  return style === "long" ? name : name.slice(0, 3);
}
const longDay = (key: string) => keyLabel(key, { weekday: "long", month: "long", year: true });
const shortDay = (key: string) => keyLabel(key);

/** The inclusive day keys a spec covers, plus its label. Zone-free. */
export function periodDays(spec: PeriodSpec): { fromKey: string; toKey: string; label: string } {
  if ("from" in spec) {
    const fromKey = spec.from <= spec.to ? spec.from : spec.to;
    const toKey = spec.from <= spec.to ? spec.to : spec.from;
    return { fromKey, toKey, label: fromKey === toKey ? longDay(fromKey) : `${shortDay(fromKey)} – ${shortDay(toKey)}` };
  }
  const { period, anchor } = spec;
  const [y, m] = parts(anchor);
  switch (period) {
    case "day":
      return { fromKey: anchor, toKey: anchor, label: longDay(anchor) };
    case "week": {
      const fromKey = shiftDays(anchor, -weekdayOf(anchor)); // back to Sunday
      const toKey = shiftDays(fromKey, 6);
      return { fromKey, toKey, label: `${shortDay(fromKey)} – ${shortDay(toKey)}` };
    }
    case "month": {
      const fromKey = toKey(y, m, 1);
      const toKeyM = shiftDays(shiftMonths(fromKey, 1), -1);
      return { fromKey, toKey: toKeyM, label: `${MONTHS[m - 1]} ${y}` };
    }
    case "year":
      return { fromKey: toKey(y, 1, 1), toKey: toKey(y, 12, 31), label: String(y) };
  }
}

/**
 * The half-open UTC window [from, to) for a spec in a zone: the
 * location's midnight opening the first day to its midnight after the
 * last day. Both the table and the totals take exactly this.
 */
export function periodRange(spec: PeriodSpec, timeZone: string): PeriodRange {
  const { fromKey, toKey, label } = periodDays(spec);
  return {
    from: localToUtc(fromKey, "00:00", timeZone),
    to: localToUtc(shiftDays(toKey, 1), "00:00", timeZone),
    fromKey,
    toKey,
    label,
  };
}

/** The anchor one period earlier or later (prev/next). */
export function shiftPeriod(period: PeriodKind, anchor: string, delta: number): string {
  switch (period) {
    case "day":
      return shiftDays(anchor, delta);
    case "week":
      return shiftDays(anchor, 7 * delta);
    case "month":
      return shiftMonths(anchor, delta);
    case "year": {
      const [y] = parts(anchor);
      return toKey(y + delta, 1, 1);
    }
  }
}

/** The same spec, one period back — what the previous-period comparison asks for. */
export function previousPeriod(spec: PeriodSpec): PeriodSpec {
  if ("from" in spec) {
    const { fromKey, toKey } = periodDays(spec);
    const [fy, fm, fd] = parts(fromKey);
    const [ty, tm, td] = parts(toKey);
    const length = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
    return { from: shiftDays(fromKey, -length), to: shiftDays(fromKey, -1) };
  }
  return { period: spec.period, anchor: shiftPeriod(spec.period, spec.anchor, -1) };
}

/** Today's key in the zone — the default anchor. */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return localDateKey(now, timeZone);
}

/**
 * A rolling window of N days ending now, in the zone: from the location's
 * midnight N−1 days before today to now. The dashboard's "last 7 days".
 */
export function rollingDays(days: number, timeZone: string, now: Date = new Date()): { from: Date; to: Date } {
  const today = localDateKey(now, timeZone);
  return { from: localToUtc(shiftDays(today, -(days - 1)), "00:00", timeZone), to: now };
}

/** The spec a URL describes, or the default month around today in the zone. Never throws. */
export function periodFromQuery(
  query: { period?: unknown; anchor?: unknown; from?: unknown; to?: unknown },
  timeZone: string,
  now: Date = new Date(),
): PeriodSpec {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : Array.isArray(v) && typeof v[0] === "string" ? v[0].trim() : "");
  const isKey = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(zonedParts(`${v}T12:00:00Z`, "UTC").year) && shiftDays(v, 0) === v;
  const from = str(query.from);
  const to = str(query.to);
  if (isKey(from) && isKey(to)) return { from, to };
  const period = str(query.period) as PeriodKind;
  const anchor = str(query.anchor);
  return {
    period: PERIOD_KINDS.includes(period) ? period : DEFAULT_PERIOD,
    anchor: isKey(anchor) ? anchor : todayKey(timeZone, now),
  };
}
