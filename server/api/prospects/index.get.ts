import { requirePermission } from "../../utils/requireUser";

/**
 * GET /api/prospects?status=pending|all
 * The review queue. Contact fields and timing only.
 *
 * Deliberately returns NO answers of any kind — the list is a queue, not a
 * reading surface, and health answers never appear on a review screen at
 * all (see the health-gating decision in the design doc).
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "forms.responses.view");
  const status = getQuery(event).status;

  let query = client
    .from("prospect_intake")
    .select("id, first_name, last_name, email, phone, status, submitted_at, reviewed_at")
    .order("submitted_at", { ascending: true });

  if (status !== "all") {
    query = query.in("status", ["submitted", "under_review"]);
  }

  const { data, error } = await query;
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { prospects: data ?? [] };
});
