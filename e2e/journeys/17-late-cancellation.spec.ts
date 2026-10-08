import { expect, test } from "../support/fixtures";
import { ledgerOf } from "../support/money";

// Journey 17: the public cancel link, three of the fee engine's four
// outcomes without Stripe (docs/testing-design.md, "The money journeys" §2
// and §3; the charged outcome is the Stripe PR). The token is the one the
// booking route mints beside the appointment, written by the builder: the
// app mails through Resend's HTTP API, so no local mail catcher ever
// carries the link. No sign-in: the token is the only authorisation.

const HOUR = 3_600_000;

test("the cancel link: no fee outside the window; the first late cancellation waived; a later one uncollected with no card — and a used link cannot be opened", async ({ page, org }) => {
  const desk = await org.staffMember("desk", "front_desk"); // holds pos.checkout: the uncollected-fee notification goes to them
  const provider = await org.staffMember("provider", "provider");
  const service = await org.service("Facial", provider.id);
  const zoe = await org.client("Zoe", org.tag, { email: `zoe-${org.run}@reserve.test` });
  const max = await org.client("Max", org.tag, { email: `max-${org.run}@reserve.test`, late_cancellation_waiver_used: true });
  const at = (hours: number) => new Date(Date.now() + hours * HOUR);
  const base = { staffId: provider.id, locationId: org.location.id, serviceId: service.id, serviceName: service.name, withCancelToken: true };
  const early = await org.appointment({ ...base, clientId: zoe.id, startsAt: at(72) });
  const lateFirst = await org.appointment({ ...base, clientId: zoe.id, startsAt: at(2) });
  const lateAgain = await org.appointment({ ...base, clientId: max.id, startsAt: at(3) }); // a different hour: one provider, no double booking

  const cancelled = async (appointmentId: string) =>
    (await org.env.db.from("appointments").select("status").eq("id", appointmentId).single()).data?.status;

  // (a) Three days out: no fee.
  await page.goto(`/cancel/${early.tokenId}`);
  await expect(page.getByRole("heading", { name: "Cancel this appointment?" })).toBeVisible();
  const fee = page.locator("div[role='status']"); // the fee box; the route announcer is a status too
  await expect(fee).toContainText("No fee");
  await page.getByRole("button", { name: "Yes, cancel this appointment" }).click();
  await expect(page.getByRole("heading", { name: "Your appointment is cancelled" })).toBeVisible();
  expect(await cancelled(early.id)).toBe("cancelled");

  // (b) Two hours out, first offence: waived, and the waiver is spent.
  await page.goto(`/cancel/${lateFirst.tokenId}`);
  await expect(fee).toContainText("Late cancellation, waived as a courtesy");
  await page.getByRole("button", { name: "Yes, cancel this appointment" }).click();
  await expect(page.getByRole("heading", { name: "Your appointment is cancelled" })).toBeVisible();
  expect(await cancelled(lateFirst.id)).toBe("cancelled");
  expect((await org.env.db.from("clients").select("late_cancellation_waiver_used").eq("id", zoe.id).single()).data?.late_cancellation_waiver_used).toBe(true);

  // (c) Two hours out, waiver used, no card on file: the fee is owed, not charged.
  await page.goto(`/cancel/${lateAgain.tokenId}`);
  await expect(fee).toContainText("Late cancellation fee: $50.00");
  await expect(fee).toContainText("We do not have a card");
  await page.getByRole("button", { name: "Yes, cancel this appointment" }).click();
  await expect(page.getByRole("heading", { name: "Your appointment is cancelled" })).toBeVisible();
  expect(await cancelled(lateAgain.id)).toBe("cancelled");
  const { data: notices } = await org.env.db.from("notifications").select("kind, staff_id").eq("kind", "cancellation_fee_uncollected").eq("staff_id", desk.id);
  expect(notices).toHaveLength(1);

  // No outcome wrote a ledger row; every token is spent.
  expect(await ledgerOf(org)).toHaveLength(0);
  const { data: tokens } = await org.env.db.from("cancellation_tokens").select("used_at").eq("organization_id", org.orgId);
  expect(tokens?.map((t) => t.used_at !== null)).toEqual([true, true, true]);

  // A used link cannot be opened.
  await page.goto(`/cancel/${early.tokenId}`);
  await expect(page.getByRole("heading", { name: "This link cannot be opened" })).toBeVisible();
});
