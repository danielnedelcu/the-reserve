/**
 * Time labels for appointment cards and the schedule's dialogs.
 *
 * Both format in the VIEWER'S browser clock, on purpose and for now: the
 * schedule grid positions cards by the same clock (see the two-timezone
 * seam scar in app/pages/schedule.vue). Moving the grid onto the location's
 * timezone is a deliberate fix on the board, and these move with it.
 */

/** "9:00 AM" */
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "9a", "9:30a", "1p" — the compact form for week and month chips. */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return `${h}${m ? ":" + String(m).padStart(2, "0") : ""}${d.getHours() < 12 ? "a" : "p"}`;
}
