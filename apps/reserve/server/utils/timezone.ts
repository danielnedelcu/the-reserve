/**
 * Timezone helpers for slot computation — now the SHARED module
 * (shared/time/zone.ts), re-exported here so the slots route and the
 * communication jobs keep their import. The schedule page uses the same
 * module, which is the whole point: the route's instant and the grid's
 * pixel come from one conversion in one zone.
 */
export {
  tzOffsetMs,
  localToUtc,
  dayOfWeek,
  localDateKey,
} from "~~/shared/time/zone";
