import { periodDays, shiftPeriod, todayKey } from "../../apps/reserve/shared/time/period";
import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 6: the reporting period on /financials is the URL's, and its
// dates are the LOCATION's. The location is put in New York for the run
// while the browser runs in Los Angeles; the label the page shows must be
// the New York calendar, computed here from the same shared helper the
// page uses (periodDays, zone-free on keys; todayKey in the zone). The
// journey reads only: no transaction is created, which is the ledger's
// rule for journeys in this PR.

test("the period lives in the URL with the location's dates, survives a reload, and Back returns to the previous period", async ({ page, context, data }) => {
  await data.locationInZone("America/New_York");
  const owner = await data.staffMember("owner", "admin"); // financials.view_summary and transactions.view
  const today = todayKey("America/New_York");

  await signIn(context, owner.email, owner.password);
  await page.goto("/financials");
  await expect(page.getByRole("heading", { name: "Financials" })).toBeVisible();
  const label = page.locator("[data-range-label]");

  // The default: this month, no period in the URL.
  await expect(label).toHaveText(periodDays({ period: "month", anchor: today }).label);
  await expect(page).not.toHaveURL(/[?&]period=/);

  // Week: in the URL, and the label is the New York Sunday-start week.
  await page.getByRole("button", { name: "Week" }).click();
  await expect(page).toHaveURL(/[?&]period=week/);
  await expect(page).not.toHaveURL(/[?&]anchor=/); // today's anchor stays out of the address
  await expect(label).toHaveText(periodDays({ period: "week", anchor: today }).label);

  // Day: the New York date, which is not the browser's for part of every evening.
  await page.getByRole("button", { name: "Day" }).click();
  await expect(page).toHaveURL(/[?&]period=day/);
  await expect(label).toHaveText(periodDays({ period: "day", anchor: today }).label);

  // Reload: the same period from the address.
  await page.reload();
  await expect(page).toHaveURL(/[?&]period=day/);
  await expect(label).toHaveText(periodDays({ period: "day", anchor: today }).label);

  // Back: the previous period, the week.
  await page.goBack();
  await expect(page).toHaveURL(/[?&]period=week/);
  await expect(label).toHaveText(periodDays({ period: "week", anchor: today }).label);

  // Previous period: the anchor appears, a week earlier.
  await page.getByRole("button", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/[?&]anchor=\d{4}-\d{2}-\d{2}/);
  await expect(label).toHaveText(periodDays({ period: "week", anchor: shiftPeriod("week", today, -1) }).label);
});
