/**
 * useIsAdmin — whether the signed-in staff member holds the admin or
 * super_admin role, via the is_admin() RPC, loaded once per session.
 *
 * The one role-based gate in the app (marketing campaigns; see
 * docs/design/marketing-campaigns-design.md). Everything else gates on
 * permission keys through usePermissions; this is kept separate so that
 * composable's contract and tests stay untouched.
 *
 * UI gating is convenience only: RLS (is_admin() in the campaign
 * policies) and the routes are the enforcement.
 */
export function useIsAdmin() {
  const state = useState<boolean | null>("is-admin", () => null);
  const supabase = useSupabaseClient();
  const user = useSupabaseUser();

  const ready = computed(() => state.value !== null);
  const isAdmin = computed(() => state.value === true);

  async function load(force = false) {
    if (!user.value) {
      state.value = null;
      return;
    }
    if (state.value !== null && !force) return;
    const { data, error } = await supabase.rpc("is_admin");
    if (error) {
      // Same discipline as usePermissions: a failed load is not cached,
      // so the next load() retries and isAdmin denies in the meantime.
      console.error("Failed to load admin state:", error.message);
      state.value = null;
      return;
    }
    state.value = data === true;
  }

  function reset() {
    state.value = null;
  }

  return { isAdmin, ready, load, reset };
}
