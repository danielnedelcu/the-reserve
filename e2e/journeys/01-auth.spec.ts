import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 1: getting in. The login page itself, the redirect that keeps a
// signed-out visitor out of staff pages, and the nav that hides what a
// role may not use. Every later journey leans on the cookie handling this
// one proves: the first test signs in through the real form; the third
// signs in through support/auth.ts and must land on the same signed-in
// page, so a drift between the app's cookie name and the library's shows
// here as a login page, not somewhere downstream.

test("a staff member signs in through the login page and lands on the dashboard", async ({ page, data }) => {
  const staff = await data.staffMember("desk", "front_desk");

  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(staff.email);
  await page.getByRole("textbox", { name: "Password" }).fill(staff.password);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Today's appointments" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clients" })).toBeVisible();
});

test("a signed-out visit to a staff page is sent to the login page", async ({ page }) => {
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
});

test("the nav shows a permission's entry to a role that holds it and hides it from one that does not", async ({ page, context, data }) => {
  // Financials needs financials.view_summary: admin holds it, provider does
  // not. Not super_admin: a fresh stack has no staff at all, so a test
  // super_admin is the LAST active one and the last-super-admin trigger
  // refuses to remove it — the row would outlive the run.
  const owner = await data.staffMember("owner", "admin");
  await signIn(context, owner.email, owner.password);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today's appointments" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Financials" })).toBeVisible();

  await context.clearCookies();
  const provider = await data.staffMember("provider", "provider");
  await signIn(context, provider.email, provider.password);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today's appointments" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clients" })).toBeVisible(); // what they DO hold (non-vacuous)
  await expect(page.getByRole("link", { name: "Financials" })).toHaveCount(0);
});
