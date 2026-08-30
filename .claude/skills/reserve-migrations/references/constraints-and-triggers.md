# Constraints, triggers, and functions

The guiding idea: if a rule must never be violated, it belongs in the
database, where a UI bug, a bad API call, or someone in the SQL editor
cannot get around it. Application code then only has to produce *good*
error messages, not guarantee correctness.

---

## Check constraints

**Column-level**, for value ranges — written inline:

```sql
price_cents      int not null check (price_cents >= 0),
duration_minutes int not null check (duration_minutes > 0),
day_of_week      int not null check (day_of_week between 0 and 6),  -- 0 = Sunday
exp_month        int not null check (exp_month between 1 and 12),
tax_rate_bps     int not null default 0 check (tax_rate_bps between 0 and 3000),
quantity         int not null default 1 check (quantity > 0),
body             text not null check (length(body) between 1 and 4000),
```

**Enums as text + check**, never a Postgres `enum` type:

```sql
kind   text not null check (kind in ('service','product','gift_card','tip','discount')),
status text not null default 'booked' check (status in
       ('booked','confirmed','checked_in','in_progress',
        'completed','cancelled','no_show')),
```

Extending one is then an ordinary constraint swap, which is exactly what
4b did to add a tender method:

```sql
alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('card_external','gift_card','cash','stripe_card'));
```

(The auto-generated name is `<table>_<column>_check`.)

**Table-level**, for cross-column invariants — written last in the
`create table`:

```sql
check (starts_at < ends_at),
check (blocked_from <= starts_at and ends_at <= blocked_until),
check (total_cents = subtotal_cents - discount_cents + tax_cents + tip_cents),
```

**The presence-pairing idiom.** When a column must be present exactly when
another has a particular value, express it as a boolean equality rather
than two `or`-ed clauses — it reads as "these two facts are the same fact":

```sql
check ((method = 'gift_card') = (gift_card_id is not null))
```

```sql
-- stripe_card payments must carry their intent; other methods must not
alter table payments add constraint payments_stripe_intent_presence
  check ((method = 'stripe_card') = (stripe_payment_intent_id is not null));
```

---

## Exclusion constraints

These are the constraints that make double-booking *impossible*, including
under simultaneous inserts from two users — something an application-level
"check then insert" can never guarantee. `btree_gist` (installed in
migration 3) is what allows mixing `=` with the overlap operator `&&`.

```sql
create extension if not exists btree_gist;

alter table appointments add constraint no_staff_double_booking
  exclude using gist (
    staff_id with =,
    tstzrange(blocked_from, blocked_until) with &&
  ) where (status not in ('cancelled','no_show'));

alter table appointments add constraint no_room_double_booking
  exclude using gist (
    resource_id with =,
    tstzrange(blocked_from, blocked_until) with &&
  ) where (status not in ('cancelled','no_show') and resource_id is not null);
```

The `where` clause is what makes cancellations free their slot
automatically — cancelled and no-show rows stop participating in the
constraint, so nothing has to be cleaned up.

For overlaps over `time` (not `timestamptz`) there is a custom range type,
created idempotently because its migration was half-applied once:

```sql
do $$ begin
  create type timerange as range (subtype = time);
exception when duplicate_object then null;
end $$;

alter table availability_rules add constraint no_overlapping_hours
  exclude using gist (
    staff_id with =,
    day_of_week with =,
    timerange(start_time, end_time) with &&
  );
```

**The route's side of the bargain:** a losing insert raises SQLSTATE
**23P01**. Per `docs/design/migration3_booking_contract.md`, that is the
expected concurrency path — surface "That slot was just taken" and refresh
availability, don't log it as an error.

---

## Indexes

Named `<table>_<purpose>`. Time-ordered lists get `desc`; constant filters
get a partial index:

```sql
create index transactions_org_day on transactions (organization_id, created_at desc);
create index client_notes_client on client_notes (client_id, created_at desc);
create index notifications_unread on notifications (staff_id) where read_at is null;
create index transaction_items_staff on transaction_items (staff_id) where staff_id is not null;
create index client_payment_methods_client on client_payment_methods (client_id) where active;
create index clients_org_email on clients (organization_id, lower(email));
```

A partial *unique* index is how conditional uniqueness gets expressed —
here, one live invite per email per org, where "live" means pending,
unrevoked, and (checked separately) unexpired:

```sql
create unique index staff_invites_one_pending
  on staff_invites (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;
```

---

## Function conventions

Every function in this schema is:

```sql
language plpgsql security definer set search_path = public
```

— or `language sql ... stable` for read-only helpers. `security definer`
lets RLS helpers and triggers read tables the caller can't; `set search_path
= public` is what keeps that safe from search-path hijacking, so it is never
omitted. `touch_updated_at()` is the one exception that needs no elevation
and is plain `language plpgsql`.

Names read as verbs, grouped by what they do:

| Prefix | Purpose | Example |
| --- | --- | --- |
| `current_` / `has_` | RLS helpers | `current_staff_id`, `has_permission` |
| `apply_` | maintain derived state on write | `apply_gift_card_payment`, `apply_product_sale` |
| `maintain_` | maintain a denormalized counter | `maintain_no_show_count` |
| `notify_` | create notification rows | `notify_timeoff_decision`, `notify_message_received` |
| `prevent_` / `guard_` | block an illegal write | `prevent_last_super_admin_removal`, `guard_staff_self_update` |
| `audit_` | write audit_log rows | `audit_staff_role_change` |
| `find_or_create_` / `create_` / `leave_` / `mark_` | RPCs the app calls | `find_or_create_dm`, `mark_conversation_read` |

**Parameters: `p_` prefix on every new function** (`p_conversation_id`,
`p_staff_ids`). Two reasons, and the second is the one that bites. First, an
unprefixed parameter that shadows a column silently changes what a `where`
clause means. Second, uniformity makes the parameter name predictable from
the call site — which matters because Supabase RPC calls pass parameters by
name, so a wrong guess is not a compile error, it is a runtime failure that
looks like a permissions problem.

Older migrations use bare names (`invite_token`, `org`, `excluded_staff`);
leave them, don't copy them. `has_permission(perm)` is grandfathered — it is
referenced by every RLS policy and several server routes, so renaming it is
a schema-wide change rather than a tidy-up.

That exception is not hypothetical: calling it as `p_key` instead of `perm`
produced silent 403s on every refund, caught during the 4a gauntlet. The
corollary is a hard rule — **`shared/types/database.ts` is the authority on
RPC parameter names.** It is regenerated from the live schema by
`npm run db:push`. Read the generated signature before writing the call;
never type one from memory.

**RPCs called by the app** validate their caller and raise plain-language
exceptions:

```sql
declare
  me uuid := current_staff_id();
begin
  if me is null then raise exception 'Not a staff member'; end if;
```

**Service-role-only functions** are locked down after creation — the
signature must be spelled out in full:

```sql
revoke execute on function accept_staff_invite(uuid, uuid, text, text)
  from public, anon, authenticated;
```

Use `create or replace function` throughout; that is also how a later
migration repairs a function's behavior (`pos_refund_fix` replaced
`apply_product_sale` wholesale to make it refund-aware).

---

## Trigger conventions

Named `trg_<subject>`, or `trg_<table>_touch` for the shared timestamp
updater. The pattern is always a standalone function plus a thin trigger:

```sql
create trigger trg_gift_card_payment
  after insert on payments
  for each row execute function apply_gift_card_payment();
```

`before` for guards and mutations of the row being written, `after` for
side effects (balances, stock, notifications, audit rows).

**`updated_at`** — the shared function, defined once in the service catalog
migration, attached to every mutable table:

```sql
create trigger trg_products_touch
  before update on products
  for each row execute function touch_updated_at();
```

**Fire on the fact, not the UI.** Triggers key off state transitions so
they hold no matter what changed the row — a page, a route, or someone in
the SQL editor:

```sql
if new.status = 'no_show' and old.status <> 'no_show' then
  update clients set no_show_count = no_show_count + 1 where id = new.client_id;
elsif old.status = 'no_show' and new.status <> 'no_show' then
  update clients set no_show_count = greatest(no_show_count - 1, 0) where id = new.client_id;
end if;
```

**Guard triggers raise, and the message reaches a human.** These strings
surface in the UI as toast text, so write them as sentences:

```sql
raise exception 'Cannot remove the last active super admin';
raise exception 'System roles cannot be deleted';
raise exception 'These fields are managed by an administrator';
raise exception 'Invite is invalid, expired, or already used';
```

**Choose block-vs-absorb deliberately, and say which you chose.** Gift card
overdrafts are blocked (the `balance_cents >= 0` check turns them into
errors); product stock underflow is absorbed (`greatest(..., 0)`) because
physical inventory drifts and the sale already happened at the counter. Both
carry a comment explaining the choice.

**Multi-row effects use `insert ... select`**, with dedupe expressed in the
query rather than a loop — `notify_message_received` notifies every other
participant while guaranteeing at most one unread bell entry per
conversation:

```sql
insert into notifications (staff_id, kind, title, body, link)
select p.staff_id, 'message.received', coalesce(sender_name, 'New message'),
       left(new.body, 80), '/messages/' || new.conversation_id
from conversation_participants p
where p.conversation_id = new.conversation_id
  and p.staff_id <> new.sender_staff_id
  and not exists (
    select 1 from notifications n
    where n.staff_id = p.staff_id
      and n.kind = 'message.received'
      and n.link = '/messages/' || new.conversation_id
      and n.read_at is null
  );
```

---

## What triggers cannot do

**SELECTs don't fire triggers.** Any "reading X must be audited"
requirement has to be implemented at the app layer — a server route that
writes the `audit_log` row and then returns the data. This is why health
notes are read through a route rather than queried from the browser, and
the schema comment on `client_notes` says so explicitly so nobody
"optimizes" the route away.

**Triggers can't make external calls.** Anything involving Stripe, email,
or another service belongs in a server route. The database's job stops at
recording the result — which is why ledger rows are only written after a
PaymentIntent succeeds.

---

## Realtime

Publishing a table lets the UI subscribe. RLS still applies to the socket,
so recipients receive only rows their policies allow:

```sql
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversation_participants;
```
