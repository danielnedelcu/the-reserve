/**
 * useProspectQueue — how many prospects are waiting for a decision, live.
 *
 * QUEUE STATE, NOT PER-USER UNREAD. The number is "prospect_intake rows
 * in an undecided state for my organisation" — submitted or under_review.
 * It has no last-seen tracking on purpose: the nav dot means "someone
 * needs to act", and that stays true for everyone until a prospect is
 * approved OR rejected. (The bell notification is the per-person unread;
 * that one keeps its own read_at.)
 *
 * Gated twice, deliberately in that order:
 *   - the query runs under RLS, and prospect_intake's read policy requires
 *     forms.responses.view — so a provider without it gets zero rows, not
 *     a count they should not know;
 *   - can("forms.responses.view") short-circuits before querying at all,
 *     because a subscription that can never receive a row is a websocket
 *     held open for nothing.
 *
 * Live via postgres_changes on prospect_intake (published for realtime in
 * 20260912145534), re-counted on every (re)join and whenever the tab
 * becomes visible. The handler ignores the payload and RE-COUNTS: a
 * DELETE event under RLS carries only the primary key, and reasoning about
 * which status an UPDATE moved to would be a second copy of the
 * "undecided" predicate. One query owns the definition; realtime only says
 * "ask again".
 *
 * State lives in useState so the layout's single subscription feeds every
 * reader; start() is idempotent so a second caller does not open a second
 * channel.
 *
 * WHY THE RE-SYNCS EXIST — the 2026-09-12 incident, so nobody re-derives it.
 * A staff tab had been open since 14:44. The migration that added
 * prospect_intake to the realtime publication was pushed at 15:26. A test
 * submission at 15:32:24 lit the bell live but not this dot; a refresh at
 * 15:32:47 fixed it. Cause: Realtime ACCEPTS a postgres_changes
 * subscription on a table that is not (yet) in the publication and reports
 * SUBSCRIBED, then delivers nothing for it until the socket rejoins. The
 * server side was fully healthy the whole time (publication membership,
 * RLS, and realtime.apply_rls all passed for that session), which is why
 * it was hard to see. The same shape recurs after any dropped socket:
 * events during the gap are simply gone. Hence re-count on every join and
 * on the tab becoming visible — the count is then never older than the
 * connection. If a table is ever added to the publication again, expect
 * already-open tabs to catch up on their next reconnect or focus, not
 * instantly.
 */
export const UNDECIDED_STATUSES = ["submitted", "under_review"] as const;

export function useProspectQueue() {
  const supabase = useSupabaseClient();
  const { can } = usePermissions();

  const pendingCount = useState<number>("prospect-queue-pending", () => 0);
  const live = useState<boolean>("prospect-queue-live", () => false);
  let channel: ReturnType<typeof supabase.channel> | null = null;

  const allowed = computed(() => can("forms.responses.view"));

  async function recount() {
    if (!allowed.value) {
      pendingCount.value = 0;
      return;
    }
    const { count, error } = await supabase
      .from("prospect_intake")
      .select("id", { count: "exact", head: true })
      .in("status", [...UNDECIDED_STATUSES]);
    if (error) {
      console.error("[prospect queue] count failed:", error.message);
      return;
    }
    pendingCount.value = count ?? 0;
  }

  /** Tab woke up or came back: the socket may have died while it slept. */
  function onVisible() {
    if (document.visibilityState === "visible") void recount();
  }

  async function start() {
    if (channel || !allowed.value) return;
    void recount();
    // supabase.channel(topic) RETURNS AN EXISTING CHANNEL with that topic,
    // and a second subscribe() on a joined channel is ignored — so a stale
    // channel left by a previous instance (dev HMR did this) would keep
    // its old callbacks and this instance would think it was live. Remove
    // any namesake first, then create ours.
    for (const stale of supabase.getChannels()) {
      if (stale.topic !== "realtime:prospect-queue-live") continue;
      if (import.meta.dev) {
        console.warn(
          "[prospect queue] a channel named prospect-queue-live already existed " +
            `(state: ${stale.state}); removing it before subscribing. ` +
            "supabase.channel(topic) returns the existing channel and a second " +
            "subscribe() on it is silently ignored — a stale one would keep its " +
            "old callbacks while this instance believed it was live.",
        );
      }
      await supabase.removeChannel(stale);
    }
    document.addEventListener("visibilitychange", onVisible);
    channel = supabase
      .channel("prospect-queue-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prospect_intake" },
        () => void recount(),
      )
      .subscribe((status) => {
        // SUBSCRIBED is the only status under which "it will update live"
        // is true. Exposed so a verifier can read it rather than assume it.
        live.value = status === "SUBSCRIBED";
        // Every (re)join re-counts. A socket that dropped and came back has
        // missed whatever happened in between (verified 2026-09-12: the
        // subscribe callback fires SUBSCRIBED again after a reconnect), and
        // a tab that was open before the table joined the publication
        // received nothing until its socket rejoined. Both look exactly like
        // "the dot is not live". Re-syncing on join — plus on the tab
        // becoming visible, for sockets that died during sleep — means the
        // count is never older than the connection.
        if (live.value) void recount();
      });
  }

  function stop() {
    document.removeEventListener("visibilitychange", onVisible);
    if (channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
    live.value = false;
  }

  return { pendingCount: readonly(pendingCount), live: readonly(live), recount, start, stop };
}
