import { requirePermission } from "../../../utils/requireUser";

/**
 * PATCH /api/invites/:id/revoke
 * Marks a pending invite as revoked. Caller must hold `staff.invite`
 * (also enforced by RLS on the underlying update).
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "staff.invite");
  const id = getRouterParam(event, "id");
  if (!id)
    throw createError({ statusCode: 400, statusMessage: "Missing invite id" });

  const { data, error } = await client
    .from("staff_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id, email")
    .maybeSingle();

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message });
  }
  if (!data) {
    throw createError({
      statusCode: 409,
      statusMessage: "Invite was already accepted, revoked, or does not exist",
    });
  }

  return { ok: true, email: data.email };
});
