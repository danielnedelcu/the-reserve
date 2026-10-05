/**
 * Route middleware: gates a page on a permission declared in its meta.
 *
 * Usage in a page:
 *   definePageMeta({ middleware: "can", permission: "staff.view" });
 *
 * No `permission` in meta = no restriction (auth is still enforced
 * globally by the Supabase module's redirect guard).
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const permission = to.meta.permission as string | undefined;
  if (!permission) return;

  const { can, load } = usePermissions();
  await load();

  if (!can(permission)) {
    return navigateTo("/");
  }
});
