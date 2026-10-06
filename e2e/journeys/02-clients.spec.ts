import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 2: a client's record, the way the front desk makes and keeps it.
// Create one through the sheet, find them in the list, open the profile,
// change a field there, and see the change survive a reload — which is
// the only proof that it was saved and not merely drawn.

test("the front desk creates a client, finds them, and a change on the profile survives a reload", async ({ page, context, data }) => {
  const desk = await data.staffMember("desk", "front_desk");
  await signIn(context, desk.email, desk.password);

  const firstName = "Avery";
  const lastName = data.tag; // unique to this run, so the search finds exactly one

  // Create, through the sheet.
  await page.goto("/clients");
  await page.getByRole("button", { name: "New client" }).click();
  await page.getByRole("textbox", { name: "First name" }).fill(firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(lastName);
  await page.getByRole("textbox", { name: "Email" }).fill(`avery-${data.run}@reserve.test`);
  await page.getByRole("button", { name: "Save client" }).click();

  // Find, through the search box, in the list the page re-read after saving.
  await page.getByRole("searchbox", { name: "Search name, email, phone…" }).fill(lastName);
  await expect(page.getByRole("link", { name: `${lastName}, ${firstName}` })).toBeVisible();

  // Open the profile.
  await page.getByRole("link", { name: `View ${firstName} ${lastName}` }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/);
  data.trackClient(page.url().split("/").pop()!);
  await expect(page.getByRole("heading", { name: `${firstName} ${lastName}` })).toBeVisible();

  // Edit a field on the profile: the communication channel, Email → SMS.
  const prefs = page.locator("[data-communication-prefs]");
  await expect(prefs.getByText("Email", { exact: true })).toBeVisible(); // the value before, so the change is a change
  await prefs.getByRole("button", { name: "Edit" }).click();
  await prefs.getByRole("radio", { name: "SMS" }).click();
  await prefs.getByRole("button", { name: "Save preferences" }).click();
  await expect(prefs.getByText("SMS", { exact: true })).toBeVisible();

  // Persisted, not just drawn: a fresh load reads it back from the database.
  await page.reload();
  await expect(page.getByRole("heading", { name: `${firstName} ${lastName}` })).toBeVisible();
  await expect(prefs.getByText("SMS", { exact: true })).toBeVisible();
  await expect(prefs.getByText("Email", { exact: true })).toHaveCount(0);
});
