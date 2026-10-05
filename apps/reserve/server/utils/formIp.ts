import { createHmac } from "node:crypto";
import type { H3Event } from "h3";

/**
 * Keyed hashing for public-form visitor IPs.
 *
 * Rate limiting needs exactly one property: the same IP produces the same
 * value inside this system, so attempts can be counted. It does NOT need
 * the IP back. An unsalted SHA-256 would provide both — the IPv4 space is
 * ~4 billion values, precomputable in full, so a plain digest of an IP is
 * plaintext-equivalent. These rows record visitors to a health-intake
 * page, so that difference matters.
 *
 * HMAC under a server-only secret keeps the counting property and drops
 * the reversibility. If the secret is missing the route REFUSES to serve:
 * falling back to a weaker hash would leave every test green while the
 * property silently disappeared, which is the failure shape CLAUDE.md
 * names.
 */

export function assertIpPepperConfigured(): void {
  const pepper = useRuntimeConfig().formIpPepper;
  if (typeof pepper !== "string" || pepper.length < 16) {
    throw createError({
      statusCode: 503,
      statusMessage:
        "Public form submission is not configured on this server (missing FORM_IP_PEPPER).",
    });
  }
}

/**
 * The client's address, as far as it can be trusted.
 *
 * `x-forwarded-for` is caller-controlled unless a proxy overwrites it, so
 * a determined attacker can spread themselves across fake addresses. That
 * is a known limit of IP rate limiting, not a bug here — the per-TOKEN
 * limit is the one that holds regardless, because a token cannot be
 * forged. The IP limit exists to blunt the cheap case.
 */
export function clientIp(event: H3Event): string {
  const forwarded = getRequestHeader(event, "x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || getRequestIP(event, { xForwardedFor: false }) || "unknown";
}

/** HMAC-SHA256 of an IP under the server secret. Call after asserting. */
export function hashIp(ip: string): string {
  const pepper = useRuntimeConfig().formIpPepper as string;
  return createHmac("sha256", pepper).update(ip).digest("hex");
}
