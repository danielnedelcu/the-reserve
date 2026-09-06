# The Reserve — conventions

- Migrations: npx supabase migration new <name> → review → npm run db:push
  (chains typegen + tbls docs). NEVER edit applied migrations.
- Push-first when one change adds columns/tables AND the route code reading
  them: apply the migration so typegen emits the types, THEN write the call
  site. A type shim silencing errors on the table you just changed is the
  failure mode — it disables checking exactly where the schema moved.
  Nuance: push needs approval, so if the consumer must exist first to make
  the change reviewable, the shim is an acknowledged cost, marked and
  deleted the moment typegen lands. Default is push-first; shim is the
  exception you justify.
- After adding components/composables: npx nuxt prepare + TS server restart ("the ritual")
- UI: ui-thing components (npx ui-thing@latest add <name>); lucide icons ONLY (no heroicons)
- Money: ALL pricing math server-side in routes; ledger is append-only;
  refunds are negative mirrors; gift cards/credits are liabilities not revenue
- Auth in routes: requireUser(event) returns { user, client } — but `user` is
  DECODED JWT CLAIMS, typed as a Supabase User. The auth user id is the `sub`
  claim, NOT `.id`. `user.id` typechecks and is undefined at runtime, which
  is what wrote NULL into audit_log.actor_user_id across health_note.viewed /
  appointment.booked / pos.checkout. Use `user.sub ?? user.id` (accept both,
  so a library change can't reintroduce it). Staff identity via
  current_staff_id() RPC; permission RPC param is `perm` (NOT p_key)
- Dates: never toISOString() for day-granular keys — toLocaleDateString("en-CA")
- Silent-failure assumptions: when a change depends on something that
  produces NO error if false — a cache hits, a prefix is stable, a harness
  actually connected, an optimization fires — make verifying it a build
  step, and measure the specific signal that would be wrong if it failed.
  A green suite does not prove an assumption the suite doesn't check.
  Caught this way, all three passing every gate: a verify harness counting
  connection failures as PASS; an editor-restored duplicate module (the
  diff showed a modification where a rename was expected); a sliding-window
  cache miss that just costs more, quietly, later.
- Two paths deciding one predicate: derive once, or test the disagreement.
  This project deliberately enforces rules in Postgres, so the same
  question routinely gets decided in two languages — a plpgsql function
  and the TypeScript route calling it — where one shared implementation is
  impossible. The architecture GENERATES this bug class; it is expected,
  not incidental, and it always fails the same way: both sides agree on
  the common case and diverge at an edge, so every ordinary test passes.
  Two tiers.
  (1) When they CAN share, derive it once and make divergence
  unrepresentable. `shared/ask/format.ts` is the model: caption and table
  each formatted `_cents`, drifted, and a single-cell result read
  "Avg spend: 4064" in the caption above "$40.64" in the table (42290e5).
  One contract, and the bug stopped being expressible.
  (2) When they CANNOT share — one side is a database function — test the
  edge where they would disagree, never the common case where they agree.
  Real instances: the submit route decided "prospect link" as
  client_id-null AND key=prospect_intake while submit_form_response
  decided it as client_id-null alone, so a subject-less link on any other
  form sent NULL into a NOT NULL column (23502) — the DB-layer harness was
  31/31 green while that hole was open, and only an end-to-end test found
  it. The public form treated `false` as unanswered while the server
  treated it as the answer "no", silently discarding every explicit No and
  making a required yes/no question unanswerable. The forms editor locked
  all four contact keys when the contract required three, quietly making
  `phone` uneditable. `tests/shared/formValidation.test.ts` is the shape
  to copy: it asserts the two sides AGREE across deliberately awkward
  inputs, so drift fails the test regardless of which side is right.
  Known live seam, currently consistent but unasserted: `shared/ask/presets.ts`
  ids must pair with `PRESET_SQL` keys or a preset silently falls through
  to the LLM — 15/15 match today, and nothing checks it.
- "Built" means a human can complete the flow from the UI. Not that the
  machinery exists. The failure mode is specific and it passed every gate:
  schema applied, route written, typecheck 0, unit tests green, boundary
  harness green — and a real person still could not do the thing, because
  the human-facing caller was never written. Three in the forms feature
  alone: no way to CREATE a form (the empty state shipped the gap as a
  sentence, "created through the API for now"), no way to SEND one (the
  route minted a link and left delivery to the staff member's own email
  client), and no way to send a waiver AT ALL (the dialog collected an
  address but never a client, so every attempt 422'd). Each was
  "schema + route done, caller never written", and each was described as
  finished. So: "works end to end" is a claim about the USER'S REACHABLE
  PATH, not about the code's capability, and it is earned by driving the
  actual loop — open the page, click the button, receive the email, read
  the result — with no curl, no service-role script, and no copy-paste
  step standing in for a missing screen. If a step in the demo is "then a
  developer runs...", the feature is not built. Corollary: an empty state
  or a comment admitting the gap is not a mitigation; it is the gap,
  written down and shipped.
- Types: npx nuxt typecheck must stay at 0; payloads feeding insert+update
  typed as Omit<TablesInsert<"t">, "organization_id">
- Every new table: organization_id + org-scoped RLS (see docs/design/multi-tenancy-status.md)
