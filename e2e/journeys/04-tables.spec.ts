import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 4: the URL is the table's state (docs/design/server-tables-design.md).
// On /clients the front desk sorts and filters, the address carries both,
// a reload brings the same view back, and Back undoes the LAST change —
// the filter — while the sort stays. The search text is deliberately NOT
// in the URL (client names are sensitive); it survives the reload through
// this tab's session storage, which the journey proves on the way.

test("sort and filter live in the URL, survive a reload, and Back undoes the last filter change", async ({ page, context, data }) => {
  const desk = await data.staffMember("desk", "front_desk");
  await data.client("Ava");
  await data.client("Max");
  await data.client("Zoe");
  await data.client("Old", data.tag, { active: false });

  await signIn(context, desk.email, desk.password);
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();

  // The run's clients only: the search is this tab's, not the URL's.
  await page.getByRole("searchbox", { name: "Search name, email, phone…" }).fill(data.tag);
  const firstName = page.locator("tbody tr").first().getByRole("link", { name: new RegExp(`^${data.tag}, `) });
  await expect(firstName).toHaveText(`${data.tag}, Ava`); // name ascending, the default
  await expect(page).not.toHaveURL(/[?&]q=/);

  // Sort: a click on the Name header flips the default ascending to descending.
  await page.getByRole("button", { name: "Name" }).click();
  await expect(page).toHaveURL(/[?&]dir=desc/);
  await expect(firstName).toHaveText(`${data.tag}, Zoe`);
  await expect(page.getByRole("link", { name: `${data.tag}, Old` })).toHaveCount(0); // inactive, hidden by default

  // Filter: "Show inactive" is active=all in the URL.
  await page.getByRole("checkbox", { name: "Show inactive" }).check();
  await expect(page).toHaveURL(/[?&]active=all/);
  await expect(page).toHaveURL(/[?&]dir=desc/);
  await expect(page.getByRole("link", { name: `${data.tag}, Old` })).toBeVisible();

  // Reload: the same address, the same view — including the search, which
  // came back from session storage, not the URL.
  await page.reload();
  await expect(page).toHaveURL(/[?&]active=all/);
  await expect(page).toHaveURL(/[?&]dir=desc/);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.getByRole("searchbox", { name: "Search name, email, phone…" })).toHaveValue(data.tag);
  await expect(firstName).toHaveText(`${data.tag}, Zoe`);
  await expect(page.getByRole("link", { name: `${data.tag}, Old` })).toBeVisible();

  // Back: the filter goes, the sort stays.
  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]active=/);
  await expect(page).toHaveURL(/[?&]dir=desc/);
  await expect(page.getByRole("link", { name: `${data.tag}, Old` })).toHaveCount(0);
  await expect(firstName).toHaveText(`${data.tag}, Zoe`);
});
