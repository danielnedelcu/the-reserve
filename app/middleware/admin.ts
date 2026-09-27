/**
 * Route middleware: gates a page on the admin / super_admin role.
 *
 * Usage in a page:
 *   definePageMeta({ middleware: "admin" });
 *
 * The role-based counterpart of the `can` middleware, for the one
 * surface the design gates by role rather than by permission key
 * (marketing campaigns). Non-admins are sent home, the way `can` does it.
 */
export default defineNuxtRouteMiddleware(async () => {
  const { isAdmin, load } = useIsAdmin();
  await load();
  if (!isAdmin.value) {
    return navigateTo("/");
  }
});
