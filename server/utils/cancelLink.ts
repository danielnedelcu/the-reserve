import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~~/shared/types/database";
import {
  decideFeeOutcome,
  feeOwedCents,
  isLateCancellation,
  type FeeOutcome,
} from "./cancellationPolicy";

/**
 * The one place that decides whether a cancel link is usable and what
 * using it would cost. Both public cancel routes read through here — the
 * GET that renders the page and the POST that acts — so "is this token
 * good" and "what is the fee" are decided once, not twice (CLAUDE.md:
 * two paths deciding one predicate). The POST's atomic claim is the only
 * check it repeats, and it repeats it in SQL because that is the check
 * that has to be a mutex.
 *
 * Service role throughout: cancellation_tokens has no policies for
 * anyone, by design, and the token is the whole authorization. Nothing
 * here accepts a client or appointment id — a stranger with a guessed id
 * learns nothing, and a stranger with a real token already has the email.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CANCEL_LINK_INVALID_MESSAGE =
  "This link is no longer valid. If you still need to cancel, please call us.";

export interface CancelLinkReady {
  state: "ready";
  token: { id: string; expires_at: string };
  appointment: {
    id: string;
    organization_id: string;
    client_id: string;
    location_id: string;
    starts_at: string;
    status: string;
    serviceName: string;
    staffName: string;
    location: { name: string; timezone: string };
  };
  client: {
    first_name: string;
    last_name: string;
    email: string | null;
    late_cancellation_waiver_used: boolean;
    stripe_customer_id: string | null;
  };
  /** The active card on file, if the fee could be charged to one. */
  card: { stripe_payment_method_id: string; last4: string } | null;
  late: boolean;
  outcome: FeeOutcome;
  feeCents: number;
}

export type CancelLink =
  /** Missing, used, expired, or not even a uuid: one answer for all. */
  | { state: "invalid" }
  /** The token is real but the appointment is already cancelled (staff did it). */
  | { state: "already_cancelled"; appointment: CancelLinkReady["appointment"] }
  | CancelLinkReady;

export async function loadCancelLink(
  admin: SupabaseClient<Database>,
  tokenId: string,
  now: Date,
): Promise<CancelLink> {
  if (!UUID.test(tokenId)) return { state: "invalid" };

  const { data: token, error } = await admin
    .from("cancellation_tokens")
    .select(
      `id, expires_at, used_at,
       appointment:appointments!inner(
         id, organization_id, client_id, location_id, starts_at, status,
         staff:staff!appointments_staff_id_fkey(display_name),
         location:locations(name, timezone),
         services:appointment_services(name_snapshot, sort_order),
         client:clients(first_name, last_name, email,
                        late_cancellation_waiver_used, stripe_customer_id)
       )`,
    )
    .eq("id", tokenId)
    .maybeSingle();
  if (error) {
    console.error("[cancel link] token lookup failed:", error.message);
    return { state: "invalid" };
  }
  if (!token || token.used_at || new Date(token.expires_at) <= now) {
    return { state: "invalid" };
  }

  const a = token.appointment;
  const appointment: CancelLinkReady["appointment"] = {
    id: a.id,
    organization_id: a.organization_id,
    client_id: a.client_id,
    location_id: a.location_id,
    starts_at: a.starts_at,
    status: a.status,
    serviceName:
      [...a.services]
        .sort((x, y) => x.sort_order - y.sort_order)
        .map((s) => s.name_snapshot)
        .join(" + ") || "Your appointment",
    staffName: a.staff?.display_name ?? "your provider",
    location: { name: a.location.name, timezone: a.location.timezone },
  };

  if (a.status === "cancelled") return { state: "already_cancelled", appointment };

  const { data: cardRow } = await admin
    .from("client_payment_methods")
    .select("stripe_payment_method_id, last4")
    .eq("client_id", a.client_id)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A card is only chargeable when the client also has a Stripe customer
  // to charge it against — the pairing checkout requires.
  const card = cardRow && a.client.stripe_customer_id ? cardRow : null;

  const late = isLateCancellation(a.starts_at, now);
  const outcome = decideFeeOutcome({
    late,
    waiverUsed: a.client.late_cancellation_waiver_used,
    hasCard: card !== null,
  });

  return {
    state: "ready",
    token: { id: token.id, expires_at: token.expires_at },
    appointment,
    client: a.client,
    card,
    late,
    outcome,
    feeCents: feeOwedCents(outcome),
  };
}

/** The shape both routes hand the page: nothing a stranger could use. */
export function publicCancelSummary(link: Exclude<CancelLink, { state: "invalid" }>) {
  return {
    serviceName: link.appointment.serviceName,
    staffName: link.appointment.staffName,
    locationName: link.appointment.location.name,
    startsAt: link.appointment.starts_at,
    timezone: link.appointment.location.timezone,
  };
}
