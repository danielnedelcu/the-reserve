/**
 * usePermissions — loads the current user's permission keys once per session
 * (via the get_my_permissions RPC) and exposes `can()` for gating UI.
 *
 * UI gating is convenience only: the database (RLS) and server routes are
 * the actual enforcement. Never rely on `can()` alone for security.
 *
 * Usage:
 *   const { can, load, ready } = usePermissions()
 *   await load()                      // e.g. in app.vue or after login
 *   v-if="can('appointments.create')" // in templates
 */
export function usePermissions() {
  const permissions = useState<string[] | null>("permissions", () => null);
  const supabase = useSupabaseClient();
  const user = useSupabaseUser();

  const ready = computed(() => permissions.value !== null);

  async function load(force = false) {
    if (!user.value) {
      permissions.value = null;
      return;
    }
    if (permissions.value !== null && !force) return;

    const { data, error } = await supabase.rpc("get_my_permissions");
    if (error) {
      // A failed load is NOT cached. Leaving the state null keeps `ready`
      // false and lets the next plain load() retry — which is what the
      // invite-acceptance race needs (the first load can run before the
      // session has settled). Caching [] here made that race permanent:
      // every can() denied for the rest of the session until a hard
      // reload. Bounded: every caller is a setup or route middleware that
      // awaits load() once, so a persistently failing RPC costs one retry
      // per navigation, never a loop, and can() denies in the meantime.
      console.error("Failed to load permissions:", error.message);
      permissions.value = null;
      return;
    }
    permissions.value = (data ?? []) as string[];
  }

  function can(key: string): boolean {
    return permissions.value?.includes(key) ?? false;
  }

  function canAny(...keys: string[]): boolean {
    return keys.some(can);
  }

  function reset() {
    permissions.value = null;
  }

  return {
    can,
    canAny,
    load,
    reset,
    ready,
    permissions: readonly(permissions),
  };
}
