# The Reserve — conventions

- Migrations: npx supabase migration new <name> → review → npm run db:push
  (chains typegen + tbls docs). NEVER edit applied migrations.
- After adding components/composables: npx nuxt prepare + TS server restart ("the ritual")
- UI: ui-thing components (npx ui-thing@latest add <name>); lucide icons ONLY (no heroicons)
- Money: ALL pricing math server-side in routes; ledger is append-only;
  refunds are negative mirrors; gift cards/credits are liabilities not revenue
- Auth in routes: requireUser(event) returns { user, client }; staff identity
  via current_staff_id() RPC; permission RPC param is `perm` (NOT p_key)
- Dates: never toISOString() for day-granular keys — toLocaleDateString("en-CA")
- Types: npx nuxt typecheck must stay at 0; payloads feeding insert+update
  typed as Omit<TablesInsert<"t">, "organization_id">
- Every new table: organization_id + org-scoped RLS (see docs/design/multi-tenancy-status.md)
