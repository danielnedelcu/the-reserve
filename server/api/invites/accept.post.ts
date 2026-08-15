import { serverSupabaseServiceRole } from "#supabase/server";

/**
 * POST /api/invites/accept
 * Body: { token, displayName, password, title? }
 * Public (pre-auth). Creates the auth user, then runs accept_staff_invite()
 * which atomically creates the staff row, roles, locations, and audit entry.
 * If the database step fails, the just-created auth user is deleted so the
 * invite can be retried cleanly.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    token?: string;
    displayName?: string;
    title?: string;
    password?: string;
  }>(event);

  if (!body?.token || !body.displayName || !body.password) {
    throw createError({
      statusCode: 400,
      statusMessage: "token, displayName and password are required",
    });
  }
  if (body.password.length < 8) {
    throw createError({
      statusCode: 400,
      statusMessage: "Password must be at least 8 characters",
    });
  }

  const admin = serverSupabaseServiceRole(event);

  // Validate the invite and get its email (the function will re-validate atomically)
  const { data: invite } = await admin
    .from("staff_invites")
    .select("email, accepted_at, revoked_at, expires_at")
    .eq("token", body.token)
    .maybeSingle();

  if (
    !invite
    || invite.accepted_at
    || invite.revoked_at
    || new Date(invite.expires_at) < new Date()
  ) {
    throw createError({
      statusCode: 410,
      statusMessage: "Invite is invalid, expired, or already used",
    });
  }

  // 1. Create the auth user (email pre-confirmed: the invite email IS the verification)
  const { data: created, error: createError_ }
    = await admin.auth.admin.createUser({
      email: invite.email,
      password: body.password,
      email_confirm: true,
    });

  if (createError_ || !created?.user) {
    const msg = createError_?.message?.includes("already been registered")
      ? "An account with this email already exists"
      : (createError_?.message ?? "Could not create account");
    throw createError({ statusCode: 409, statusMessage: msg });
  }

  // 2. Atomic acceptance: staff row + roles + locations + audit entry
  const { error: acceptError } = await admin.rpc("accept_staff_invite", {
    invite_token: body.token,
    new_user_id: created.user.id,
    final_display_name: body.displayName,
    final_title: body.title ?? null,
  });

  if (acceptError) {
    // Roll back the orphaned auth user so the invite remains usable
    await admin.auth.admin.deleteUser(created.user.id);
    throw createError({ statusCode: 500, statusMessage: acceptError.message });
  }

  return { ok: true, email: invite.email };
});
