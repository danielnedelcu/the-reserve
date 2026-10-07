/**
 * Route middleware: gates a page on a permission, or on EVERY permission
 * in a list, declared in its meta.
 *
 * Usage in a page:
 *   definePageMeta({ middleware: "can", permission: "staff.view" });
 *   definePageMeta({ middleware: "can", permission: ["financials.view_summary", "transactions.view"] });
 *
 * A list means all of them: /financials needs the summary permission AND
 * the ledger's read permission, because its figures come from the ledger
 * and a holder of one without the other would see zeros with no error
 * (docs/design/server-tables-design.md, build order step 3). The nav and
 * the command palette gate the same way.
 *
 * No `permission` in meta = no restriction (auth is still enforced
 * globally by the Supabase module's redirect guard).
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const required = to.meta.permission as string | string[] | undefined;
  if (!required) return;
  const keys = Array.isArray(required) ? required : [required];

  const { can, load } = usePermissions();
  await load();

  if (!keys.every((key) => can(key))) {
    return navigateTo("/");
  }
});
