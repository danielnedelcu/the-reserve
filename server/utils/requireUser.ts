import type { H3Event } from "h3";
import { serverSupabaseUser, serverSupabaseClient } from "#supabase/server";

/**
 * Guards a server route: resolves the authenticated user or throws 401.
 * Returns both the user and an RLS-scoped Supabase client acting AS that
 * user — queries through it are subject to the same policies as the browser.
 */
export async function requireUser(event: H3Event) {
  const user = await serverSupabaseUser(event);
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: "Not signed in" });
  }
  const client = await serverSupabaseClient(event);
  return { user, client };
}

/**
 * The auth user id, resolved once and correctly.
 *
 * serverSupabaseUser() returns DECODED JWT CLAIMS typed as a Supabase
 * User. The id lives in the `sub` claim; `user.id` typechecks and is
 * undefined at runtime — which is why audit_log.actor_user_id was silently
 * NULL across health_note.viewed, appointment.booked and pos.checkout. A
 * NULL there is not an error anywhere: the insert succeeds, the route
 * returns 200, and nothing notices until someone reads the audit trail.
 *
 * Both are accepted so a library change that starts populating `id`
 * cannot reintroduce it. Every route writing an actor id should call this
 * rather than reaching into the user object.
 */
export function actorUserId(user: unknown): string | null {
  const claims = user as { sub?: string; id?: string } | null | undefined;
  return claims?.sub ?? claims?.id ?? null;
}

/**
 * Additionally asserts a permission via the database's has_permission().
 * Throws 403 if the caller lacks it.
 */
export async function requirePermission(event: H3Event, perm: string) {
  const ctx = await requireUser(event);
  const { data, error } = await ctx.client.rpc("has_permission", { perm });
  if (error || data !== true) {
    throw createError({
      statusCode: 403,
      statusMessage: `Missing permission: ${perm}`,
    });
  }
  return ctx;
}
