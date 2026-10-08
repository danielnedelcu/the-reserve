// Relative, not the ~~ alias: scripts/verify-presets.mjs loads this module with plain Node.
import { REFUND_PREFIX } from "../../shared/ledger/refund.ts";

/**
 * Ask The Reserve — the known-good query for each preset.
 *
 * The hybrid decision from the design: presets never touch the LLM.
 * They are instant, free, and cannot be wrong, which is what makes them
 * the right answer for the questions people actually ask most. The LLM
 * is the fallback for the long tail.
 *
 * Every query here runs through ask_execute_sql as ask_readonly, so RLS
 * still scopes results to the asking admin's org. These read like they
 * ignore the org because they can: the policies add that.
 *
 * Column aliases follow the rendering contract the same way the model is
 * asked to: `_cents` for money, `_at` for times, and `_id` selected
 * immediately BEFORE the label it identifies, so the name cell links
 * through to that record. The id is hidden from the table; it exists to
 * build the href. The presets are the known-good path, so they must model the
 * convention rather than be an exception to it.
 *
 * Ids must match shared/ask/presets.ts — an id present there and missing
 * here is a preset that would silently fall through to the LLM, which is
 * exactly the wrongness the hybrid exists to avoid.
 *
 * MONEY AND TIME (2026-10-08, docs/design/server-tables-design.md
 * decision 2): every money preset reads the ledger_lines /
 * ledger_transactions views, THE revenue definition — revenue_cents is
 * service + product lines, pre-tax, gross of discounts, net of refunds;
 * tips, fees, gift-card sales and discounts are their own columns — and
 * buckets on the views' local_day / local_week (Sunday start) /
 * local_month, each transaction's own location's calendar. "Now" for
 * "this month" is the organisation's location's zone (ZONE below). The
 * numbers are proven equal to transactions_page's totals for the same
 * window by scripts/verify-presets.mjs on the local stack. Nothing here
 * names a line kind for money; the view does.
 */

/** The organisation's location's zone, for "today / this week / this month", under RLS. */
const ZONE = `(select l.timezone from locations l order by l.created_at, l.id limit 1)`;
/** Today, this week (Sunday start) and this month as local dates in that zone. */
const TODAY = `((now() at time zone ${ZONE})::date)`;
const WEEK_START = `(date_trunc('week', (now() at time zone ${ZONE}) + interval '1 day')::date - 1)`;
const MONTH_START = `(date_trunc('month', now() at time zone ${ZONE})::date)`;
const QUARTER_START = `(date_trunc('quarter', now() at time zone ${ZONE})::date)`;

export const PRESET_SQL: Record<string, string> = {
  // --- Clients -------------------------------------------------------
  "clients.lapsed_90": `
    select c.id as client_id, c.first_name, c.last_name, c.email,
           max(a.starts_at)::date as last_visit_at
      from clients c
      join appointments a on a.client_id = c.id and a.status = 'completed'
     where c.active
     group by c.id, c.first_name, c.last_name, c.email
    having max(a.starts_at) < now() - interval '90 days'
     order by last_visit_at asc`,

  // Revenue (the definition), net of refunds through the mirror lines;
  // tips beside it, never inside it. Visits are non-refund transactions.
  "clients.top_spenders_quarter": `
    select c.id as client_id, c.first_name, c.last_name,
           sum(l.revenue_cents) as revenue_cents,
           sum(l.tips_cents) as tips_cents,
           count(distinct l.transaction_id) filter (where not l.is_refund) as visits
      from ledger_lines l
      join clients c on c.id = l.client_id
     where l.local_day >= ${QUARTER_START}
     group by c.id, c.first_name, c.last_name
     order by revenue_cents desc
     limit 25`,

  "clients.new_this_month": `
    select id as client_id, first_name, last_name, email,
           (created_at at time zone ${ZONE})::date as joined_at
      from clients
     where (created_at at time zone ${ZONE})::date >= ${MONTH_START}
     order by created_at desc`,

  // --- Schedule ------------------------------------------------------
  "schedule.today": `
    select a.starts_at, s.id as staff_id, s.display_name as provider,
           c.id as client_id, c.first_name, c.last_name, a.status
      from appointments a
      join staff s on s.id = a.staff_id
      join clients c on c.id = a.client_id
     where (a.starts_at at time zone ${ZONE})::date = ${TODAY}
       and a.status not in ('cancelled')
     order by a.starts_at`,

  "schedule.tomorrow_gaps": `
    select s.id as staff_id, s.display_name as provider, a.ends_at as gap_starts_at,
           lead(a.starts_at) over (partition by a.staff_id order by a.starts_at)
             as gap_ends_at
      from appointments a
      join staff s on s.id = a.staff_id
     where (a.starts_at at time zone ${ZONE})::date = ${TODAY} + 1
       and a.status not in ('cancelled','no_show')
     order by s.display_name, a.starts_at`,

  "schedule.no_shows_30": `
    select c.id as client_id, c.first_name, c.last_name,
           (a.starts_at at time zone ${ZONE})::date as missed_at,
           s.id as staff_id, s.display_name as provider
      from appointments a
      join clients c on c.id = a.client_id
      join staff s on s.id = a.staff_id
     where a.status = 'no_show'
       and a.starts_at >= now() - interval '30 days'
     order by a.starts_at desc`,

  // --- Financials ----------------------------------------------------
  // The same figures the /financials cards show, from the same
  // definition: revenue, its two halves, and the separate figures.
  "financials.revenue_this_month": `
    select sum(l.revenue_cents) as revenue_cents,
           sum(l.service_cents) as service_cents,
           sum(l.retail_cents) as retail_cents,
           sum(l.tips_cents) as tips_cents,
           sum(l.fees_cents) as fees_cents,
           sum(l.gift_cards_sold_cents) as gift_cards_sold_cents,
           sum(l.discount_cents) as discounts_cents,
           sum(l.tax_cents) as tax_cents
      from ledger_lines l
     where l.local_month = ${MONTH_START}`,

  // The liability: every ACTIVE card's balance (gift_card_liability's
  // definition), as a first row, then the cards that carry it.
  "financials.gift_cards_outstanding": `
    select card, cards, balance_cents, initial_balance_cents, recipient_name, sold_at
      from (
        select 'All active cards' as card, count(*) as cards, sum(balance_cents) as balance_cents,
               null::bigint as initial_balance_cents, null::text as recipient_name, null::date as sold_at, 0 as n
          from gift_cards where active
        union all
        select code, null::bigint, balance_cents, initial_balance_cents, recipient_name,
               (created_at at time zone ${ZONE})::date, 1
          from gift_cards where active and balance_cents > 0
      ) x
     order by n, balance_cents desc`,

  // A refund's mirror line is named `${REFUND_PREFIX}<service>` (the
  // shared constant the refund route writes): grouped back under the
  // service so its negative nets the original.
  "financials.top_services_quarter": `
    select regexp_replace(l.name_snapshot, '^${REFUND_PREFIX}', '') as service,
           count(*) filter (where not l.is_refund) as times_sold,
           sum(l.service_cents) as revenue_cents
      from ledger_lines l
     where l.kind = 'service'
       and l.local_day >= ${QUARTER_START}
     group by 1
     order by revenue_cents desc
     limit 25`,

  // --- Products ------------------------------------------------------
  "products.low_stock": `
    select name, sku, stock_quantity, price_cents
      from products
     where active and stock_quantity <= 5
     order by stock_quantity asc`,

  "products.best_sellers_quarter": `
    select p.name,
           sum(case when l.is_refund then -l.quantity else l.quantity end) as units_sold,
           sum(l.retail_cents) as revenue_cents
      from ledger_lines l
      join products p on p.id = l.product_id
     where l.kind = 'product'
       and l.local_day >= ${QUARTER_START}
     group by p.id, p.name
     order by units_sold desc
     limit 25`,

  "products.never_sold": `
    select p.name, p.sku, p.stock_quantity, p.price_cents
      from products p
     where p.active
       and not exists (
         select 1 from transaction_items ti
          where ti.product_id = p.id and ti.kind = 'product'
       )
     order by p.name`,

  // --- Staff ---------------------------------------------------------
  // The same figures as transactions_page's by_staff: service revenue
  // per provider, tips beside it.
  "staff.revenue_by_provider_month": `
    select s.id as staff_id, s.display_name as provider,
           sum(l.service_cents) as revenue_cents,
           sum(l.tips_cents) as tips_cents,
           count(*) filter (where l.kind = 'service' and not l.is_refund) as services_performed
      from ledger_lines l
      join staff s on s.id = l.staff_id
     where l.local_month = ${MONTH_START}
       and l.kind in ('service', 'tip')
     group by s.id, s.display_name
     order by revenue_cents desc`,

  "staff.busiest_this_week": `
    select s.id as staff_id, s.display_name as provider, count(*) as appointments
      from appointments a
      join staff s on s.id = a.staff_id
     where (a.starts_at at time zone ${ZONE})::date >= ${WEEK_START}
       and (a.starts_at at time zone ${ZONE})::date < ${WEEK_START} + 7
       and a.status not in ('cancelled','no_show')
     group by s.id, s.display_name
     order by appointments desc`,

  "staff.pending_time_off": `
    select s.id as staff_id, s.display_name as staff, ae.kind, ae.starts_at, ae.ends_at, ae.note
      from availability_exceptions ae
      join staff s on s.id = ae.staff_id
     where ae.status = 'requested'
     order by ae.starts_at`,
};
