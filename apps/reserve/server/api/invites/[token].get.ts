import { serverSupabaseServiceRole } from "#supabase/server";

/**
 * GET /api/invites/:token
 * Public (pre-auth) — returns the minimal details the acceptance page needs.
 * Uses the service role because RLS intentionally has no token-read policy;
 * exposes only safe fields, never the full invite row.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token");
  if (!token)
    throw createError({ statusCode: 400, statusMessage: "Missing token" });

  const admin = serverSupabaseServiceRole(event);

  const { data: invite } = await admin
    .from("staff_invites")
    .select(
      "email, display_name, title, expires_at, accepted_at, revoked_at, organization_id",
    )
    .eq("token", token)
    .maybeSingle();

  if (!invite)
    throw createError({ statusCode: 404, statusMessage: "Invite not found" });
  if (invite.accepted_at)
    throw createError({
      statusCode: 410,
      statusMessage: "Invite already used",
    });
  if (invite.revoked_at)
    throw createError({ statusCode: 410, statusMessage: "Invite was revoked" });
  if (new Date(invite.expires_at) < new Date()) {
    throw createError({ statusCode: 410, statusMessage: "Invite has expired" });
  }

  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", invite.organization_id)
    .single();

  return {
    email: invite.email,
    displayName: invite.display_name,
    title: invite.title,
    organizationName: org?.name ?? "",
  };
});
