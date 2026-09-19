# UI polish backlog

Deferred by decision (2026-08-29): cosmetic-only items wait for a
dedicated polish sprint after the feature phases, so one pass produces
consistency and nothing is redone when features reshape layouts.
Exceptions that DON'T wait: anything misleading/data-risky, and trivial
fixes in files already being touched.

Add items as they occur; strike them when done.

## Captured so far

- Checkout: gift-applied state could show "remaining on card $X" more
  prominently (owner momentarily read the unchanged Total as a bug —
  front desk will too). Possibly: Complete button reads "Complete —
  $X on card" when a gift/split is applied.
- Mobile messages: back-chevron to bare /messages re-triggers the
  newest-conversation redirect (needs a viewport guard if mobile use
  materializes; front desk is desktop today).
- Datepicker preset shortcuts on financials ("Last month", "This
  quarter") if custom-range friction appears.
- Remaining native confirm() dialogs → themed AlertDialog/inline
  confirm: staff deactivate, invite revoke, availability deletes.
  (Transactions-page refund already converted; messages leave +
  financials refund already themed.)
- Dashboard md–xl band: calendar + new-clients cards as height
  neighbors — check rhythm; items-start on the grid if raggedy.
- New-clients card: scrollbar vs rounded corner (pr-1 on the scroll
  div if it offends).
- WeekCalendar "Back to today" affordance shipped? (designed in chat
  2026-08-29 — selection persists across week paging by design, label
  disambiguates; the back-to-today button was the recommended nicety).
  Verify it landed; add if not.
- Sheet/dialog footer button order + spacing audit across the app
  (some flex-row overrides applied piecemeal).
- First-run nudge on the empty dashboard (parked 2026-09-19 after the
  sparse-data acceptance pass): every card says its own "nothing yet"
  sentence in the same tone, which reads fine, but nothing on a new
  spa's dashboard points anywhere. One nudge — "Book your first
  appointment" in the Today card, or a single first-run banner — is
  additive and its own design question (where it lives, when it stops
  showing). Pairs with the empty-states audit below.
- Empty states audit: consistent tone and affordance ("start one",
  "no matches") across list surfaces.
