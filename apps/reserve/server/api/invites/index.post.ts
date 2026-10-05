import { requirePermission } from "../../utils/requireUser";
import { sendMail } from "../../utils/mailer";
import { staffInviteEmail } from "../../utils/emailTemplates";

/**
 * POST /api/invites
 * Body: { email: string, roleNames: string[], displayName?, title?, locationIds?: string[] }
 * Creates a staff invite and emails the invitation link.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "staff.invite");
  const body = await readBody<{
    email?: string;
    roleNames?: string[];
    displayName?: string;
    title?: string;
    locationIds?: string[];
  }>(event);

  if (!body?.email || !body.roleNames?.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "email and roleNames are required",
    });
  }

  const { data: roles, error: rolesError } = await client
    .from("roles")
    .select("id, name")
    .in("name", body.roleNames);

  if (rolesError || !roles?.length || roles.length !== body.roleNames.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "One or more roles not found",
    });
  }

  const { data: staffId } = await client.rpc("current_staff_id");
  const { data: orgId } = await client.rpc("current_org_id");

  const { data: invite, error } = await client
    .from("staff_invites")
    .insert({
      organization_id: orgId ?? "",
      email: body.email.toLowerCase().trim(),
      display_name: body.displayName ?? null,
      title: body.title ?? null,
      role_ids: roles.map((r) => r.id),
      location_ids: body.locationIds ?? [],
      invited_by: staffId ?? "",
    })
    .select("id, token, email, expires_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw createError({
        statusCode: 409,
        statusMessage: "A pending invite already exists for this email",
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  const inviteUrl = `${getRequestURL(event).origin}/invite/${invite.token}`;

  // Email the invitation. Best-effort: the invite exists either way, and the
  // pending-invites list gives admins a copyable link as fallback in dev.
  const { data: inviter } = await client
    .from("staff")
    .select("display_name")
    .eq("id", staffId ?? "")
    .single();

  const emailContent = staffInviteEmail({
    inviteUrl,
    invitedByName: inviter?.display_name ?? "The Reserve",
    title: body.title,
  });
  const sent = await sendMail({ to: invite.email, ...emailContent });

  return {
    id: invite.id,
    email: invite.email,
    expiresAt: invite.expires_at,
    emailSent: sent,
    // Dev convenience only — remove once domain-verified email is confirmed:
    ...(import.meta.dev ? { inviteUrl } : {}),
  };
});
