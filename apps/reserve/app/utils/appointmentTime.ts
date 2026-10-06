import {
  timeLabel as zonedTimeLabel,
  shortTime as zonedShortTime,
  minutesIntoDay as zonedMinutesIntoDay,
} from "~~/shared/time/zone";

/**
 * Time labels and grid placement for appointment cards and the
 * schedule's dialogs — in the LOCATION's timezone, which every caller
 * passes (the page reads it once through useLocationTimezone). The zone
 * is a required parameter on purpose: there is no way to call these
 * with the browser's clock, so the seam that drew a 10:00 AM New York
 * appointment at 7:00 AM for a Los Angeles viewer cannot come back
 * through here. One shared module does the conversion for the slots
 * route too (shared/time/zone.ts).
 */

/** "9:00 AM" */
export function timeLabel(iso: string, timeZone: string): string {
  return zonedTimeLabel(iso, timeZone);
}

/** "9a", "9:30a", "1p" — the compact form for week and month chips. */
export function shortTime(iso: string, timeZone: string): string {
  return zonedShortTime(iso, timeZone);
}

/** Minutes since the location's midnight — the card's vertical position. */
export function minutesIntoDay(iso: string, timeZone: string): number {
  return zonedMinutesIntoDay(iso, timeZone);
}
