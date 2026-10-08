import { serverSupabaseServiceRole } from "#supabase/server";
import type { Json } from "~~/shared/types/database";
import { isResendable } from "~~/shared/communications/kinds";
import { sendMail } from "~~/server/utils/mailer";
import { bookingConfirmationEmail } from "~~/server/utils/emailTemplates";

/**
 * POST /api/clients/:id/communications/resend   body: { sentId }
 * Staff resend of a booking confirmation the client says never arrived
 * (client communications, phase 5).
 *
 * Gate: clients.edit — the same write gate the profile's preferences use.
 * (The brief named clients.manage; that key is not in the catalog, and a
 * gate on a key nobody holds is a silent 403 for everyone.)
 *
 * Only kind = confirmation is resendable (shared/communications/kinds.ts
 * decides, for the button and for this route). The email is rebuilt from
 * the ORIGINAL row's metadata snapshot plus the appointment's location,
 * and refused when the appointment has since been cancelled or has
 * already started: a fresh "your appointment is confirmed" for either
 * would be untrue. The sent log is append-only — this writes a NEW row
 * pointing back at the original, and never touches the original.
 */
export default defineEventHandler(async (event) => {
  const { client: userClient, user } = await requirePermission(
    event,
    "clients.edit",
  );
  const clientId = getRouterParam(event, "id");
  const body = await readBody<{ sentId?: string }>(event);
  if (!clientId || !body?.sentId) {
    throw createError({ statusCode: 422, statusMessage: "sentId is required" });
  }

  // The staff member's own RLS decides whether they may see this client at
  // all; a client outside their org reads as "not found", not "forbidden".
  const { data: visible } = await userClient
    .from("clients")
    .select("id, first_name, email, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  if (!visible) {
    throw createError({ statusCode: 404, statusMessage: "Client not found" });
  }

  const admin = serverSupabaseServiceRole(event);
  const { data: original } = await admin
    .from("communications_sent")
    .select(
      `id, kind, metadata, appointment_id,
       appointment:appointments(id, status, starts_at, staff_id,
         location:locations(name, timezone, phone, city, state, postal_code))`,
    )
    .eq("id", body.sentId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!original) {
    throw createError({ statusCode: 404, statusMessage: "Message not found" });
  }
  if (!isResendable(original.kind)) {
    throw createError({
      statusCode: 422,
      statusMessage: "Only booking confirmations can be resent",
    });
  }
  const appt = original.appointment;
  if (!appt) {
    throw createError({
      statusCode: 409,
      statusMessage: "The appointment no longer exists",
    });
  }
  if (appt.status === "cancelled") {
    throw createError({
      statusCode: 409,
      statusMessage: "This appointment was cancelled — nothing to confirm",
    });
  }
  if (Date.parse(appt.starts_at) <= Date.now()) {
    throw createError({
      statusCode: 409,
      statusMessage: "This appointment has already started",
    });
  }
  if (!visible.email) {
    throw createError({
      statusCode: 422,
      statusMessage: "The client has no email address on file",
    });
  }

  const snapshot = (original.metadata ?? {}) as {
    service_name?: string;
    staff_name?: string;
    starts_at?: string;
    cancel_url?: string;
  };
  // The cancel link is minted once per appointment at booking; reusing
  // the snapshot's URL keeps the resend pointing at the same token. If
  // that token has since been used the appointment would be cancelled,
  // which is refused above.
  if (!snapshot.cancel_url) {
    throw createError({
      statusCode: 409,
      statusMessage: "The original message has no cancel link to reuse",
    });
  }

  const content = bookingConfirmationEmail({
    clientFirstName: visible.first_name,
    serviceName: snapshot.service_name ?? "Your appointment",
    staffName: snapshot.staff_name ?? "your provider",
    startsAtIso: appt.starts_at,
    timezone: appt.location.timezone,
    location: {
      name: appt.location.name,
      phone: appt.location.phone,
      city: appt.location.city,
      state: appt.location.state,
      postalCode: appt.location.postal_code,
    },
    cancelUrl: snapshot.cancel_url,
  });
  // TODO(sms): email-only until the SMS phase.
  const emailed = await sendMail({ to: visible.email, ...content });
  if (!emailed) {
    throw createError({
      statusCode: 502,
      statusMessage: "The email could not be sent. Please try again.",
    });
  }

  const { data: staffId } = await userClient.rpc("current_staff_id");
  const metadata: Json = {
    ...(original.metadata as Record<string, Json> | null),
    resent_from: original.id,
    resent_by_staff_id: staffId ?? null,
  };
  const { data: row, error } = await admin
    .from("communications_sent")
    .insert({
      organization_id: visible.organization_id,
      client_id: clientId,
      appointment_id: appt.id,
      kind: "confirmation",
      channel: "email",
      metadata,
    })
    .select("id, sent_at")
    .single();
  if (error) {
    console.error("[communications resend] sent but not logged:", error.message);
  }

  await admin.from("audit_log").insert({
    organization_id: visible.organization_id, // the client's, read above
    actor_staff_id: staffId ?? null,
    actor_user_id: actorUserId(user),
    action: "communication.resent",
    entity_type: "communications_sent",
    entity_id: row?.id ?? original.id,
    detail: { client_id: clientId, resent_from: original.id, kind: "confirmation" },
  });

  return { id: row?.id ?? null, sentAt: row?.sent_at ?? null };
});
