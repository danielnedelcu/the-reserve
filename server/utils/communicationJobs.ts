import { localToUtc } from "./timezone";

/**
 * The pure logic behind the four scheduled communications (client
 * communications, phase 3 — docs/design/client-communications-design.md).
 * Everything here is a function of its inputs so it can be unit-tested;
 * the route (server/api/jobs/communications.post.ts) does the I/O.
 *
 * The invariants these functions carry:
 *  - "tomorrow" and "yesterday" are LOCAL calendar days in the location's
 *    timezone, built with localToUtc the way the slots route builds its
 *    day, and the window's end is the NEXT local midnight, never
 *    start + 24h (a DST day is 23 or 25 hours long).
 *  - The dedup guard is appointment-scoped for the three appointment
 *    touchpoints and year-scoped for birthdays: one per client per
 *    calendar year, in the location's timezone.
 *  - Opt-in gates only the NON-transactional kinds. A client cannot opt
 *    out of being told about their own appointment.
 *  - Delivery is email regardless of the recorded channel until the SMS
 *    phase; the preference is recorded, the delivery is not yet built.
 */

export const JOB_KINDS = [
  "day_before_reminder",
  "intake_reminder",
  "post_visit_followup",
  "birthday",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return (
    typeof value === "string" &&
    (JOB_KINDS as readonly string[]).includes(value)
  );
}

/** Transactional touchpoints fire regardless of communication_opted_in. */
export function isTransactional(kind: JobKind): boolean {
  return kind === "day_before_reminder" || kind === "intake_reminder";
}

/** True when the client's opt-in state means this kind must NOT be sent. */
export function blockedByOptIn(kind: JobKind, optedIn: boolean): boolean {
  return !isTransactional(kind) && !optedIn;
}

/**
 * What we can actually deliver on today. TODO(sms): communication_channel
 * is recorded (email | sms | both) but SMS delivery is deferred, so every
 * preference resolves to email here. When SMS lands this is the one
 * place that changes.
 */
export function deliveryChannel(_preference: string): "email" {
  return "email";
}

/** "YYYY-MM-DD" of an instant, in a timezone. */
export function localDateKey(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-CA", { timeZone });
}

/** Shift a "YYYY-MM-DD" key by whole days, as calendar arithmetic (no tz). */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The UTC window [from, to) covering one LOCAL calendar day: today in
 * `timeZone` shifted by `offsetDays` (+1 = tomorrow, -1 = yesterday).
 */
export function localDayWindow(
  now: Date,
  timeZone: string,
  offsetDays: number,
): { dateKey: string; from: Date; to: Date } {
  const dateKey = shiftDateKey(localDateKey(now, timeZone), offsetDays);
  return {
    dateKey,
    from: localToUtc(dateKey, "00:00", timeZone),
    to: localToUtc(shiftDateKey(dateKey, 1), "00:00", timeZone),
  };
}

/** Start of the current LOCAL calendar year, as a UTC instant. */
export function localYearStart(now: Date, timeZone: string): Date {
  const year = localDateKey(now, timeZone).slice(0, 4);
  return localToUtc(`${year}-01-01`, "00:00", timeZone);
}

/** Month and day of `dob` ("YYYY-MM-DD") match the local date key. */
export function isBirthday(dob: string | null, localToday: string): boolean {
  if (!dob) return false;
  return dob.slice(5, 10) === localToday.slice(5, 10);
}

export interface SentRow {
  client_id: string;
  appointment_id: string | null;
  kind: string;
  sent_at: string;
}

/** Appointment-scoped guard: this kind already went out for this booking. */
export function alreadySentForAppointment(
  sent: readonly SentRow[],
  appointmentId: string,
  kind: JobKind,
): boolean {
  return sent.some(
    (r) => r.appointment_id === appointmentId && r.kind === kind,
  );
}

/** Year-scoped guard: this client already had this kind since `yearStart`. */
export function alreadySentThisYear(
  sent: readonly SentRow[],
  clientId: string,
  kind: JobKind,
  yearStart: Date,
): boolean {
  return sent.some(
    (r) =>
      r.client_id === clientId &&
      r.kind === kind &&
      Date.parse(r.sent_at) >= yearStart.getTime(),
  );
}

/** The late-cancellation cutoff: 24 hours before the appointment starts. */
export function lateCancellationCutoff(startsAtIso: string): Date {
  return new Date(Date.parse(startsAtIso) - 24 * 3_600_000);
}
