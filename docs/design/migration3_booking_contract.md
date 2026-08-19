# Scheduling Core — Booking Flow Contract

What migration 3's schema guarantees, what the application layer must do, and
the rules the upcoming UI work builds against.

## What the database guarantees (you don't have to code these)

1. **No double-booking.** The exclusion constraints make overlapping
   non-cancelled appointments for the same staff member or the same room
   impossible — including under concurrent inserts from different users. A
   losing insert fails with a Postgres exclusion violation (SQLSTATE 23P01).
2. **History integrity.** Appointments are never deleted (no delete policy);
   line items snapshot name/price/duration so catalog edits can't rewrite
   booked history; `blocked` windows must contain the client-facing window
   (check constraint).
3. **No-show counting.** Flipping an appointment to/from `no_show`
   automatically maintains `clients.no_show_count`.
4. **Access control.** All the own/any scopes and the health-note gate are
   enforced by RLS regardless of any UI or API bug.

## What the application layer must implement

### Slot computation (read-side, can run client-side or in a server route)
For a requested service + staff member + date:

```
candidate windows =
    availability_rules for that staff/location/day-of-week
      (where valid_from <= date <= coalesce(valid_until, 'infinity'))
  − approved availability_exceptions of kind time_off/sick/break
  + approved exceptions of kind extra_shift
  − existing appointments' [blocked_from, blocked_until) for that staff
  ∩ free rooms of the service's required resource_type
      (a room is free if no appointment blocks it in the window)
  ∩ location business hours (optional, if you enforce them)
```

Slot length = buffer_before + duration + buffer_after (per-staff duration
override from service_staff applies if present). Present the client-facing
start times; store both windows.

### Booking (write-side — SERVER ROUTE, not direct client insert)
Although RLS permits direct inserts, bookings should go through
`POST /api/appointments` because the flow is multi-step and needs to be
atomic-ish and auditable:

1. Re-derive the blocked window server-side from the catalog (never trust
   client-computed prices/durations).
2. Verify the staff member is qualified (`service_staff`) and the client's
   intake requirement is satisfied if `services.requires_intake`.
3. Pick a concrete free room of the required type.
4. Insert appointment + appointment_services rows (snapshots from catalog,
   with per-staff overrides applied).
5. If the insert fails with the exclusion violation (23P01), surface
   "That slot was just taken" and refresh availability — this is the
   expected concurrency path, not an error to log loudly.
6. Write an audit_log row (`appointment.booked`).

### Rescheduling / cancelling
- Reschedule = UPDATE the same row's windows (history preserved via audit
  trail), not cancel + rebook — unless cancellation-fee logic later needs
  the distinction.
- Cancel / no-show = status transition + cancelled_at/reason/by. The
  exclusion constraints ignore cancelled/no_show rows, so the slot frees
  itself automatically.

### Timezones
- All timestamps are `timestamptz` (UTC).
- `availability_rules.start_time/end_time` are LOCAL times for the
  location; convert using the location's timezone when computing slots for
  a concrete date. This is what makes "Tuesdays 9–5" survive DST.

### Health-note access auditing
RLS gates who CAN read health notes, but SELECTs can't fire triggers — so
the requirement "health-note access is audit-logged" must be implemented at
the app layer: read health notes through a server route (or RPC) that writes
an `audit_log` row (`health_note.viewed`) before returning them. Do not
query `client_notes` with kind='health' directly from the browser once that
route exists.

### Walk-ins
An appointment with starts_at ≈ now() and status 'checked_in'. No separate
path.

## Suggested UI increments (in order)
1. `/clients` — list + create/edit + profile with notes (health notes
   gated; provider can add preference/health notes).
2. Availability editor — weekly rules grid on a staff profile
   (own for providers, any for admins) + time-off request/approve list.
3. `/schedule` — the calendar (day view first: columns per staff, blocks
   per appointment) + the booking dialog implementing the slot flow above.
   This is the largest UI piece of the project.

## Known deferrals (intentional, tracked in requirements doc)
- Recurring appointments (add recurrence_group_id later; materialize rows).
- Waitlists, cancellation-fee policy engine (needs POS/Stripe first).
- Multi-service appointments spanning staff/room handoffs (schema supports
  line items; the booking UI can start single-service).
