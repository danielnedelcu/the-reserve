/**
 * ONE timezone module for both sides of the scheduler.
 *
 * Appointments store UTC instants; availability_rules store the
 * location's LOCAL times ("Tuesdays 09:00"); the schedule is drawn as a
 * local day. Every conversion between those lives here, with Intl and no
 * library, and takes the zone as a parameter — nothing in it reads the
 * machine's own clock. The slots route (server/api/appointments/slots)
 * and the schedule page (app/pages/schedule.vue) both import it, so the
 * instant a rule turns into and the pixel an appointment lands on are
 * computed by the same code in the same zone. That was the two-timezone
 * seam: the route was in the location's zone and the grid in the
 * viewer's, and a 10:00 AM New York slot was drawn and labelled 7:00 AM
 * in a Los Angeles browser (found by e2e/journeys/03-scheduler.spec.ts,
 * 2026-10-06, after the inventory recorded it 2026-09-19).
 *
 * tests/shared/zone.test.ts asserts the two directions agree across
 * zones with half-hour offsets, no DST, and DST edges — and that none of
 * this changes when the process's own TZ does.
 */

/** Milliseconds to ADD to a UTC instant to read it as local wall time in the zone. */
export function tzOffsetMs(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(utcDate).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcDate.getTime();
}

/**
 * "2026-08-11" + "09:00" in "America/Los_Angeles" -> the UTC instant.
 * Two passes, so a wall time just past a DST change still lands on the
 * right offset.
 */
export function localToUtc(
  dateStr: string,
  timeStr: string,
  timeZone: string,
): Date {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  const offset = tzOffsetMs(naive, timeZone);
  let utc = new Date(naive.getTime() - offset);
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = new Date(naive.getTime() - offset2);
  return utc;
}

/** Day-of-week (0 = Sunday) of a "YYYY-MM-DD" key, independent of any zone. */
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

export interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number; // 0–23
  minute: number;
  weekday: number; // 0 = Sunday
}

/** The wall-clock parts of an instant, read in a zone. */
export function zonedParts(at: Date | string, timeZone: string): ZonedParts {
  const d = typeof at === "string" ? new Date(at) : at;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // some ICU builds print midnight as "24"
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

/** "YYYY-MM-DD" of an instant, in a zone — the day key the schedule files it under. */
export function localDateKey(at: Date | string, timeZone: string): string {
  const { year, month, day } = zonedParts(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Minutes since local midnight in the zone — where on the day grid an instant sits. */
export function minutesIntoDay(at: Date | string, timeZone: string): number {
  const { hour, minute } = zonedParts(at, timeZone);
  return hour * 60 + minute;
}

/** "9:00 AM", in the zone. */
export function timeLabel(at: Date | string, timeZone: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "9a", "9:30a", "1p" — the compact form for week and month chips, in the zone. */
export function shortTime(at: Date | string, timeZone: string): string {
  const { hour, minute } = zonedParts(at, timeZone);
  const h = hour % 12 || 12;
  return `${h}${minute ? ":" + String(minute).padStart(2, "0") : ""}${hour < 12 ? "a" : "p"}`;
}
