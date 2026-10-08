import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 16: /financials needs BOTH financials.view_summary and
// transactions.view, on the nav and on the route (can.ts). A provider
// holds neither; the front desk holds transactions.view without the
// summary; a role made for the run holds the summary without the ledger
// read. All three are kept out; the admin, holding both, is let in —
// the positive case that keeps the others from being vacuous.

test("a person without both financials permissions sees no Financials entry and is sent home from /financials; one with both gets in", async ({ page, context, org }) => {
  const provider = await org.staffMember("provider", "provider");
  const desk = await org.staffMember("desk", "front_desk");
  const summaryOnly = await org.role("summary only", ["financials.view_summary"]);
  const analyst = await org.staffMember("analyst", { roleId: summaryOnly.id });
  const owner = await org.staffMember("owner", "admin");

  const keptOut = async (who: { email: string; password: string }, canCheckOut: boolean) => {
    await context.clearCookies();
    await signIn(context, who.email, who.password);
    await page.goto("/");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Financials" })).toHaveCount(0);
    await page.goto("/financials");
    await expect(page).not.toHaveURL(/\/financials/);
    await expect(page.getByRole("heading", { name: "Financials" })).toHaveCount(0);
    if (canCheckOut) {
      await page.goto("/checkout");
      await expect(page.getByRole("heading", { name: /checkout|new sale/i })).toBeVisible();
    }
  };
  await keptOut(provider, false);
  await keptOut(desk, true);
  await keptOut(analyst, false);

  await context.clearCookies();
  await signIn(context, owner.email, owner.password);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Financials" })).toBeVisible();
  await page.goto("/financials");
  await expect(page.getByRole("heading", { name: "Financials" })).toBeVisible();
});
