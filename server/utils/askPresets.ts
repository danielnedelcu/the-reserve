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
 */

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

  "clients.top_spenders_quarter": `
    select c.id as client_id, c.first_name, c.last_name,
           sum(t.total_cents) as spend_cents,
           count(*) as visits
      from transactions t
      join clients c on c.id = t.client_id
     where t.created_at >= date_trunc('quarter', now())
       and t.total_cents > 0
     group by c.id, c.first_name, c.last_name
     order by spend_cents desc
     limit 25`,

  "clients.new_this_month": `
    select id as client_id, first_name, last_name, email,
           created_at::date as joined_at
      from clients
     where created_at >= date_trunc('month', now())
     order by created_at desc`,

  // --- Schedule ------------------------------------------------------
  "schedule.today": `
    select a.starts_at, s.id as staff_id, s.display_name as provider,
           c.id as client_id, c.first_name, c.last_name, a.status
      from appointments a
      join staff s on s.id = a.staff_id
      join clients c on c.id = a.client_id
     where a.starts_at::date = current_date
       and a.status not in ('cancelled')
     order by a.starts_at`,

  "schedule.tomorrow_gaps": `
    select s.id as staff_id, s.display_name as provider, a.ends_at as gap_starts_at,
           lead(a.starts_at) over (partition by a.staff_id order by a.starts_at)
             as gap_ends_at
      from appointments a
      join staff s on s.id = a.staff_id
     where a.starts_at::date = current_date + 1
       and a.status not in ('cancelled','no_show')
     order by s.display_name, a.starts_at`,

  "schedule.no_shows_30": `
    select c.id as client_id, c.first_name, c.last_name,
           a.starts_at::date as missed_at,
           s.id as staff_id, s.display_name as provider
      from appointments a
      join clients c on c.id = a.client_id
      join staff s on s.id = a.staff_id
     where a.status = 'no_show'
       and a.starts_at >= now() - interval '30 days'
     order by a.starts_at desc`,

  // --- Financials ----------------------------------------------------
  // Gift card SALES are a liability, not revenue — excluded here, per
  // the money rules in docs/design/migration4a-design.md.
  "financials.revenue_this_month": `
    select ti.kind,
           sum(ti.total_cents) as revenue_cents,
           count(*) as line_items
      from transaction_items ti
      join transactions t on t.id = ti.transaction_id
     where t.created_at >= date_trunc('month', now())
       and ti.kind <> 'gift_card'
     group by ti.kind
     order by revenue_cents desc`,

  "financials.gift_cards_outstanding": `
    select code, initial_balance_cents, balance_cents,
           recipient_name, created_at::date as sold_at
      from gift_cards
     where active and balance_cents = initial_balance_cents
     order by created_at desc`,

  "financials.top_services_quarter": `
    select ti.name_snapshot as service,
           count(*) as times_sold,
           sum(ti.total_cents) as revenue_cents
      from transaction_items ti
      join transactions t on t.id = ti.transaction_id
     where ti.kind = 'service'
       and t.created_at >= date_trunc('quarter', now())
     group by ti.name_snapshot
     order by revenue_cents desc
     limit 25`,

  // --- Products ------------------------------------------------------
  "products.low_stock": `
    select name, sku, stock_quantity, price_cents
      from products
     where active and stock_quantity <= 5
     order by stock_quantity asc`,

  "products.best_sellers_quarter": `
    select p.name, sum(ti.quantity) as units_sold,
           sum(ti.total_cents) as revenue_cents
      from transaction_items ti
      join products p on p.id = ti.product_id
      join transactions t on t.id = ti.transaction_id
     where ti.kind = 'product'
       and t.created_at >= date_trunc('quarter', now())
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
  "staff.revenue_by_provider_month": `
    select s.id as staff_id, s.display_name as provider,
           sum(ti.total_cents) as revenue_cents,
           count(*) as services_performed
      from transaction_items ti
      join staff s on s.id = ti.staff_id
      join transactions t on t.id = ti.transaction_id
     where ti.kind = 'service'
       and t.created_at >= date_trunc('month', now())
     group by s.id, s.display_name
     order by revenue_cents desc`,

  "staff.busiest_this_week": `
    select s.id as staff_id, s.display_name as provider, count(*) as appointments
      from appointments a
      join staff s on s.id = a.staff_id
     where a.starts_at >= date_trunc('week', now())
       and a.starts_at < date_trunc('week', now()) + interval '7 days'
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
