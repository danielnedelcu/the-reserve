import { requirePermission } from "../../utils/requireUser";

/**
 * GET /api/leads/:id
 * One lead with its notes thread. Both reads run as the USER, so RLS
 * (leads.view, org-scoped; notes through the parent lead) is what decides
 * what comes back — the route adds nothing the policies do not grant.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "leads.view");
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing id" });

  const { data: lead, error } = await client
    .from("leads")
    .select("id, first_name, last_name, email, phone, interest, source, status, consent, consent_at, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!lead) throw createError({ statusCode: 404, statusMessage: "Lead not found" });

  const { data: notes, error: notesError } = await client
    .from("lead_notes")
    .select("id, body, created_at, author:staff(display_name)")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  if (notesError) throw createError({ statusCode: 500, statusMessage: notesError.message });

  // The other end of the provenance chain, once it exists. Both reads run
  // as the caller: someone with leads.view but not forms.send or
  // forms.responses.view simply gets null here, which the page renders as
  // "sent" without the details.
  const { data: links } = await client
    .from("form_links")
    .select("id, token, expires_at, consumed_at, revoked_at, delivery_email, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(1);
  const { data: prospect } = await client
    .from("prospect_intake")
    .select("id, status, submitted_at")
    .eq("lead_id", id)
    .maybeSingle();

  return { lead, notes: notes ?? [], link: links?.[0] ?? null, prospect: prospect ?? null };
});
