/**
 * The timezone the schedule is drawn in: the location's, never the
 * viewer's. Read once per app (one useAsyncData key), from the same row
 * the slots and booking routes use — the organisation's first location
 * (they take `.limit(1)`; this orders by created_at then id, the order
 * the time-off bell uses, so with more than one location the choice is
 * at least deterministic here). Pages `await` it so the zone is known
 * before anything is positioned or labelled.
 *
 * "UTC" only if the organisation has no location at all, in which case
 * the routes refuse to compute slots anyway ("No location configured").
 */
export function useLocationTimezone() {
  const supabase = useSupabaseClient();
  return useAsyncData(
    "location-timezone",
    async () => {
      const { data, error } = await supabase
        .from("locations")
        .select("timezone")
        .order("created_at")
        .order("id")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.timezone ?? "UTC";
    },
    { default: () => "UTC" },
  );
}
