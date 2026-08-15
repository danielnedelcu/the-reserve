import { serverSupabaseServiceRole } from "#supabase/server";
import { requirePermission } from "../../utils/requireUser";

/**
 * POST /api/appointments
 * Body: { clientId, serviceId, staffId, startsAt (ISO), roomId?, notes? }
 *
 * The contract's booking flow:
 *  - windows and price re-derived SERVER-SIDE from the catalog (client-sent
 *    numbers are never trusted)
 *  - qualification verified
 *  - room re-verified (or picked) at insert time
 *  - exclusion violation (23P01) surfaced as "slot just taken" — the normal
 *    concurrency path, not an error
 *  - line-item snapshots written; booking audit-logged
 *
 * The insert runs on the CALLER'S RLS client: appointments.create and
 * booked_by = current_staff_id() are enforced by the database itself.
 */
export default defineEventHandler(async (event) => {
  const { user, client } = await requirePermission(
    event,
    "appointments.create",
  );
  const body = await readBody<{
    clientId?: string;
    serviceId?: string;
    staffId?: string;
    startsAt?: string;
    roomId?: string;
    notes?: string;
  }>(event);

  if (!body?.clientId || !body.serviceId || !body.staffId || !body.startsAt) {
    throw createError({
      statusCode: 400,
      statusMessage: "clientId, serviceId, staffId and startsAt are required",
    });
  }

  const startsAtMs = Date.parse(body.startsAt);
  if (Number.isNaN(startsAtMs)) {
    throw createError({
      statusCode: 400,
      statusMessage: "startsAt must be an ISO datetime",
    });
  }

  // --- Re-derive everything from the catalog ---------------------------------
  const { data: service } = await client
    .from("services")
    .select(
      "id, name, price_cents, duration_minutes, buffer_before_min, buffer_after_min, requires_intake, active, organization_id, service_resource_requirements(resource_type_id)",
    )
    .eq("id", body.serviceId)
    .maybeSingle();
  if (!service || !service.active) {
    throw createError({
      statusCode: 404,
      statusMessage: "Service not found or inactive",
    });
  }

  const { data: qualification } = await client
    .from("service_staff")
    .select("duration_override_min, price_override_cents")
    .eq("service_id", body.serviceId)
    .eq("staff_id", body.staffId)
    .maybeSingle();
  if (!qualification) {
    throw createError({
      statusCode: 422,
      statusMessage: "Staff member is not qualified for this service",
    });
  }

  // TODO(intake): once intake forms exist, block booking here when
  // service.requires_intake and the client has no completed intake.

  const duration =
    qualification.duration_override_min ?? service.duration_minutes;
  const price = qualification.price_override_cents ?? service.price_cents;

  const startsAt = new Date(startsAtMs);
  const endsAt = new Date(startsAtMs + duration * 60_000);
  const blockedFrom = new Date(startsAtMs - service.buffer_before_min * 60_000);
  const blockedUntil = new Date(
    endsAt.getTime() + service.buffer_after_min * 60_000,
  );

  // --- Location + room --------------------------------------------------------
  const { data: location } = await client
    .from("locations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!location)
    throw createError({
      statusCode: 500,
      statusMessage: "No location configured",
    });

  const requiredTypes = service.service_resource_requirements.map(
    (r) => r.resource_type_id,
  );
  let roomId: string | null = null;

  if (requiredTypes.length) {
    const { data: rooms } = await client
      .from("resources")
      .select("id")
      .eq("location_id", location.id)
      .eq("active", true)
      .in("resource_type_id", requiredTypes);

    if (!rooms?.length) {
      throw createError({
        statusCode: 422,
        statusMessage: "No rooms exist for this service's requirements",
      });
    }

    // Prefer the caller's suggested room if it qualifies; otherwise find one
    // that is free for the blocked window right now. The exclusion constraint
    // remains the true arbiter under concurrency.
    const candidateIds =
      body.roomId && rooms.some((r) => r.id === body.roomId)
        ? [
            body.roomId,
            ...rooms.map((r) => r.id).filter((id) => id !== body.roomId),
          ]
        : rooms.map((r) => r.id);

    const { data: busy } = await client
      .from("appointments")
      .select("resource_id")
      .in("resource_id", candidateIds)
      .not("status", "in", "(cancelled,no_show)")
      .lt("blocked_from", blockedUntil.toISOString())
      .gt("blocked_until", blockedFrom.toISOString());

    const busyIds = new Set((busy ?? []).map((b) => b.resource_id));
    roomId = candidateIds.find((id) => !busyIds.has(id)) ?? null;
    if (!roomId) {
      throw createError({
        statusCode: 409,
        statusMessage: "No room is free for that time — pick another slot",
      });
    }
  }

  // --- Insert (caller's RLS client; DB enforces booked_by + permissions) ------
  const { data: staffIdSelf } = await client.rpc("current_staff_id");

  const { data: appointment, error: insertError } = await client
    .from("appointments")
    .insert({
      organization_id: service.organization_id,
      location_id: location.id,
      client_id: body.clientId,
      staff_id: body.staffId,
      resource_id: roomId,
      blocked_from: blockedFrom.toISOString(),
      blocked_until: blockedUntil.toISOString(),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      booked_by: staffIdSelf,
      notes: body.notes ?? null,
    })
    .select("id")
    .single();

  if (insertError) {
    // 23P01 = exclusion violation: someone grabbed the slot concurrently.
    if (insertError.code === "23P01") {
      throw createError({
        statusCode: 409,
        statusMessage: "That slot was just taken — please pick another time",
      });
    }
    throw createError({ statusCode: 500, statusMessage: insertError.message });
  }

  // --- Line-item snapshot ------------------------------------------------------
  const { error: lineError } = await client
    .from("appointment_services")
    .insert({
      appointment_id: appointment.id,
      service_id: service.id,
      name_snapshot: service.name,
      price_cents: price,
      duration_min: duration,
    });
  if (lineError) {
    // Booking exists but the snapshot failed — surface loudly rather than hide.
    throw createError({
      statusCode: 500,
      statusMessage: `Booked, but line item failed: ${lineError.message}`,
    });
  }

  // --- Audit --------------------------------------------------------------------
  const admin = serverSupabaseServiceRole(event);
  await admin.from("audit_log").insert({
    actor_staff_id: staffIdSelf,
    actor_user_id: user.id,
    action: "appointment.booked",
    entity_type: "appointment",
    entity_id: appointment.id,
    detail: {
      client_id: body.clientId,
      staff_id: body.staffId,
      service: service.name,
      starts_at: startsAt.toISOString(),
      price_cents: price,
    },
  });

  return { id: appointment.id, roomId };
});
