// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  signSvix,
  verifySvixSignature,
  parseResendEvent,
  eventEffect,
  recipientPatch,
  type RecipientTimestamps,
} from "../../server/utils/resendWebhook";

const SECRET = "whsec_" + Buffer.from("a-32-byte-test-secret-for-svix!!").toString("base64");
const BODY = JSON.stringify({ type: "email.opened", data: { email_id: "abc" } });
const NOW = new Date("2026-09-27T12:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

describe("verifySvixSignature", () => {
  const good = () => ({
    secret: SECRET,
    id: "msg_1",
    timestamp: TS,
    signature: `v1,${signSvix(SECRET, "msg_1", TS, BODY)}`,
    rawBody: BODY,
    now: NOW,
  });

  it("accepts a correct v1 signature", () => {
    expect(verifySvixSignature(good())).toBe(true);
  });

  it("accepts when ANY of several space-separated entries matches", () => {
    const sig = signSvix(SECRET, "msg_1", TS, BODY);
    expect(
      verifySvixSignature({ ...good(), signature: `v1,bm90dGhpcw== v2,eA== v1,${sig}` }),
    ).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, a missing header, and a non-v1 entry", () => {
    expect(verifySvixSignature({ ...good(), secret: "whsec_" + Buffer.from("other").toString("base64") })).toBe(false);
    expect(verifySvixSignature({ ...good(), rawBody: BODY + " " })).toBe(false);
    expect(verifySvixSignature({ ...good(), signature: undefined })).toBe(false);
    expect(verifySvixSignature({ ...good(), id: undefined })).toBe(false);
    const sig = signSvix(SECRET, "msg_1", TS, BODY);
    expect(verifySvixSignature({ ...good(), signature: `v2,${sig}` })).toBe(false);
  });

  it("rejects a stale or future timestamp beyond the tolerance, and a garbage one", () => {
    const old = String(Number(TS) - 6 * 60);
    expect(
      verifySvixSignature({ ...good(), timestamp: old, signature: `v1,${signSvix(SECRET, "msg_1", old, BODY)}` }),
    ).toBe(false);
    const future = String(Number(TS) + 6 * 60);
    expect(
      verifySvixSignature({ ...good(), timestamp: future, signature: `v1,${signSvix(SECRET, "msg_1", future, BODY)}` }),
    ).toBe(false);
    expect(verifySvixSignature({ ...good(), timestamp: "soon" })).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("reads type and data.email_id, and rejects anything without both", () => {
    expect(parseResendEvent({ type: "email.opened", data: { email_id: "e1" } })).toEqual({
      type: "email.opened",
      emailId: "e1",
    });
    expect(parseResendEvent({ type: "email.opened", data: {} })).toBeNull();
    expect(parseResendEvent({ data: { email_id: "e1" } })).toBeNull();
    expect(parseResendEvent(null)).toBeNull();
    expect(parseResendEvent("nope")).toBeNull();
  });
});

describe("eventEffect — which event sets which field", () => {
  it("routes opens and clicks to their columns without touching opt-in", () => {
    expect(eventEffect("email.opened")).toEqual({ column: "opened_at", optOut: false, log: false });
    expect(eventEffect("email.clicked")).toEqual({ column: "clicked_at", optOut: false, log: false });
  });

  it("treats a complaint exactly like an unsubscribe", () => {
    expect(eventEffect("email.complained")).toEqual(eventEffect("email.unsubscribed"));
    expect(eventEffect("email.unsubscribed")).toEqual({ column: "unsubscribed_at", optOut: true, log: false });
  });

  it("logs a bounce and flips nothing; ignores everything else", () => {
    expect(eventEffect("email.bounced")).toEqual({ column: null, optOut: false, log: true });
    for (const t of ["email.sent", "email.delivered", "email.delivery_delayed", "something.new"]) {
      expect(eventEffect(t)).toEqual({ column: null, optOut: false, log: false });
    }
  });
});

describe("recipientPatch — idempotency", () => {
  const empty: RecipientTimestamps = { opened_at: null, clicked_at: null, unsubscribed_at: null };

  it("stamps a null column with now", () => {
    expect(recipientPatch(empty, eventEffect("email.opened"), NOW)).toEqual({
      opened_at: NOW.toISOString(),
    });
  });

  it("a second open does not overwrite the first timestamp", () => {
    const opened = { ...empty, opened_at: "2026-09-27T10:00:00.000Z" };
    expect(recipientPatch(opened, eventEffect("email.opened"), NOW)).toBeNull();
  });

  it("a click after an open stamps only clicked_at", () => {
    const opened = { ...empty, opened_at: "2026-09-27T10:00:00.000Z" };
    expect(recipientPatch(opened, eventEffect("email.clicked"), NOW)).toEqual({
      clicked_at: NOW.toISOString(),
    });
  });

  it("events with no column produce no patch", () => {
    expect(recipientPatch(empty, eventEffect("email.bounced"), NOW)).toBeNull();
    expect(recipientPatch(empty, eventEffect("email.delivered"), NOW)).toBeNull();
  });
});
