/**
 * The vocabulary of communications_sent.kind, humanized — shared by the
 * profile's history view (app) and the resend route (server) so the two
 * never disagree about what a kind is called or which kinds may be
 * resent (client communications, phase 5).
 *
 * Mirrors the check constraint on communications_sent.kind; adding a
 * touchpoint means a constraint swap AND a label here, and the test
 * asserts every constraint value has a label.
 */

export const COMMUNICATION_KINDS = [
  "confirmation",
  "day_before_reminder",
  "intake_reminder",
  "cancellation_notice",
  "post_visit_followup",
  "birthday",
] as const;
export type CommunicationKind = (typeof COMMUNICATION_KINDS)[number];

const KIND_LABELS: Record<CommunicationKind, string> = {
  confirmation: "Booking confirmation",
  day_before_reminder: "Day-before reminder",
  intake_reminder: "Intake form reminder",
  cancellation_notice: "Cancellation notice",
  post_visit_followup: "Post-visit follow-up",
  birthday: "Birthday",
};

/** Human label; an unknown kind falls back to itself rather than blanking. */
export function communicationKindLabel(kind: string): string {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

const CHANNEL_LABELS: Record<string, string> = { email: "Email", sms: "SMS" };

export function communicationChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/**
 * Only the booking confirmation may be resent by hand. The other kinds
 * are tied to a moment (the day before, the day after, a birthday) or to
 * an event that already happened (a cancellation), so resending them
 * later would say something untrue.
 */
export function isResendable(kind: string): boolean {
  return kind === "confirmation";
}

/**
 * The appointment a sent row was about, from the SNAPSHOT in metadata:
 * "Herbal Body Wrap · Sun, Sep 27, 10:00 AM". Read from metadata rather
 * than the appointment row because the row may since have been
 * cancelled or moved, and the history must say what the client was
 * TOLD at the time. Null when the row carries no appointment (birthday).
 */
export function appointmentReference(
  metadata: unknown,
  timeZone?: string,
): string | null {
  const m = (metadata ?? {}) as { service_name?: unknown; starts_at?: unknown };
  const service = typeof m.service_name === "string" ? m.service_name : null;
  const startsAt =
    typeof m.starts_at === "string" && !Number.isNaN(Date.parse(m.starts_at))
      ? new Date(m.starts_at).toLocaleString("en-US", {
          timeZone,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  if (!service && !startsAt) return null;
  return [service, startsAt].filter(Boolean).join(" · ");
}
