import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TestData } from "./data";

/**
 * The money journeys' shared moves (docs/testing-design.md, "The money
 * journeys"): the checkout page driven as the front desk would, and the
 * ledger read back through the service role by the run's organisation —
 * so a page that looks right over wrong rows fails.
 */

export const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Pick the client on /checkout by typing their last name. */
export async function pickClient(page: Page, client: { firstName: string; lastName: string }): Promise<void> {
  const box = page.getByRole("combobox", { name: "Client (optional)" });
  await box.fill(client.lastName);
  await page.getByRole("option", { name: new RegExp(`^${client.lastName}, ${client.firstName}`) }).click();
  await expect(box).toHaveValue(`${client.lastName}, ${client.firstName}`);
}

/** Add a retail product to the cart by searching for it (once per unit). */
export async function addProduct(page: Page, product: { name: string }, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    const box = page.getByRole("combobox", { name: "Add retail product" });
    await box.fill(product.name);
    await page.getByRole("option", { name: new RegExp(`^${product.name}`) }).click();
    await expect(box).toHaveValue("");
  }
  await expect(page.getByText(product.name).first()).toBeVisible();
}

/** The Complete button names the total; clicking it is the Charge. */
export function completeButton(page: Page, totalCents: number) {
  return page.getByRole("button", { name: `Complete — ${dollars(totalCents)}` });
}

/** A card on /financials by its label ("Revenue", "Tax collected", …). */
export function figureCard(page: Page, label: string) {
  return page.locator("div.rounded-xl").filter({ has: page.locator("p", { hasText: new RegExp(`^${label}$`) }) });
}

/** The run's ledger, oldest first, with lines and payments. */
export async function ledgerOf(org: TestData) {
  const { data, error } = await org.env.db
    .from("transactions")
    .select("id, idempotency_key, subtotal_cents, tax_cents, total_cents, refunds_transaction_id, transaction_items(kind, name_snapshot, quantity, total_cents, organization_id), payments(method, amount_cents, reference, organization_id)")
    .eq("organization_id", org.orgId)
    .order("created_at");
  if (error) throw new Error(`ledger: ${error.message}`);
  return data ?? [];
}

export async function auditRows(org: TestData, action: string) {
  const { data } = await org.env.db.from("audit_log").select("organization_id, actor_staff_id, entity_id").eq("organization_id", org.orgId).eq("action", action);
  return data ?? [];
}
