import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 3: booking. The front desk books an appointment through the
// dialog and sees it on the schedule.
//
// Every time this journey asserts is the LOCATION'S. The location is put
// in America/New_York for the run and the browser runs in
// America/Los_Angeles (playwright.config.ts), so a page that formats or
// positions by the browser clock shows 10:00 AM at the spa as 7:00 AM —
// and fails here, instead of passing because the two zones happened to
// agree. The provider's hours are 10:00–11:00 local, one 60-minute slot,
// so the only time the dialog can offer is 10:00 AM.

test("the front desk books an appointment through the dialog and sees it on the schedule at the location's time", async ({ page, context, data }) => {
  const location = await data.locationInZone("America/New_York");
  const provider = await data.staffMember("provider", "provider");
  const desk = await data.staffMember("desk", "front_desk");
  const service = await data.service("Facial", provider.id);
  await data.hours(provider.id, location.id, "10:00", "11:00");
  // The client sorts past the first thousand: 1,100 filler clients precede
  // them alphabetically. The booking dialog used to load every client and
  // was cut at max_rows, so this client could not be booked at all; the
  // picker now searches clients_page as the desk types.
  await data.clientsBulk(1_100);
  const client = await data.client("Blake", `Zz-${data.tag}`);

  await signIn(context, desk.email, desk.password);
  await page.goto("/schedule");
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
  // Tomorrow: the route offers no slot that has already started, and
  // 10:00 at the location may well be behind us by the time this runs.
  await page.getByRole("button", { name: "Next day" }).click();

  // The dialog: client, service, then the staff qualified for it.
  await page.getByRole("button", { name: "New appointment" }).click();
  const dialog = page.getByRole("dialog", { name: "New appointment" });
  await dialog.getByRole("combobox", { name: "Client" }).fill(client.lastName);
  await page.getByRole("option", { name: `${client.lastName}, ${client.firstName}` }).click();
  await expect(dialog.getByRole("combobox", { name: "Client" })).toHaveValue(`${client.lastName}, ${client.firstName}`);
  await dialog.getByRole("combobox", { name: "Service" }).click();
  await page.getByRole("option", { name: `${service.name} (60 min)` }).click();
  await dialog.getByRole("combobox", { name: "Staff" }).click();
  await page.getByRole("option", { name: provider.displayName }).click();
  await dialog.getByRole("button", { name: "Find available times" }).click();
  await expect(dialog.getByText("Available times", { exact: true })).toBeVisible();

  // The one slot, at the location's time.
  const slots = dialog.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ });
  await expect(slots).toHaveText(["10:00 AM"]);
  await slots.first().click();
  await expect(dialog).toBeHidden();

  // On the schedule: the provider's lane in the day view, at the location's time.
  const card = page.getByRole("button", { name: new RegExp(`${client.lastName}.*10:00 AM`) });
  await expect(card).toBeVisible();

  // The booking's audit row belongs to the organisation (audit_log_organization).
  const { data: audit } = await data.env.db.from("audit_log").select("organization_id, actor_staff_id").eq("action", "appointment.booked").eq("actor_staff_id", desk.id);
  expect(audit?.length).toBe(1);
  expect(audit?.[0]?.organization_id).toBe(data.orgId);

  // The booking route minted the cancellation token for this appointment —
  // the link in the confirmation email. The money journeys write that
  // token themselves (TestData.appointment withCancelToken); this is the
  // one place the route's own minting is asserted.
  const { data: booked } = await data.env.db.from("appointments").select("id").eq("client_id", client.id);
  expect(booked?.length).toBe(1);
  const { data: tokens } = await data.env.db.from("cancellation_tokens").select("organization_id, used_at").eq("appointment_id", booked![0]!.id);
  expect(tokens?.length).toBe(1);
  expect(tokens?.[0]?.organization_id).toBe(data.orgId);
  expect(tokens?.[0]?.used_at).toBeNull();
});
