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
