import { serverSupabaseServiceRole } from "#supabase/server";
import { requirePermission, actorUserId } from "../../../utils/requireUser";
import { LEAD_MANUAL_STATUSES, type LeadManualStatus } from "~~/shared/leads/constants";

/**
 * POST /api/leads/:id/status
 * Body: { status: "new" | "contacted" | "qualified" | "lost" }
 *
 * `converted` is NOT accepted here, and the refusal is the point. Converted
 * means "became a prospect": the conversion action (phase 4) issues the
 * intake link and threads prospect_intake.lead_id in the same move. A
 * status set by hand would record a conversion with no prospect behind it,
 * and the provenance chain would have a head with nothing attached. The
 * allowed set is LEAD_MANUAL_STATUSES — the same list the status control
 * offers, so the two cannot disagree. A lead that HAS converted is owned by
 * that conversion and cannot be moved back by hand either.
 */
export default defineEventHandler(async (event) => {
  const { client, user } = await requirePermission(event, "leads.manage");
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing id" });

  const body = await readBody<{ status?: string }>(event);
  const status = body?.status;
  if (!status || !(LEAD_MANUAL_STATUSES as readonly string[]).includes(status)) {
    throw createError({
      statusCode: 400,
      statusMessage:
        status === "converted"
          ? "A lead becomes converted by sending them the intake form, not by setting the status."
          : `status must be one of: ${LEAD_MANUAL_STATUSES.join(", ")}`,
    });
  }

  const { data: staffId } = await client.rpc("current_staff_id");
  if (!staffId) throw createError({ statusCode: 403, statusMessage: "No staff identity in scope" });

  const { data: before } = await client.from("leads").select("status").eq("id", id).maybeSingle();
  if (!before) throw createError({ statusCode: 404, statusMessage: "Lead not found" });
  if (before.status === "converted") {
    throw createError({
      statusCode: 409,
      statusMessage: "This lead has already been converted; its status is owned by that conversion.",
    });
  }
  if (before.status === status) return { lead: { id, status } };

  // Through the USER's client: RLS (leads.manage, org-scoped) authorises it.
  const { data: updated, error } = await client
    .from("leads")
    .update({ status: status as LeadManualStatus })
    .eq("id", id)
    .select("id, status, updated_at")
    .single();
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const admin = serverSupabaseServiceRole(event);
  await admin.from("audit_log").insert({
    actor_staff_id: staffId,
    actor_user_id: actorUserId(user),
    action: "lead.status_changed",
    entity_type: "leads",
    entity_id: id,
    detail: { from_status: before.status, to_status: status },
  });

  return { lead: updated };
});
