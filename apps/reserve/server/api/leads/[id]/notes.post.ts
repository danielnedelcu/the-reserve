import { requirePermission } from "../../../utils/requireUser";

/**
 * POST /api/leads/:id/notes
 * Body: { body: string }
 *
 * Append-only, authored, dated — the client_notes pattern without the
 * health tier. The author is current_staff_id() and nothing else: the
 * insert policy pins staff_id to it, so a note cannot be written "as"
 * someone else, and the route never accepts an author from the client.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "leads.manage");
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing id" });

  const payload = await readBody<{ body?: string }>(event);
  const text = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (text.length < 1 || text.length > 4000) {
    throw createError({ statusCode: 422, statusMessage: "A note needs between 1 and 4000 characters." });
  }

  const { data: staffId } = await client.rpc("current_staff_id");
  if (!staffId) throw createError({ statusCode: 403, statusMessage: "No staff identity in scope" });

  const { data: note, error } = await client
    .from("lead_notes")
    .insert({ lead_id: id, staff_id: staffId, body: text })
    .select("id, body, created_at")
    .single();
  if (error) {
    // RLS refuses a note on a lead the caller cannot see (wrong org, or the
    // lead is gone); PostgREST reports that as a policy violation.
    if (/row-level security/i.test(error.message)) {
      throw createError({ statusCode: 404, statusMessage: "Lead not found" });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return { note };
});
