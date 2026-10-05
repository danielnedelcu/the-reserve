import { requirePermission } from "../../utils/requireUser";
import { LEAD_STATUSES } from "~~/shared/leads/constants";

/**
 * GET /api/leads?status=open|all|<status>
 * The leads work queue. Contact fields, interest, source, status, timing.
 *
 * `open` (the default) is new + contacted + qualified — everything a
 * staff member can still act on. Oldest first, like /intake: this is a
 * queue of people waiting to hear back, not a feed.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "leads.view");
  const status = String(getQuery(event).status ?? "open");

  let query = client
    .from("leads")
    .select("id, first_name, last_name, email, phone, interest, source, status, consent, created_at, updated_at")
    .order("created_at", { ascending: true });

  if (status === "open") {
    query = query.in("status", ["new", "contacted", "qualified"]);
  } else if (status !== "all") {
    if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
      throw createError({ statusCode: 400, statusMessage: `Unknown status filter: ${status}` });
    }
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { leads: data ?? [] };
});
