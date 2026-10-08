import { localDateKey, timeLabel } from "./zone";
import { keyLabel, monthLabel, type KeyLabelOptions } from "./period";

/**
 * The formatters every page uses for BUSINESS time: an appointment, a
 * sale, a message the business sent, a lead received, time off. Each
 * takes the location's zone as a REQUIRED argument — no default, so a
 * call without one is a type error rather than a silent fall back to
 * the browser's clock — turns the instant into a day key in that zone
 * (localDateKey) and words from the key (keyLabel), and never makes its
 * own Intl date call. The pages read the zone once through
 * useLocationTimezone(). tests/guards/browserClock.test.ts fails the
 * suite on any browser-clock formatting in app/, so nothing bypasses this.
 *
 * Date-only values (a date of birth, a `date` column) do not come here:
 * they are keys already and go straight to keyLabel.
 */

/** "Oct 7, 2026" by default; `{ month: "long" }` → "October 7, 2026"; `{ year: false }` → "Oct 7". */
export function dateLabel(at: Date | string, timeZone: string, opts: KeyLabelOptions = {}): string {
  return keyLabel(localDateKey(at, timeZone), { year: true, ...opts });
}

/** "Oct 7, 9:00 AM"; with `{ year: true }` → "Oct 7, 2026, 9:00 AM"; with a weekday → "Wed, Oct 7, 9:00 AM". */
export function dateTimeLabel(at: Date | string, timeZone: string, opts: KeyLabelOptions = {}): string {
  return `${keyLabel(localDateKey(at, timeZone), opts)}, ${timeLabel(at, timeZone)}`;
}

/** "Wed, Oct 7, 9:00 AM → Thu, Oct 8, 5:00 PM" — a time-off window, both ends in the zone. */
export function rangeLabel(from: Date | string, to: Date | string, timeZone: string, opts: KeyLabelOptions = {}): string {
  return `${dateTimeLabel(from, timeZone, opts)} → ${dateTimeLabel(to, timeZone, opts)}`;
}

/** "October" — the month an instant falls in, in the zone. */
export function monthName(at: Date | string, timeZone: string): string {
  return monthLabel(localDateKey(at, timeZone));
}

export { timeLabel, localDateKey };
