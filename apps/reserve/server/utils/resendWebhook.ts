import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The pure logic behind the Resend webhook (marketing campaigns, phase 2
 * — docs/design/marketing-campaigns-design.md). Signature verification,
 * payload parsing, and the event → column routing all live here so they
 * can be unit-tested; the route does the I/O and always answers 200
 * once the signature is good.
 *
 * Resend signs webhooks through Svix: headers svix-id, svix-timestamp
 * and svix-signature; the secret is `whsec_<base64>`; the signed
 * content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the
 * base64-DECODED secret, base64-encoded; the header may carry several
 * space-separated `v1,<sig>` entries, any one of which may match.
 * Compared in constant time, with a timestamp tolerance against replay.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

/** The bytes to HMAC with, from a `whsec_…` (or bare base64) secret. */
export function svixSecretBytes(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

/** Sign the way Svix does. Used by the verifier's tests and by the local simulator. */
export function signSvix(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", svixSecretBytes(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
}

export function verifySvixSignature(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  const { id, timestamp, signature, rawBody } = input;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - ts) > (input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = Buffer.from(signSvix(input.secret, id, timestamp, rawBody));
  return signature
    .split(" ")
    .filter(Boolean)
    .some((entry) => {
      const [version, sig] = entry.split(",", 2);
      if (version !== "v1" || !sig) return false;
      const presented = Buffer.from(sig);
      return presented.length === expected.length && timingSafeEqual(presented, expected);
    });
}

export interface ResendEvent {
  type: string;
  emailId: string;
}

/** The two fields the route needs, or null when the payload lacks them. */
export function parseResendEvent(json: unknown): ResendEvent | null {
  const o = json as { type?: unknown; data?: { email_id?: unknown } } | null;
  if (!o || typeof o.type !== "string") return null;
  const emailId = o.data?.email_id;
  if (typeof emailId !== "string" || !emailId) return null;
  return { type: o.type, emailId };
}

export type EngagementColumn = "opened_at" | "clicked_at" | "unsubscribed_at";

export interface EventEffect {
  /** The recipient column this event stamps, if any. */
  column: EngagementColumn | null;
  /** Whether the client's communication_opted_in must be set false. */
  optOut: boolean;
  /** Whether the event is worth a log line even with no column (bounces). */
  log: boolean;
}

/**
 * Which event does what. A spam complaint is treated as an unsubscribe:
 * the person has said, as loudly as email allows, that they do not want
 * these. A bounce is a delivery failure, not a decision, so it is logged
 * and changes nothing. Everything else Resend sends (sent, delivered,
 * delayed…) is acknowledged and ignored.
 */
export function eventEffect(type: string): EventEffect {
  switch (type) {
    case "email.opened":
      return { column: "opened_at", optOut: false, log: false };
    case "email.clicked":
      return { column: "clicked_at", optOut: false, log: false };
    case "email.unsubscribed":
    case "email.complained":
      return { column: "unsubscribed_at", optOut: true, log: false };
    case "email.bounced":
      return { column: null, optOut: false, log: true };
    default:
      return { column: null, optOut: false, log: false };
  }
}

export interface RecipientTimestamps {
  opened_at: string | null;
  clicked_at: string | null;
  unsubscribed_at: string | null;
}

/**
 * The update to apply, or null when there is nothing to write. FIRST
 * event wins: a column already set is never overwritten, which is what
 * makes Resend's redeliveries harmless.
 */
export function recipientPatch(
  row: RecipientTimestamps,
  effect: EventEffect,
  now: Date,
): Partial<Record<EngagementColumn, string>> | null {
  if (!effect.column || row[effect.column]) return null;
  return { [effect.column]: now.toISOString() };
}
