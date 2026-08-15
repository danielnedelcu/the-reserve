import { serverSupabaseServiceRole } from "#supabase/server";
import { requirePermission } from "../../../utils/requireUser";

/**
 * GET /api/clients/:id/health-notes
 *
 * Health notes are the most sensitive data in the system. RLS already gates
 * WHO can read them; this route exists because reads must also be AUDITED,
 * and SELECTs can't fire triggers. Every call writes an audit_log entry
 * before returning the notes.
 *
 * The notes query runs on the caller's RLS-scoped client (defense in depth);
 * only the audit write uses the service role (audit_log accepts no inserts
 * from authenticated users by design).
 */
export default defineEventHandler(async (event) => {
  const { user, client } = await requirePermission(
    event,
    "clients.notes.health.view",
  );
  const clientId = getRouterParam(event, "id");
  if (!clientId)
    throw createError({ statusCode: 400, statusMessage: "Missing client id" });

  const { data: notes, error } = await client
    .from("client_notes")
    .select("id, kind, body, created_at, author:staff(display_name)")
    .eq("client_id", clientId)
    .eq("kind", "health")
    .order("created_at", { ascending: false });

  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message });

  // Audit the access — even an empty result is an access.
  const { data: staffId } = await client.rpc("current_staff_id");
  const admin = serverSupabaseServiceRole(event);
  await admin.from("audit_log").insert({
    actor_staff_id: staffId,
    actor_user_id: user.id,
    action: "health_note.viewed",
    entity_type: "client",
    entity_id: clientId,
    detail: { note_count: notes?.length ?? 0 },
  });

  return notes ?? [];
});
