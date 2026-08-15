export function useAuth() {
  const supabase = useSupabaseClient();

  async function signOut() {
    const toast = useToast();
    const { reset } = usePermissions();
    const { error } = await supabase.auth.signOut();
    reset(); // clear cached permission set — must happen no matter what
    if (error) {
      toast.error("Could not log out", error.message);
      return;
    }
    // hard navigation: guarantees all in-memory state is gone
    await navigateTo("/login");
  }

  return { signOut };
}
