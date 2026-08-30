# Permission catalog and seeding

Permissions are **data**, not code. The catalog lives in `permissions`, the
matrix in `role_permissions`, and role assignments in `staff_roles`. Changing
who can do what is an `insert`/`delete`, not a deploy — which is the whole
point of the design, and the reason a permission key is worth minting only
when it names a genuinely distinct capability.

## Key naming

`domain.action`, with an optional `.own` / `.any` scope suffix when the same
action has a narrow and a broad form:

```
appointments.view.own      appointments.view.any
availability.edit.own      availability.edit.any
analytics.view.own         analytics.view.org
```

Underscores inside a segment where the action is multi-word:
`financials.view_own_earnings`, `appointments.override_conflicts`.

## Current catalog

**Check this list before minting a key.** A duplicate has already cost a
cleanup migration: `business_settings` added `organization.manage` when
migration 1's `org.settings.manage` already covered it, and
`consolidate_org_settings_permission` had to delete the key, its grants, and
the policies that referenced it.

Seeded in migration 1 (`init_org_auth_permissions`):

| Group | Keys |
| --- | --- |
| Appointments | `appointments.view.own`, `appointments.view.any`, `appointments.create`, `appointments.edit.own`, `appointments.edit.any`, `appointments.cancel.any`, `appointments.override_conflicts` |
| Clients | `clients.view`, `clients.create`, `clients.edit`, `clients.notes.health.view`, `clients.notes.health.create`, `clients.export`, `clients.delete` |
| Schedule & availability | `availability.edit.own`, `availability.edit.any`, `timeoff.request`, `timeoff.approve` |
| Staff management | `staff.view`, `staff.invite`, `staff.edit`, `staff.deactivate`, `roles.manage` |
| Service catalog | `services.view`, `services.manage` |
| Payments & memberships | `payments.take`, `payments.refund`, `memberships.manage`, `memberships.comp` |
| Financials | `financials.view_summary`, `financials.view_detail`, `financials.view_own_earnings`, `financials.export` |
| Marketing & forms | `forms.manage`, `forms.send`, `forms.responses.view` |
| Analytics | `analytics.view.org`, `analytics.view.own` |
| Messaging | `messages.send`, `messages.broadcast` |
| System | `audit_log.view`, `org.settings.manage` |

Added by `pos_ledger` (4a): `pos.checkout`, `pos.refund`,
`transactions.view`, `products.view`, `products.manage`, `gift_cards.view`

Added by `stripe_cards` (4b): `cards.view`, `cards.manage`

Retired: `organization.manage` — deleted by
`consolidate_org_settings_permission` in favor of `org.settings.manage`.

**Two keys are seeded but unused.** The POS work introduced `pos.checkout`
and `pos.refund` rather than adopting migration 1's speculative
`payments.take` / `payments.refund`, which no route or component references.
When you touch POS permissions, use the `pos.*` keys; don't resurrect the
`payments.*` pair, and don't assume a seeded key is live without grepping
for it.

## The four system roles

`super_admin`, `admin`, `front_desk`, `provider` — created with
`is_system = true` in migration 1 and undeletable
(`prevent_system_role_deletion`). Orgs can add their own roles on top.

Roughly: `super_admin` holds everything; `admin` holds everything except
role management, client deletion, financial export, audit log, and org
settings; `front_desk` covers booking, clients, checkout, and gift cards;
`provider` covers own schedule, own analytics, health notes, and read-only
catalog. Grant new keys along those lines unless the feature says otherwise.

The last active `super_admin` cannot be stripped of the role
(`prevent_last_super_admin_removal`) or deactivated
(`prevent_last_super_admin_deactivation`) — the org can't lock itself out.

## Seeding template

Current idiom — a `values` list joined against `roles` by name, which reads
as a matrix and stays legible as it grows:

```sql
insert into permissions (key, description) values
  ('pos.checkout',      'Ring up transactions at checkout'),
  ('pos.refund',        'Issue refunds'),
  ('transactions.view', 'View the transaction ledger');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', 'pos.checkout'), ('super_admin', 'pos.refund'),
  ('super_admin', 'transactions.view'),
  ('admin',       'pos.checkout'), ('admin',       'pos.refund'),
  ('admin',       'transactions.view'),
  ('front_desk',  'pos.checkout'), ('front_desk',  'transactions.view')
) as p(role_name, key) on p.role_name = r.name;
```

Descriptions are user-facing — they render in the role editor, so write them
as capability sentences ("Save and remove client cards on file (with consent
capture)"), not restatements of the key. Escape apostrophes by doubling:
`'See a client''s saved cards (brand + last4)'`.

Migration 1 used a different form inside a `do $$` block
(`select r_desk, unnest(array[...])`) because it was creating the roles and
capturing their ids in the same block. Follow that only if you are also
creating roles; otherwise use the join form above.

## Checking permissions from app code

Server routes assert via the `has_permission` RPC. **The parameter is
`perm`, not `p_key`:**

```ts
const { data: allowed } = await userClient.rpc("has_permission", { perm: "pos.refund" });
if (!allowed) {
  throw createError({ statusCode: 403, statusMessage: "Missing permission: pos.refund" });
}
```

Getting this wrong does not fail loudly — passing `p_key` made every refund
return a silent 403, found during the 4a gauntlet. Supabase RPC parameters
are passed by name, so a wrong name is a runtime failure dressed up as a
permissions problem, and it looks identical to a missing grant.

The defense is mechanical, not vigilance: **`shared/types/database.ts` is
the authority on RPC parameter names.** It is regenerated from the live
schema by `npm run db:push`, so it cannot drift. Read the generated
signature before writing any RPC call; never type a parameter name from
memory. (`has_permission(perm)` is a grandfathered exception to the `p_`
prefix convention that all new functions follow — precisely because it is
referenced in every RLS policy and multiple routes.)

`server/utils/requireUser.ts` wraps this. On the client, the `usePermissions`
composable exposes `can("pos.checkout")` for conditional UI — but UI gating
is cosmetic; RLS and the route check are the enforcement.

Grep both `server/` and `app/` for a key before renaming or removing it.
