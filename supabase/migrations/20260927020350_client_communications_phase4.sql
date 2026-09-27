-- ============================================================
-- Migration: client communications — phase 4 (fee engine schema + system staff)
-- npx supabase migration new client_communications_phase4
--
-- The cancel-via-link action and the cancellation-fee engine
-- (docs/design/client-communications-design.md, phase 4). Two things the
-- existing schema cannot express:
--   1. a ledger line for the late-cancellation fee — transaction_items.kind
--      is a checked set, and the fee is a sixth kind;
--   2. an ACTOR for money and audit rows written by automated paths —
--      transactions.checked_out_by is NOT NULL and references staff, and a
--      client cancelling through an emailed link has no cashier. Rather
--      than relax the column or borrow a real person's identity, each
--      organisation gets one system staff row: inactive, unbookable, no
--      login, so it appears in no directory and no schedule, and every
--      automated action can be attributed to it and queried as one.
--
-- Everything else the phase needs is already data, not schema:
-- appointments.cancel_reason is free text ('client_via_link'),
-- cancelled_by is nullable (no staff cancelled it), notifications.kind is
-- unchecked, and communications_sent already lists cancellation_notice.
-- ============================================================

-- ------------------------------------------------------------
-- LEDGER: the fee is a sixth item kind
-- Positive, like a sale — a fee is money IN. Only refunds are negative
-- (mirrors of an original, via refunds_transaction_id).
-- ------------------------------------------------------------

alter table transaction_items drop constraint transaction_items_kind_check;
alter table transaction_items add constraint transaction_items_kind_check
  check (kind in ('service', 'product', 'gift_card', 'tip', 'discount', 'late_cancellation_fee'));

comment on column transaction_items.kind is
  'service | product | gift_card | tip | discount | late_cancellation_fee. kind=service carries appointment + staff attribution; kind=tip carries staff attribution for payroll reads; kind=discount is negative; kind=gift_card is a liability sale, excluded from revenue reporting; kind=late_cancellation_fee is a POSITIVE line for the $50 fee charged to a card on file under the cancellation policy, with appointment attribution and no tax — revenue, but not service or retail revenue, so it stays out of the "services + retail" reporting sums by kind.';

-- ------------------------------------------------------------
-- SYSTEM STAFF: the actor for automated actions
-- ------------------------------------------------------------

-- One system row per organisation. staff.user_id is UNIQUE with NULLs
-- distinct (verified against the live schema before this migration), so
-- the rows' null user_id never collide; this index is what makes the
-- get-or-create below race-safe rather than merely single-threaded in
-- practice. Two concurrent first calls: one inserts, the other errors,
-- nothing duplicates.
create unique index staff_one_system_row_per_org
  on staff (organization_id) where email = 'system@thereserve.local';

create or replace function system_staff_id(p_organization_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from staff
   where organization_id = p_organization_id
     and email = 'system@thereserve.local';
  if v_id is null then
    insert into staff (organization_id, display_name, email, title, bookable, active)
    values (p_organization_id, 'The Reserve (system)', 'system@thereserve.local',
            'Automated actions', false, false)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function system_staff_id(uuid) is
  'Get-or-create the organisation''s system staff row: the actor for automated actions that need a staff reference (the late-cancellation fee''s transactions.checked_out_by, audit_log.actor_staff_id, and — to follow — form links issued by the scheduled jobs). Inactive, unbookable, no user_id, so it never appears in the directory, the scheduler or a login. Service-role only. Uniqueness is enforced by the partial index staff_one_system_row_per_org.';

revoke execute on function system_staff_id(uuid) from public, anon, authenticated;

-- Seed it for the organisations that exist, so the first fee does not
-- create it mid-transaction.
select system_staff_id(id) from organizations;
