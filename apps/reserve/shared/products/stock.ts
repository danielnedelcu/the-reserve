/**
 * ONE definition of "low stock", for the products page's amber badge and
 * for products_page's `stock = 'low'` filter. The database function
 * cannot import this file, so its `c_low_stock` is a COPY of this number
 * (supabase/migrations/20261006231831_server_tables_products.sql), and
 * scripts/verify-tables.mjs imports this constant and asserts the
 * function's boundary against it: a product AT the threshold is low, one
 * above it is not, zero is out and not low. Change either side without
 * the other and the harness fails.
 */
export const LOW_STOCK_THRESHOLD = 5;

export type StockLevel = "out" | "low" | "ok";

/** out = none left; low = 1 to the threshold; ok = above it. */
export function stockLevel(quantity: number): StockLevel {
  if (quantity <= 0) return "out";
  if (quantity <= LOW_STOCK_THRESHOLD) return "low";
  return "ok";
}
