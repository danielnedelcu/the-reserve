import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 8: the command palette finds a client by searching the server as
// the person types. The client sorts past the first thousand, which the
// old palette — 500 clients preloaded, filtered locally — could not find.

test("the command palette finds a late-alphabet client by search and opens their record", async ({ page, context, data }) => {
  const desk = await data.staffMember("desk", "front_desk");
  await data.clientsBulk(1_100);
  const client = await data.client("Yusuf", `Zz-${data.tag}`, { phone: "555-0100" });

  await signIn(context, desk.email, desk.password);
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();

  await page.getByRole("button", { name: /^Search…/ }).click();
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.getByRole("textbox", { name: "Search clients, staff, pages…" }).fill(client.lastName);
  const hit = palette.getByRole("option", { name: new RegExp(`^${client.firstName} ${client.lastName}`) });
  await expect(hit).toContainText("555-0100"); // the contact beneath, telling same-named clients apart
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/clients/${client.id}$`));
});
