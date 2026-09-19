# Scheduler visual redesign — design

Status: DESIGN, not built. Step zero (the behaviour inventory) DONE
2026-09-19 against the code; this doc was corrected the same day to
match what the inventory found — three things the first draft assumed
the code had, it does not (see "Parked features" and the notes marked
[INVENTORY]). A PRESENTATION redesign over UNTOUCHED behavior.
Design-room session 2026-09-19. Owner-independent.

## What this is, and the one rule that governs it

The scheduler works — availability math (in the slots route), conflict
prevention, booking, the date-handling scars are all correct and
hard-won. It looks lacking. This re-skins the PRESENTATION over that behavior without
changing it. The governing rule, above every detail below:

The look changes; the behavior and the per-appointment styling
SEMANTICS do not. If a change touches availability calculation,
conflict detection, the booking mutation, realtime, date handling, or
what an appointment's colour/status MEANS, it is out of scope — that is
a feature or a regression, not a re-skin.

The reason image 4 is safe as the reference: it is the DAILY view's
existing structure — providers as columns, time down the left,
appointments in each provider's lane — made beautiful. We already render
that shape; this restyles the columns we already draw, it does not
restructure the day. What image 4 shows that we do NOT draw — hatched
block/lunch cards, avatars, a between-times popover for overlaps — is
either pure chrome (avatars: fine) or a feature (the rest: parked, below).
The reskin restyles what exists and adds nothing that needs a data source
the grid does not read today.

## Aesthetic direction

- **Daily view → image 4** (Schedule-daily.webp): provider columns with
  avatars across the top, a time axis down the left, appointment cards in
  each provider's lane, a "now" line, the clean spacing and typography of
  that reference. NOT the hatched block/lunch cards: [INVENTORY] the grid
  reads no availability or exception data (schedule.vue touches neither
  availability_rules nor availability_exceptions), so there is nothing to
  hatch. Drawing it would be a feature — parked below.
- **Appointment detail panel → image 3's STYLING** (the slide-in panel
  look — clean card list, spacing, typography). CONTENT AND ACTIONS
  UNCHANGED: the panel shows and does exactly what the current appointment
  detail already shows and does; only its visual treatment adopts image 3. Image 3 is a POS/order panel — we borrow its LOOK, never its
  appointments-plus-products-plus-order content model (scheduling and
  checkout stay separate pages).
- **Card styling** (client · service · time) propagates to WHEREVER cards
  appear, including weekly and monthly, so the scheduler feels consistent
  across views even though only the daily GRID is redesigned.

## Scope

IN:

- The daily view's grid: provider-column layout, avatars, time axis,
  now-line — image 4. (No hatched blocks: no data source. See Parked.)
- Appointment cards everywhere: the image-4 card look (client, service,
  time), the same card style shared across daily / weekly / monthly.
- The appointment detail panel: image 3's aesthetic, existing content.

OUT (explicitly, so nobody drifts):

- Weekly and monthly GRID structure — unchanged. They keep their current
  layout; only their CARDS inherit the new styling. Image 4 is a daily
  aesthetic and does not translate to week/month grids; redesigning those
  would be inventing new layouts, a separate project.
- Page chrome — the date header, the view switcher (day/week/month), the
  New-appointment / Block-time buttons: unchanged. Just the calendar
  surface and the panel.
- Any NEW behaviour the references imply: drag-to-reschedule,
  resize-to-change-duration, checkout-in-the-panel, calendar sync,
  action-icon clusters on cards, a redesigned month/agenda view. Each is
  a feature, not a skin. Parked — and so are the four the inventory
  found the first draft had assumed already existed (next section).

## MUST SURVIVE — the per-appointment styling semantics (decision #4)

The reskin adopts image 4's LAYOUT but keeps THIS app's appointment
styling meaning. Specifically:

- **Provider-colour coding.** Each appointment carries its provider's
  colour (the providerColor system). This is load-bearing: it is how a
  front desk reads a multi-provider day at a glance — whose appointment is
  whose. Image 4's cards must adopt the app's provider colours, not
  flatten them to one neutral treatment. The colour STAYS meaningful.
- **Status treatment — preserved AS-IS, which is minimal.** [INVENTORY]
  What the cards actually show today: cancelled appointments are not
  fetched at all (`.not("status","in","(cancelled)")`, schedule.vue:158);
  `no_show` renders at `opacity-50` in day and week (538, 622) and
  undifferentiated in month; booked, confirmed, checked_in, in_progress
  and completed all render identically, with status visible only as text
  in the detail dialog. The reskin keeps exactly that: no-show dimmed,
  cancelled absent, nothing else distinguished. Richer per-status styling
  is a design decision, not a skin — parked below.
- **Block / lunch styling — nothing to preserve.** [INVENTORY] The grid
  renders no blocks and no lunch; the schema's nearest concept is an
  availability_exceptions row of kind `break`, which the schedule never
  reads. The first draft's "hatched, which matches what we do" was
  wrong. Parked below.

## Parked features the references imply — each its own future project

The inventory (2026-09-19) found four things the references show, or the
first draft of this doc assumed, that the code does not have. None is a
skin. Each is listed so the reskin cannot absorb it by accident, and so
each can be picked up deliberately later, with its own design and its own
verification.

1. **Grid availability / time-off shading.** Working hours, approved
   time-off/sick/break exceptions and extra shifts drawn on the day and
   week grids (the hatched block/lunch cards of image 4). Data exists
   (availability_rules, availability_exceptions) and the slots route
   already computes exactly this per staff/day (slots.get.ts:104–134),
   but the grid reads none of it. Would need: a read path for the grid,
   the location-timezone conversion the slots route uses (see the seam
   under "Fragile"), and a decision on what a `break` exception looks like
   on screen.
2. **Realtime live updates.** A colleague's booking appearing without a
   refresh. The schedule holds no subscription and `appointments` is not
   in the supabase_realtime publication. Would need: a publication
   migration (push-first, gated), a queue-style composable carrying the
   recount-on-join / on-visible / stale-channel defences that
   useProspectQueue and useLeadQueue earned, and the browser-driving traps
   during verification. Until then the grid learns of changes only from
   its own mutations (`refreshAppointments`) and navigation.
3. **Richer per-status styling.** Distinct treatment for confirmed /
   checked-in / in-progress / completed on the cards. Today only no-show
   is distinguished. A visual vocabulary for status is a design session
   (what does "checked in" look like to a front desk at a glance), not a
   reskin decision.
4. **Collision / overlap layout.** Two appointments in one lane at
   overlapping times simply overlap today (absolute positioning, no
   collision pass). Image 4's between-times popover is one answer;
   side-by-side lanes is another. Either is a layout algorithm with its
   own edge cases, not a skin.

## Step zero — the behaviour inventory (the safety contract)

DONE 2026-09-19 — the inventory was produced against the code, reviewed,
and is what the corrections in this doc came from. The checklist it
established (what survives unchanged):

- what the page renders and what it loads: three views over ONE
  appointments query keyed by view + range (schedule.vue:144–164), a fixed
  08:00–20:00 grid at one pixel per minute (178–198), providers from
  active + bookable staff (216–225), the detail dialog's content and
  actions (713–794), and the dashboard's WeekCalendar as a second consumer
  of the same shape;
  **[UPDATED 2026-09-19, piece 2]** — the loading half of this item is no
  longer true. As inventoried: one query per active view (a day, a week,
  or the month grid), keyed by view + range, re-run on every view change.
  As built: the query ALWAYS fetches the six-week month grid around the
  selected date, keyed on that range alone (`fetchRangeKey`), and view
  switching is a pure in-memory filter through `apptsByDay` — no fetch.
  Only moving the selected date into a month grid that is not loaded
  queries. See "Decisions made during the build" below for why. The grid
  half changed too: the hour scale is no longer one pixel per minute but
  a percentage of the day over a body that fills the card, with the old
  720px as its floor (`pctOfDay`/`hourTop`); minutes are still decided
  exactly as before, only expressed differently;
- the availability calculation — server-side ONLY, in
  `GET /api/appointments/slots` (rules − exceptions + extra_shift − staff
  busy ∩ free room, 15-minute grid, location timezone via localToUtc),
  reached from the booking dialog's "Find available times"; the grid does
  not read it;
- conflict detection: the two exclusion constraints
  (`no_staff_double_booking`, `no_room_double_booking`, both ignoring
  cancelled/no_show), the route's 23P01 → 409 "That slot was just taken"
  (index.post.ts:212–219), the page's 409 → warning toast + re-fetch of
  slots (schedule.vue:405–418);
- the booking flow: dialog state → slots route → `POST /api/appointments`
  (re-derived from the catalog, intake gate under the service role, room
  pick, insert under the CALLER's RLS with booked_by pinned, snapshot,
  audit) → `refreshAppointments()`; status transitions, cancel and no-show
  are DIRECT supabase updates from the page under `appointments_update`
  RLS (246–295), each followed by a refetch;
- realtime: NONE (parked, above) — the refresh behaviour that exists is
  `refreshAppointments` after the page's own mutations, and the
  useAsyncData watch on selectedDate/view.
  **[UPDATED 2026-09-19, piece 2 — refetch trigger only, still NO
  realtime]**: the watch is now on the fetch-range key rather than on
  selectedDate/view, so a date move within the loaded grid does not
  refetch and a view switch never does. Nothing pushes changes to the
  page; realtime stays parked;
- the DATE-HANDLING SCARS — `toDateStr` = en-CA local keys
  (schedule.vue:19–21, WeekCalendar.vue:4–6); the noon anchor
  `T12:00:00` at schedule.vue:26, 47, 58–59, 75, 86, 803 and
  WeekCalendar.vue:72, 110 (server twin: `T12:00:00Z` in
  timezone.ts:50–52); the v-calendar weekly "anchor to the first
  attribute" fix at WeekCalendar.vue:81–89 (the invisible today-anchor,
  unshifted LAST); v-calendar day ids as YYYY-MM-DD (WeekCalendar.vue:95).
  A reskin that doesn't know them can re-break exactly what was fixed;
- the per-appointment styling: `providerColor` = string hash → 8-colour
  palette, `providerTint` = the colour at ~10% alpha (providerColor.ts);
  day/week cards get tint fill + colour left edge via `blockStyle` +
  `border-l-4` (schedule.vue:186–198, 537, 621); month chips the same
  inline (688–691); the day header's colour dot (518–522); WeekCalendar's
  colour bar and dots. Status: no-show dimmed, cancelled absent, nothing
  else.

The inventory is the contract: every item is re-verified after each piece.
Where a piece changes an item on purpose, the item stays in the list with
its original wording and an [UPDATED] note, so the record shows both what
was inventoried and what was decided.

## Decisions made during the build

### Load the month grid for every view (2026-09-19, piece 2)

**Decision.** The appointments query fetches the six-week month grid
(whole weeks, six rows) around the selected date, for all three views.
Day and week are always inside that range, so switching views never
fetches; each view filters `apptsByDay` for the days it shows. The query
is keyed on the range string, so moving the selected date within the
loaded grid does not query either. Only landing on a date whose grid is
not loaded does.

**Why.** The inventoried model — a query per view, re-run on view
change — produced a visible flicker: useAsyncData keeps the previous
key's rows until the new query resolves, so for ~150ms after a switch
the new view rendered stale data from the old range. Day view drew a
whole week of appointments into today's lanes at their hour (its lane
filter was by staff only; fixed separately by reading through the
date-keyed map — one predicate for all three views). Week view drew
today's cards first and popped the rest of the week in when its query
landed. A superset in memory removes the second failure at the root:
there is no new query to wait for, so there is nothing stale to show.
Verified by sampling the DOM every 4ms through each of the four
transitions: the complete, correct set is on the first rendered frame,
zero foreign cards on any frame.

**What it costs.** Up to six weeks of appointment rows per load instead
of one day's. Each row carries its client name, service snapshot and
resource, so this is a wider query, not just a longer one.

**Scale caveat — revisit if this changes.** Correct at the current
scale: one location, one appointments table in the hundreds of rows per
six weeks. Revisit if the club goes multi-location (the range would then
be six weeks × locations unless the query is location-scoped) or if
volume grows to where a six-week fetch is thousands of rows. The
alternatives then are a per-view range with the previous data cleared
(accepting a blank flash instead of a stale one) or a per-view range
where the new view renders only once its own query has resolved, with
the old view shown until then. Neither was worth its complexity today.

## Fragile — the seam the inventory found

The grid positions appointments by the VIEWER'S BROWSER CLOCK
(`start.getHours()`, schedule.vue `blockStyle`, and the day range built
from browser-local midnight), while the slots route computes availability
in the LOCATION'S timezone (`localToUtc`, timezone.ts). They agree only
while the viewer and the location share a zone — true today, one city —
and nothing marks the seam. It is now commented at both ends as a scar
(schedule.vue `blockStyle`/`fetchRange`, slots.get.ts) and recorded in
docs/TODO.md as a latent correctness bug to fix deliberately, NOT as part
of the reskin: a redesign that redraws `blockStyle` must keep the browser
clock behaviour exactly, so the bug stays where it is until it is fixed
on purpose.

## Build order (reviewable pieces, each checked against the inventory)

1. Behaviour inventory (step zero) — produce the checklist, no changes.
2. Appointment card — the shared image-4 card look (client/service/time)
   keeping provider colour + status. This lands the piece that also
   propagates to weekly/monthly.
3. Daily grid — image 4's provider-column layout, avatars, time axis,
   now-line, over the existing daily behaviour (no hatched blocks — see
   Parked #1).
4. Detail panel — image 3's styling over the existing panel content.
   Each piece: the look changes, then re-verify the relevant inventory items.

## Verification bar (different from the UI-consistency pass)

A select conversion checked "does @change still fire". This checks the
BEHAVIOUR survived the RESKIN. After the visual changes, prove live:

- book an appointment end to end — it still books;
- attempt a DOUBLE-BOOK — the conflict still refuses (the 23P01 path
  surfaces "that slot was just taken", not a silent success);
- availability still calculates — the booking dialog's "Find available
  times" still returns the right slots for a staff member with rules and
  an approved exception (there is no grid shading to check; see Parked);
- the grid still refreshes after the page's own mutations
  (`refreshAppointments`) — book, transition, cancel, no-show — and on
  date/view navigation (there is no realtime to check; see Parked);
- PROVIDER COLOURS still read correctly — appointments still show whose
  they are; the reskin did not flatten the colour coding; no-show is still
  dimmed and cancelled still absent;
- the three date scars still hold: today opens on today in the dashboard
  weekly strip, week/month navigation lands on the right days across a
  DST boundary, the booking dialog names the selected day correctly;
- the reserve-frontend skill's browser-driving traps apply (verifying an
  interactive grid live is exactly where they bite).

The screenshots tell you it LOOKS right; booking-including-a-double-book
tells you it still WORKS right. Both are required.

## Reference

- Schedule-daily.webp (image 4) — the daily aesthetic, the anchor.
- Schedule-daily-expanded.webp — daily with the between-times popover.
  Reference for Parked #4 (overlap layout) when that project runs; not
  used by the reskin.
- The order-details panel shot (image 3) — the detail panel's LOOK only.
- Month/agenda shots (images 1, 2) — NOT adopted; month grid redesign is
  parked (different data shape for a spa; a summary/load view is its own
  design, not a skin).
- The behaviour inventory (2026-09-19, in the session transcript, its
  findings folded into this doc) — the contract each piece is verified
  against.
- reserve-frontend skill — applies throughout; grew scheduler traps
  likely.
