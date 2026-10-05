import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~~/shared/types/database";

/**
 * Fan a notification out to every staff member holding a permission.
 *
 * Permission-based rather than role-based on purpose: "who should hear
 * about a Stripe dispute" is "whoever can issue refunds", and "who should
 * collect an uncollected fee" is "whoever rings up checkouts" — both are
 * questions the permission matrix already answers, so a role change never
 * has to be mirrored here. Lifted out of the Stripe webhook in phase 4 of
 * client communications, when the cancel route became a second caller.
 *
 * Best-effort under the service role: a lookup or insert failure is
 * logged and swallowed, because no caller's primary operation (a webhook
 * ack, a cancellation) should fail for want of a bell icon.
 */
export async function notifyStaffWithPermission(
  admin: SupabaseClient<Database>,
  permissionKey: string,
  notification: { kind: string; title: string; body: string; link?: string },
  log = "[notifyStaff]",
): Promise<void> {
  const { data: holders, error } = await admin
    .from("staff_roles")
    .select("staff_id, roles!inner(role_permissions!inner(permission_key))")
    .eq("roles.role_permissions.permission_key", permissionKey);
  if (error) {
    console.error(`${log} lookup failed:`, error);
    return;
  }
  const ids = [...new Set((holders ?? []).map((row) => row.staff_id))];
  if (!ids.length) return;
  const { error: insertError } = await admin.from("notifications").insert(
    ids.map((staffId) => ({
      staff_id: staffId,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      link: notification.link ?? null,
    })),
  );
  if (insertError) {
    console.error(`${log} insert failed:`, insertError);
  }
}
