import { localToUtc, localDateKey } from "../../apps/reserve/shared/time/zone";
import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 9: the dashboard reads the LOCATION's clock. The location is in
// America/New_York and the browser in America/Los_Angeles
// (playwright.config.ts). An appointment at 12:30 AM New York time is
// 9:30 PM the previous day in Los Angeles, so a today card or week
// calendar on the browser's clock files it under yesterday and shows
// 9:30 PM; the location's clock shows it today, at 12:30 AM.
//
// And a date of birth is a DATE: stored "1990-05-03", it must read
// May 3, 1990 in that same browser, not May 2 (UTC midnight in the US).

const NY = "America/New_York";

test("the today card and the week calendar file a 12:30 AM appointment under the location's day, and a date of birth reads as stored", async ({ page, context, data }) => {
  const location = await data.locationInZone(NY);
  const provider = await data.staffMember("provider", "provider");
  const desk = await data.staffMember("desk", "front_desk");
  const service = await data.service("Massage", provider.id);
  const client = await data.client("Noor", undefined, { date_of_birth: "1990-05-03" });
  const today = localDateKey(new Date(), NY);
  await data.appointment({
    clientId: client.id,
    staffId: provider.id,
    locationId: location.id,
    serviceId: service.id,
    serviceName: service.name,
    startsAt: localToUtc(today, "00:30", NY),
  });

  await signIn(context, desk.email, desk.password);
  await page.goto("/");

  // The today card: the appointment is today's, at 12:30 AM.
  const todayCard = page.getByRole("region", { name: "Today's appointments" });
  await expect(todayCard).toContainText(`${client.firstName} ${client.lastName}`);
  await expect(todayCard).toContainText("12:30 AM");
  await expect(todayCard).not.toContainText("9:30 PM");

  // The week calendar opens on the location's today and lists it there.
  const week = page.getByRole("region", { name: "Week calendar" });
  await expect(week).toContainText("Today");
  await expect(week).toContainText(`${client.firstName} ${client.lastName}`);
  await expect(week).toContainText("12:30 AM – 1:30 AM");

  // The date of birth, as stored.
  await page.goto(`/clients/${client.id}`);
  await expect(page.getByText("May 3, 1990")).toBeVisible();
  await expect(page.getByText("May 2, 1990")).toHaveCount(0);
});
