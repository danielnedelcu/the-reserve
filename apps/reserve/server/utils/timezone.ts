/**
 * Timezone helpers for slot computation.
 *
 * availability_rules store LOCAL times ("Tuesdays 09:00") for the location's
 * timezone; appointments store UTC. These helpers convert a local date+time
 * in a named timezone to a UTC Date using Intl (no external libs), with a
 * two-pass correction for DST transition edges.
 */

function tzOffsetMs(utcDate: Date, timeZone: string): number {
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

/** "2026-08-11" + "09:00" in "America/Los_Angeles" -> the correct UTC instant */
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

/** Day-of-week (0=Sunday) for a local date string, independent of server tz */
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}
