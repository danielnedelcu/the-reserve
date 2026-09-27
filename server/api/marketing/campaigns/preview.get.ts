import { loadAudience, requireAdmin } from "~~/server/utils/campaignAudience";
import { parseAudienceFilter } from "~~/server/utils/campaigns";

/**
 * GET /api/marketing/campaigns/preview?last_visit_months=N
 * Admin + super_admin. The audience the composer's Preview button shows:
 * the count and the names, from the SAME builder the send uses. Sends
 * nothing, writes nothing.
 */
export default defineEventHandler(async (event) => {
  const { orgId } = await requireAdmin(event);
  const q = getQuery(event);
  const raw =
    q.last_visit_months === undefined || q.last_visit_months === ""
      ? null
      : { last_visit_months: Number(q.last_visit_months) };
  const filter = parseAudienceFilter(raw);
  if (filter === undefined) {
    throw createError({
      statusCode: 422,
      statusMessage: "last_visit_months must be one of 1, 3, 6, 12",
    });
  }
  const audience = await loadAudience(event, orgId, filter);
  return {
    count: audience.length,
    recipients: audience.map((c) => ({
      id: c.id,
      name: `${c.first_name} ${c.last_name}`,
    })),
  };
});
