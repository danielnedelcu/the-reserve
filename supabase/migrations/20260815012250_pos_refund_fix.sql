-- ============================================================
-- Migration: refund-aware stock trigger
-- npx supabase migration new pos_refund_fix
-- Refund transactions insert product items with NEGATIVE totals;
-- stock must restore instead of decrementing again.
-- ============================================================
create or replace function apply_product_sale()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'product' and new.product_id is not null then
    if new.total_cents >= 0 then
      update products
        set stock_quantity = greatest(stock_quantity - new.quantity, 0)
        where id = new.product_id;
    else
      update products
        set stock_quantity = stock_quantity + new.quantity
        where id = new.product_id;
    end if;
  end if;
  return new;
end $$;