# Messaging enhancements — design

Status: DESIGN, not built. ADDITIVE features over UNTOUCHED messaging
internals. Owner-independent. Design-room session 2026-09-20.

## What this is, and the rule that governs it

Three features on the messages page: a right rail (contact context +
staff directory) and an All/Unread conversation filter. All three sit
BESIDE the existing messaging behaviour — none changes the realtime,
DM-dedup, leave/GC, or unread internals. The governing rule:

These are additive. The messaging scars stay untouched, and the two
places that overlap existing logic REUSE it, they do not reimplement
it.

## Must-not-break (the messaging scars, all untouched)

Confirmed additive — none of the three features touches these, and the
build must preserve them:

- Realtime channel naming (the Date.now() suffix that stops remount
  collisions on re-subscribe).
- definePageMeta({ key: "messages" }) — the single-instance trick that
  keeps one component across /messages/<id> navigation.
- Canonical DMs (find_or_create_dm dedups by participant pair).
- leave_conversation and its garbage-collection.
- Unread derivation (last message's created_at vs the reader's
  last_read_at) — this feature READS it (the filter), never rewrites it.

## Layout

Desktop / laptop only (stated deployment) — so NO responsive hide/toggle
breakpoint. The page becomes THREE fixed columns in its existing
full-height flex row:

conversation list | chat thread | NEW right rail

- The row is already bounded by the page's h-[calc(100vh-...)] parent;
  the list and thread already scroll INTERNALLY within it. The rail
  slots into that same height model: h-full within the bounded parent.
- The rail is a FIXED width (à la the dashboard right rail's 436px); the
  chat thread takes the remainder. The rail does not flex; the thread
  absorbs width changes. A sane min-width on the thread keeps three
  columns from collapsing into slivers if a laptop window is dragged
  narrow (desktop-only means this is a floor, not a responsive system).
- HEIGHT NOTE (the symptom already hit): ScrollFrame is cap-less by
  design — it only scrolls when given a bounded height. Placed OUTSIDE
  a bounded parent it "stretches to the bottom of the browser" (observed).
  Placed as a column INSIDE the already-bounded full-height row, its
  flex-1 has a fraction to fill, so it scrolls within the rail's share.
  The fix is fitting the page's existing height model, NOT a max-h pixel
  cap. Match the mechanism the list and thread panels already use. (The
  chat thread already hand-rolls the pinned-composer / scrolling-messages
  pattern — the rail's ScrollFrame is the componentised version of the
  same idea in a new column. Do NOT refactor the thread to use it; that's
  untouched-behaviour territory.)

## Feature 1 — rail top: conversation context (display-only)

The top of the rail shows WHO the current conversation is with. It is
shrink-0 (fixed height) and DISPLAY-ONLY — clicking does nothing
anywhere in this section (consistent grammar with the directory below).
Two modes:

- **DM (one partner):** a full contact card — avatar, name, role, work
  contact info (phone/email — work fields, staff seeing colleagues'
  work contact is permission-appropriate), and a way to go to their
  profile (/staff/[id]).
- **Group (multiple):** stacked overlapping avatars (ui-thing's
  -space-x-3 idiom), capped at ~4 with a +N overflow indicator, NAME ON
  HOVER only. No per-person contact detail, no profile links, no click.
  Membership-at-a-glance, not a roster — which is why it needs no scroll
  regardless of group size (fixed footprint). The way to reach a
  person's detail is the directory below, not the group avatars.

## Feature 2 — rail directory: staff list (the actionable part)

Below the context card, a list of staff members: avatar + name per row.

- **Row click is INERT** — the row is a container for two controls, not
  itself a button. Make the two controls read as the actionable bits so
  a user doesn't click the row expecting something.
- **Per-row ellipsis menu (i-lucide:ellipsis-vertical):**
  - "Chat with" → find_or_create_dm (the canonical-DM logic; a new
    ENTRY POINT to existing behaviour, not new behaviour).
  - "Go to profile" → NuxtLink to /staff/[id].
- **Per-row checkmark → multi-select.** Selecting one or more reveals a
  "Start conversation" button at the BOTTOM of the rail. One selected =
  DM (find_or_create_dm); multiple = group (create_group_conversation).
- The directory uses ScrollFrame, filling the rail's remaining height
  (below the fixed context card) and scrolling within the bounded row.

REUSE POINT (do not duplicate): the checkmark selection + "Start
conversation" one-vs-many → DM-or-group logic is EXACTLY the new-
conversation modal's behaviour (the useToggleSet picker +
find_or_create_dm / create_group_conversation). Reuse the modal's
selection state and creation logic — ideally the same composable/helper
powers both the modal and the rail, so "start a chat from a staff
selection" has ONE definition. The rail must not hand-roll its own
create_group_conversation call.

## Feature 3 — conversation-list filter: All / Unread

Above the CONVERSATION LIST (not the message thread): a filter with two
options and counts.

- **All (count)** — default; the current behaviour (most recent on top).
- **Unread (count)** — only conversations with unread messages.

REUSE POINT (do not duplicate): the "which conversations are unread" and
the counts both come from the EXISTING unread-derivation (last message
vs last_read_at). The filter reads that logic; it does not recompute
"unread" a second way.

## The two reuse-points, stated plainly (the two-paths rule)

1. Multi-select → "Start conversation" reuses the modal's selection +
   DM/group-creation logic. Share it; a second copy would drift.
2. The All/Unread filter reuses the existing unread-derivation. Don't
   compute "unread" a second way.

Both are the two-paths-one-predicate convention: a behaviour appearing
in a second place is the moment to share, not copy (as with trend.ts,
ScrollFrame, shared/ask/format.ts).

## Build order (reviewable pieces, each verified)

1. **Layout shell** — add the third column; confirm the rail sits h-full
   in the bounded row and scrolls WITHIN rather than stretching to the
   browser bottom (the observed symptom — verify it's fixed first).
   Thread narrows; confirm it stays usable with a sane min-width.
2. **Rail top** — DM contact card vs group avatar stack (+N, hover
   names, no click).
3. **Directory** — rows + ellipsis menu (chat / profile) + checkmark
   multi-select → "Start conversation". VERIFY it opens/creates the SAME
   conversations the modal would (proving the shared logic), and that a
   group made from the rail is identical to one made from the modal.
4. **Filter** — All/Unread above the conversation list, counts and
   membership from the existing unread-derivation.

## Verification

- The rail scrolls within its column, does not stretch past the
  viewport (the height symptom, re-checked).
- Row click does nothing; the menu and checkmark are the only actions.
- "Chat with" and rail multi-select open/create the same conversations
  the modal does (shared logic, not a parallel copy).
- The filter's counts and Unread membership match the unread badges
  already shown (same derivation, not a second computation).
- The messaging scars still hold: realtime delivers, DM dedup works,
  leave/GC works, single-instance navigation works — additive changes
  didn't disturb them.
- reserve-frontend skill applies (the browser-driving traps, since
  there's realtime + interactive selection to verify live).

## Reference

- messaging-as-built.md — the existing behaviour and the scars.
- The new-conversation modal — the selection/creation logic to SHARE.
- ScrollFrame (dashboard) — the directory's scroll container.
- The dashboard right rail (xl fixed-width) — the fixed-width-column
  precedent, minus the responsive breakpoint (desktop-only here).
