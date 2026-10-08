import { localDateKey } from "./zone";

/**
 * The bridge to date pickers (v-calendar) that speak in BROWSER Dates.
 * A picker shows a calendar of days and hands back a Date at the
 * browser's local midnight of the day picked; what the app wants is the
 * calendar day as a key. This is the one place the browser's own zone
 * is read, and only to recover the day a Date already denotes — never to
 * place an instant on a day (that is localDateKey in the location's zone).
 */

/** The Date a picker should show for a key: noon in the browser's zone, which no DST shift moves off the day. */
export function pickerDate(key: string): Date {
  return new Date(`${key}T12:00:00`);
}

/** The key a picked browser Date denotes. pickedKey(pickerDate(k)) === k in every zone. */
export function pickedKey(picked: Date): string {
  return localDateKey(picked, Intl.DateTimeFormat().resolvedOptions().timeZone);
}
