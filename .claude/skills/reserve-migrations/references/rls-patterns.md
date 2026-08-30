# RLS patterns

Every policy in this codebase is built from three `security definer stable`
helpers defined in migration 1:

| Helper | Returns |
| --- | --- |
| `current_staff_id()` | the `staff.id` for `auth.uid()`, active rows only |
| `current_org_id()` | that staff row's `organization_id` |
| `has_permission(perm text)` | whether the current staff holds a permission key |

They are `security definer` so they can read `staff` / `staff_roles` without
being subject to those tables' own policies. `has_permission`'s parameter is
named `perm` — that's the name routes must use when calling it over RPC.

Enable RLS for all of a migration's tables in one aligned block, then write
the policies grouped by table:

```sql
alter table card_consents          enable row level security;
alter table client_payment_methods enable row level security;
alter table stripe_events          enable row level security;
```

---

## 1. The org-scoped pair (default)

For a table that owns an `organization_id` column:

```sql
create policy products_read on products
  for select using (organization_id = current_org_id() and has_permission('products.view'));
create policy products_manage on products
  for all using (organization_id = current_org_id() and has_permission('products.manage'));
```

`for all using (...)` with no `with check` clause is intentional and correct:
Postgres reuses the `USING` expression as the `WITH CHECK` expression when
the latter is omitted, so inserts and updates are constrained by the same
predicate. Only write an explicit `with check` when the write-side condition
genuinely differs from the read-side one.

Split into separate `_read` / `_insert` / `_update` / `_delete` policies when
each verb needs a different permission — `clients` is the reference example:

```sql
create policy clients_read on clients
  for select using (organization_id = current_org_id() and has_permission('clients.view'));
create policy clients_insert on clients
  for insert with check (organization_id = current_org_id() and has_permission('clients.create'));
create policy clients_update on clients
  for update using (organization_id = current_org_id() and has_permission('clients.edit'));
create policy clients_delete on clients
  for delete using (organization_id = current_org_id() and has_permission('clients.delete'));
```

---

## 2. Child tables: scope through the parent

Line-item and join tables don't carry their own `organization_id`. They
reach it with an `exists` subquery against the parent, which keeps the org
boundary intact without denormalizing:

```sql
create policy transaction_items_read on transaction_items
  for select using (exists (select 1 from transactions t where t.id = transaction_id
    and t.organization_id = current_org_id() and has_permission('transactions.view')));
```

The same shape covers `service_staff` (via `services`), `resources` (via
`locations`), `staff_roles` and `staff_locations` (via `staff`), and
`appointment_services` (via `appointments`).

When the parent's own visibility is conditional, the child repeats the
parent's condition rather than guessing:

```sql
create policy appointment_services_read on appointment_services
  for select using (
    exists (select 1 from appointments a where a.id = appointment_id
            and a.organization_id = current_org_id()
            and (has_permission('appointments.view.any')
                 or (has_permission('appointments.view.own') and a.staff_id = current_staff_id())))
  );
```

---

## 3. own/any scopes

Permission keys ending `.own` and `.any` express "your rows" versus
"everyone's". The policy shape is always the same — `.any` short-circuits,
`.own` adds an identity check:

```sql
create policy appointments_read on appointments
  for select using (
    organization_id = current_org_id()
    and (
      has_permission('appointments.view.any')
      or (has_permission('appointments.view.own') and staff_id = current_staff_id())
    )
  );
```

`availability_rules` uses the same pattern for `availability.edit.any` /
`availability.edit.own`, and `availability_exceptions` blends it with a
status condition so that staff may edit their own request only while it is
still `requested`:

```sql
create policy availability_exceptions_update on availability_exceptions
  for update using (
    has_permission('timeoff.approve')
    or (staff_id = current_staff_id() and status = 'requested')
  );
```

Insert policies additionally pin the actor, so a row can't be attributed to
someone else:

```sql
create policy appointments_insert on appointments
  for insert with check (
    organization_id = current_org_id()
    and has_permission('appointments.create')
    and booked_by = current_staff_id()      -- can't book "as" another person
  );
```

`client_notes_insert` (`author_id = current_staff_id()`) and `invites_create`
(`invited_by = current_staff_id()`) do the same.

---

## 4. Sensitivity tiers within one table

`client_notes` gates a subset of rows by a *second* permission, keyed off a
column value, rather than splitting the table:

```sql
create policy client_notes_read on client_notes
  for select using (
    has_permission('clients.view')
    and (kind <> 'health' or has_permission('clients.notes.health.view'))
    and exists (select 1 from clients c where c.id = client_id and c.organization_id = current_org_id())
  );
```

Front desk can read preference and internal notes and simply cannot see
health rows. Note the audit caveat: RLS decides who *can* read them, but a
SELECT cannot fire a trigger, so the "health-note access is audit-logged"
requirement is implemented at the app layer — health notes are read through
a server route that writes an `audit_log` row (`health_note.viewed`) first.
See `docs/design/migration3_booking_contract.md`.

---

## 5. Self-service: RLS says who, a trigger says which columns

Staff may edit their own row, but not the org-controlled fields on it. RLS
can't express "these columns only", so the policy is permissive and a
`before update` trigger enforces the column boundary:

```sql
create policy staff_self_update on staff
  for update using (user_id = auth.uid());
```

```sql
create or replace function guard_staff_self_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.user_id = auth.uid() and not has_permission('staff.edit') then
    if new.email is distinct from old.email
       or new.title is distinct from old.title
       or new.bookable is distinct from old.bookable
       or new.active is distinct from old.active
       or new.organization_id is distinct from old.organization_id
       or new.user_id is distinct from old.user_id then
      raise exception 'These fields are managed by an administrator';
    end if;
  end if;
  return new;
end;
$$;
```

Use `is distinct from` rather than `<>` so that NULL-to-value transitions
are caught.

---

## 6. Membership checks without infinite recursion

A policy on `conversation_participants` that queries
`conversation_participants` recurses and Postgres raises **42P17**. The fix
is a `security definer` function, which runs outside RLS:

```sql
create or replace function is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql security definer set search_path = public
stable
as $$
  select exists (
    select 1 from conversation_participants
    where conversation_id = p_conversation_id
      and staff_id = current_staff_id()
  );
$$;

create policy conversations_read on conversations
  for select using (is_conversation_participant(id));
create policy participants_read on conversation_participants
  for select using (is_conversation_participant(conversation_id));
create policy messages_read on messages
  for select using (is_conversation_participant(conversation_id));
```

Any time a table's policy needs to consult the same table (or a cycle of
tables), reach for this shape.

---

## 7. Recipient-scoped rows

`notifications` needs no permission key at all — the recipient is the
authorization:

```sql
create policy notifications_read on notifications
  for select using (staff_id = current_staff_id());
create policy notifications_update on notifications
  for update using (staff_id = current_staff_id());
-- No insert/delete policies: rows are created by triggers (security definer)
-- or the service role only.
```

This also governs Realtime delivery: the table is published to
`supabase_realtime`, and because RLS applies to Realtime too, a staff member
only ever receives their own rows over the socket.

---

## 8. Deliberately absent policies

Two distinct reasons a table has fewer policies than you'd expect. Both are
load-bearing and both get a comment.

**Append-only.** No update or delete policies will ever exist:
`transactions`, `transaction_items`, `payments`, `client_notes`, `messages`,
`card_consents`, `audit_log`. `audit_log` adds an explicit belt-and-braces
revoke:

```sql
-- No update/delete policies will ever be created: append-only by construction.
revoke update, delete on audit_log from authenticated, anon;
```

**Writes belong to a server route.** When the operation is multi-step,
prices things, or calls Stripe mid-flight, there is no authenticated insert
policy at all and the service role does the work:

```sql
-- RLS — reads by permission; ALL writes through server routes
-- (service role). No authenticated insert/update/delete policies:
-- consent capture and card saves are multi-step acts with Stripe
-- calls in the middle, so they live in routes, same as the ledger.
```

`stripe_events` goes furthest: RLS enabled, zero policies, service role
only. Enabling RLS with no policies is the correct way to say "nothing
reaches this from the browser" — it is not an oversight, so it is commented
as intentional.

---

## 9. Storage buckets

Storage policies live on `storage.objects` and are quoted by name. The
avatars bucket is public-read, own-folder-write, keyed on the auth uid as
the first path segment:

```sql
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

Repeat for select / update / delete as the bucket requires.
