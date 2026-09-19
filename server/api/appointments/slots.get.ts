import { requirePermission } from "../../utils/requireUser";
import { localToUtc, dayOfWeek } from "../../utils/timezone";

/**
 * GET /api/appointments/slots?serviceId=&staffId=&date=YYYY-MM-DD
 *
 * Implements the contract's slot formula:
 *   availability rules − time-off/sick/break exceptions + extra shifts
 *   − existing staff bookings ∩ a free room of the required type
 *
 * Returns candidate client-facing start times (15-min grid) with the room
 * that would be assigned. All reads run on the caller's RLS client.
 */

interface Interval {
  start: number;
  end: number;
} // epoch ms, [start, end)

function subtract(intervals: Interval[], cuts: Interval[]): Interval[] {
  let result = intervals;
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const iv of result) {
      if (cut.end <= iv.start || cut.start >= iv.end) {
        next.push(iv);
        continue;
      }
      if (cut.start > iv.start) next.push({ start: iv.start, end: cut.start });
      if (cut.end < iv.end) next.push({ start: cut.end, end: iv.end });
    }
    result = next;
  }
  return result;
}

export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "appointments.create");
  const query = getQuery(event);
  const serviceId = String(query.serviceId ?? "");
  const staffId = String(query.staffId ?? "");
  const date = String(query.date ?? ""); // YYYY-MM-DD, local to the location

  if (!serviceId || !staffId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw createError({
      statusCode: 400,
      statusMessage: "serviceId, staffId and date are required",
    });
  }

  // --- Catalog: service, per-staff override, qualification, room type -------
  const { data: service } = await client
    .from("services")
    .select(
      "id, duration_minutes, buffer_before_min, buffer_after_min, active, service_resource_requirements(resource_type_id)",
    )
    .eq("id", serviceId)
    .maybeSingle();
  if (!service || !service.active) {
    throw createError({
      statusCode: 404,
      statusMessage: "Service not found or inactive",
    });
  }

  const { data: qualification } = await client
    .from("service_staff")
    .select("duration_override_min")
    .eq("service_id", serviceId)
    .eq("staff_id", staffId)
    .maybeSingle();
  if (!qualification) {
    throw createError({
      statusCode: 422,
      statusMessage: "Staff member is not qualified for this service",
    });
  }

  const duration =
    qualification.duration_override_min ?? service.duration_minutes;
  const bufferBefore = service.buffer_before_min;
  const bufferAfter = service.buffer_after_min;
  const requiredTypes = service.service_resource_requirements.map(
    (r: { resource_type_id: string }) => r.resource_type_id,
  );

  // --- Location + timezone ---------------------------------------------------
  const { data: location } = await client
    .from("locations")
    .select("id, timezone")
    .limit(1)
    .maybeSingle();
  if (!location)
    throw createError({
      statusCode: 500,
      statusMessage: "No location configured",
    });
  const tz = location.timezone;
  // SCAR — the two-timezone seam (inventory, 2026-09-19). Slots are
  // computed in the LOCATION'S timezone here; the schedule grid that
  // displays the booked result positions cards by the VIEWER'S browser
  // clock (app/pages/schedule.vue, blockStyle / fetchRange). Same zone
  // today, so they agree; see the note there and docs/TODO.md. This side
  // is the correct one — the fix, when made, moves the grid onto the
  // location's zone, not this route onto the browser's.

  const dayStart = localToUtc(date, "00:00", tz).getTime();
  const dayEnd = dayStart + 24 * 3_600_000;
  const dow = dayOfWeek(date);

  // --- Working windows: rules ± exceptions ----------------------------------
  const { data: rules } = await client
    .from("availability_rules")
    .select("start_time, end_time, valid_from, valid_until")
    .eq("staff_id", staffId)
    .eq("day_of_week", dow);

  let windows: Interval[] = (rules ?? [])
    .filter(
      (r) => r.valid_from <= date && (!r.valid_until || r.valid_until >= date),
    )
    .map((r) => ({
      start: localToUtc(date, r.start_time.slice(0, 5), tz).getTime(),
      end: localToUtc(date, r.end_time.slice(0, 5), tz).getTime(),
    }));

  const { data: exceptions } = await client
    .from("availability_exceptions")
    .select("starts_at, ends_at, kind")
    .eq("staff_id", staffId)
    .eq("status", "approved")
    .lt("starts_at", new Date(dayEnd).toISOString())
    .gt("ends_at", new Date(dayStart).toISOString());

  for (const ex of exceptions ?? []) {
    const iv = { start: Date.parse(ex.starts_at), end: Date.parse(ex.ends_at) };
    if (ex.kind === "extra_shift") windows.push(iv);
    else windows = subtract(windows, [iv]);
  }

  if (!windows.length) return { slots: [] };

  // --- Staff's existing bookings ---------------------------------------------
  const { data: staffAppointments } = await client
    .from("appointments")
    .select("blocked_from, blocked_until")
    .eq("staff_id", staffId)
    .not("status", "in", "(cancelled,no_show)")
    .lt("blocked_from", new Date(dayEnd).toISOString())
    .gt("blocked_until", new Date(dayStart).toISOString());

  const staffBusy: Interval[] = (staffAppointments ?? []).map((a) => ({
    start: Date.parse(a.blocked_from),
    end: Date.parse(a.blocked_until),
  }));

  // --- Rooms of the required type + their bookings ----------------------------
  let rooms: { id: string; name: string }[] = [];
  const roomBusy = new Map<string, Interval[]>();

  if (requiredTypes.length) {
    const { data: roomRows } = await client
      .from("resources")
      .select("id, name")
      .eq("location_id", location.id)
      .eq("active", true)
      .in("resource_type_id", requiredTypes);
    rooms = roomRows ?? [];
    if (!rooms.length) return { slots: [] };

    const { data: roomAppointments } = await client
      .from("appointments")
      .select("resource_id, blocked_from, blocked_until")
      .in(
        "resource_id",
        rooms.map((r) => r.id),
      )
      .not("status", "in", "(cancelled,no_show)")
      .lt("blocked_from", new Date(dayEnd).toISOString())
      .gt("blocked_until", new Date(dayStart).toISOString());

    for (const appt of roomAppointments ?? []) {
      if (!appt.resource_id) continue;
      const list = roomBusy.get(appt.resource_id) ?? [];
      list.push({
        start: Date.parse(appt.blocked_from),
        end: Date.parse(appt.blocked_until),
      });
      roomBusy.set(appt.resource_id, list);
    }
  }

  // --- Generate candidates on a 15-min grid ----------------------------------
  const STEP = 15 * 60_000;
  const blockedLen = (bufferBefore + duration + bufferAfter) * 60_000;
  const now = Date.now();
  const overlaps = (a: Interval, list: Interval[]) =>
    list.some((b) => a.start < b.end && b.start < a.end);

  const slots: {
    startsAt: string;
    roomId: string | null;
    roomName: string | null;
  }[] = [];

  for (const window of windows) {
    // client-facing start must allow the buffer before it inside the window
    let cursor =
      Math.ceil((window.start + bufferBefore * 60_000) / STEP) * STEP;
    for (
      ;
      cursor + (duration + bufferAfter) * 60_000 <= window.end;
      cursor += STEP
    ) {
      const blocked: Interval = {
        start: cursor - bufferBefore * 60_000,
        end: cursor - bufferBefore * 60_000 + blockedLen,
      };
      if (blocked.start < window.start) continue;
      if (cursor <= now) continue; // no booking in the past
      if (overlaps(blocked, staffBusy)) continue;

      let room: { id: string; name: string } | null = null;
      if (requiredTypes.length) {
        room =
          rooms.find((r) => !overlaps(blocked, roomBusy.get(r.id) ?? [])) ??
          null;
        if (!room) continue;
      }

      slots.push({
        startsAt: new Date(cursor).toISOString(),
        roomId: room?.id ?? null,
        roomName: room?.name ?? null,
      });
    }
  }

  return { slots, duration, bufferBefore, bufferAfter };
});
