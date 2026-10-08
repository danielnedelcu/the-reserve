import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { dollars, figureCard, ledgerOf } from "../support/money";
import { sandbox } from "../support/stripe";

// Journey 18 (@stripe): the fee engine's fourth outcome — a late
// cancellation CHARGED to the card on file, through the public cancel
// link, with Stripe's test mode. Money moves first (one PaymentIntent
// keyed to the token), then the ledger records the fee as a fee, not
// revenue. The decline branch leaves the appointment booked and the link
// live, with the server's words on the page.

const HOUR = 3_600_000;

test("a late cancellation with a card on file is charged once, recorded as a fee, and a declined card cancels nothing @stripe", { tag: "@stripe" }, async ({ page, context, org }) => {
  const stripe = await sandbox();
  const desk = await org.staffMember("desk", "front_desk");
  const owner = await org.staffMember("owner", "admin");
  const provider = await org.staffMember("provider", "provider");
  const service = await org.service("Facial", provider.id);
  const max = await org.client("Max", org.tag, { email: `max-${org.run}@reserve.test`, late_cancellation_waiver_used: true });
  const dee = await org.client("Dee", org.tag, { email: `dee-${org.run}@reserve.test`, late_cancellation_waiver_used: true });
  const maxCard = await org.savedCard(stripe, max.id, desk.id, "pm_card_visa");
  const deeCard = await org.savedCard(stripe, dee.id, desk.id, "pm_card_chargeCustomerFail"); // attaches; every charge declines
  const at = (hours: number) => new Date(Date.now() + hours * HOUR);
  const base = { staffId: provider.id, locationId: org.location.id, serviceId: service.id, serviceName: service.name, withCancelToken: true };
  const charged = await org.appointment({ ...base, clientId: max.id, startsAt: at(2) });
  const declined = await org.appointment({ ...base, clientId: dee.id, startsAt: at(3) });
  const status = async (id: string) => (await org.env.db.from("appointments").select("status").eq("id", id).single()).data?.status;

  // The charge: the page says what will happen, then it happens.
  await page.goto(`/cancel/${charged.tokenId}`);
  const fee = page.locator("div[role='status']");
  await expect(fee).toContainText("Late cancellation fee: $50.00");
  await expect(fee).toContainText(`will be charged to your card on file ending in ${maxCard.last4}`);
  await page.getByRole("button", { name: "Yes, cancel and charge $50.00" }).click();
  await expect(page.getByRole("heading", { name: "Your appointment is cancelled" })).toBeVisible();
  expect(await status(charged.id)).toBe("cancelled");

  // The ledger: one transaction, a fee line, a card payment carrying the intent.
  const ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(1);
  const feeTxn = ledger[0]!;
  expect(feeTxn.total_cents).toBe(5_000);
  expect(feeTxn.transaction_items.map((i) => [i.kind, i.total_cents, i.organization_id])).toEqual([["late_cancellation_fee", 5_000, org.orgId]]);
  const { data: payment } = await org.env.db.from("payments").select("method, amount_cents, stripe_payment_intent_id").eq("transaction_id", feeTxn.id).single();
  expect(payment?.method).toBe("stripe_card");
  expect(payment?.amount_cents).toBe(5_000);
  expect(payment?.stripe_payment_intent_id).toMatch(/^pi_/);

  // Stripe agrees: the intent succeeded for $50 on Max's customer, and it is the only one.
  const intent = await stripe.paymentIntents.retrieve(payment!.stripe_payment_intent_id!);
  expect(intent.status).toBe("succeeded");
  expect(intent.amount).toBe(5_000);
  expect(intent.customer).toBe(maxCard.customerId);
  expect(intent.metadata.reserve_reason).toBe("late_cancellation_fee");
  expect((await stripe.paymentIntents.list({ customer: maxCard.customerId })).data).toHaveLength(1);

  // The link is spent: a second visit cannot charge again.
  await page.goto(`/cancel/${charged.tokenId}`);
  await expect(page.getByRole("heading", { name: "This link cannot be opened" })).toBeVisible();
  expect((await stripe.paymentIntents.list({ customer: maxCard.customerId })).data).toHaveLength(1);
  expect(await ledgerOf(org)).toHaveLength(1);

  // The decline: nothing cancelled, nothing written, the link still live.
  await page.goto(`/cancel/${declined.tokenId}`);
  await expect(fee).toContainText(`ending in ${deeCard.last4}`);
  await page.getByRole("button", { name: "Yes, cancel and charge $50.00" }).click();
  await expect(page.getByRole("alert")).toContainText("We could not charge the card on file, so the appointment has not been cancelled");
  await expect(page.getByRole("heading", { name: "Cancel this appointment?" })).toBeVisible();
  expect(await status(declined.id)).not.toBe("cancelled");
  expect((await org.env.db.from("cancellation_tokens").select("used_at").eq("id", declined.tokenId!).single()).data?.used_at).toBeNull();
  expect(await ledgerOf(org)).toHaveLength(1);
  const deeIntents = (await stripe.paymentIntents.list({ customer: deeCard.customerId })).data;
  expect(deeIntents.map((i) => i.status)).not.toContain("succeeded");

  // /financials files the fee as a fee, outside revenue.
  await signIn(context, owner.email, owner.password);
  await page.goto("/financials");
  await expect(figureCard(page, "Fees")).toContainText(dollars(5_000));
  await expect(figureCard(page, "Revenue")).toContainText(dollars(0));
});
