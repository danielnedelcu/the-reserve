/**
 * useLeadQueue — how many leads nobody has picked up yet, live.
 *
 * The prospect queue's twin (useProspectQueue), with one definition
 * swapped: "needing attention" here means status = 'new'. Contacted,
 * qualified, lost and converted have all been touched by someone, so the
 * dot clears the moment every lead has been at least contacted. QUEUE
 * STATE, NOT PER-USER UNREAD — shared across staff, no last-seen tracking;
 * the bell notification is the per-person unread.
 *
 * Gated on leads.view twice: RLS returns zero rows to anyone without it,
 * and can() short-circuits before a query or a subscription exists.
 *
 * Live via postgres_changes on `leads` (published in 20260919013317).
 * The handler ignores the payload and RE-COUNTS, and the count is also
 * re-run on every channel (re)join and whenever the tab becomes visible.
 * Those re-syncs are not optional — read the incident in
 * useProspectQueue's docblock before touching them: a subscription made
 * before a table is in the publication reports SUBSCRIBED and delivers
 * nothing until the socket rejoins, and any dropped socket loses the
 * events in the gap. Re-counting on join and on focus is what makes the
 * number never older than the connection.
 */
export const ATTENTION_STATUSES = ["new"] as const;

export function useLeadQueue() {
  const supabase = useSupabaseClient();
  const { can } = usePermissions();

  const pendingCount = useState<number>("lead-queue-pending", () => 0);
  const live = useState<boolean>("lead-queue-live", () => false);
  let channel: ReturnType<typeof supabase.channel> | null = null;

  const allowed = computed(() => can("leads.view"));

  async function recount() {
    if (!allowed.value) {
      pendingCount.value = 0;
      return;
    }
    const { count, error } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .in("status", [...ATTENTION_STATUSES]);
    if (error) {
      console.error("[lead queue] count failed:", error.message);
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
    // supabase.channel(topic) returns an EXISTING channel with that topic
    // and a second subscribe() on it is silently ignored — a stale one
    // (dev HMR) would keep its old callbacks while this instance believed
    // it was live. Remove any namesake first.
    for (const stale of supabase.getChannels()) {
      if (stale.topic !== "realtime:lead-queue-live") continue;
      if (import.meta.dev) {
        console.warn(
          `[lead queue] a channel named lead-queue-live already existed (state: ${stale.state}); ` +
            "removing it before subscribing — see useProspectQueue for why.",
        );
      }
      await supabase.removeChannel(stale);
    }
    document.addEventListener("visibilitychange", onVisible);
    channel = supabase
      .channel("lead-queue-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        () => void recount(),
      )
      .subscribe((status) => {
        // SUBSCRIBED is the only status under which "it will update live"
        // is true; exposed so a verifier reads it rather than assumes it.
        live.value = status === "SUBSCRIBED";
        // Every (re)join re-counts — the count is never older than the
        // connection (useProspectQueue explains the two failures this closes).
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
