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
- Types: npx nuxt typecheck must stay at 0; payloads feeding insert+update
  typed as Omit<TablesInsert<"t">, "organization_id">
- Every new table: organization_id + org-scoped RLS (see docs/design/multi-tenancy-status.md)
