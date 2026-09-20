/**
 * "Start a chat from a staff selection" — ONE definition, shared by the
 * new-message dialog and the right rail's directory
 * (docs/design/messaging-enhancements.md, reuse point 1).
 *
 * Owns the selection (a toggle set of staff ids), the optional group
 * name, the in-flight flag, and the one-vs-many rule: one id →
 * find_or_create_dm (canonical DMs, deduped by participant pair), more
 * → create_group_conversation. Both callers hand off to the same
 * `start()`; a rail-made group is therefore the same RPC call, with the
 * same arguments, as a dialog-made one — there is no second path to
 * drift. `start(ids)` with explicit ids serves "Chat with" from a menu,
 * which is a DM by construction.
 */
export function useStartConversation(opts: {
  /** After the conversation exists: close UI, refresh, navigate. */
  onStarted: (conversationId: string) => void | Promise<void>;
}) {
  const supabase = useSupabaseClient();
  const toast = useToast();

  const picked = useToggleSet<string>();
  const groupName = ref("");
  const creating = ref(false);

  async function start(ids: string[] = [...picked.set.value]) {
    const [firstId] = ids;
    if (!firstId || creating.value) return;
    creating.value = true;
    const { data: conversationId, error } =
      ids.length === 1
        ? await supabase.rpc("find_or_create_dm", { p_other_staff_id: firstId })
        : await supabase.rpc("create_group_conversation", {
            p_name: groupName.value,
            p_staff_ids: ids,
          });
    creating.value = false;
    if (error) {
      toast.error("Could not start conversation", error.message);
      return;
    }
    picked.clear();
    groupName.value = "";
    await opts.onStarted(conversationId as string);
  }

  return { picked, groupName, creating, start };
}
