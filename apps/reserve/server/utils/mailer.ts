/**
 * Resend mailer — plain fetch, no SDK dependency.
 *
 * Env (server-only, .env):
 *   RESEND_API_KEY=re_...
 *   MAIL_FROM="The Reserve <hello@yourdomain.com>"
 *
 * Until a domain is verified in Resend, use MAIL_FROM="onboarding@resend.dev"
 * — Resend then only delivers to the account owner's own email address,
 * which is perfect for dev and useless for anyone else (by design).
 *
 * sendMail never throws: email is best-effort side-channel; the caller's
 * primary operation (invite created, appointment booked) must not fail
 * because delivery hiccupped. Failures are logged and returned as false.
 */
export async function sendMail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  return (await sendMailDetailed(options)).ok;
}

/**
 * The same send, returning what Resend said. `id` is Resend's message
 * id on acceptance — the key the marketing webhook (campaigns, phase 2)
 * matches events to recipients by, so campaign sends go through here
 * and store it. `text` is the plain-text alternative (required by
 * CAN-SPAM for campaigns), and `headers` carries List-Unsubscribe.
 * Never throws, same as sendMail.
 */
export async function sendMailDetailed(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
}): Promise<{ ok: true; id: string | null } | { ok: false }> {
  // Read at run time under NUXT_RESEND_API_KEY / NUXT_MAIL_FROM (nuxt.config).
  const config = useRuntimeConfig();
  const apiKey = config.resendApiKey;
  const from = config.mailFrom;

  if (!apiKey || !from) {
    console.warn(
      "[mailer] NUXT_RESEND_API_KEY or NUXT_MAIL_FROM not set — email not sent:",
      options.subject,
    );
    return { ok: false };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [options.to],
        subject: options.subject,
        html: options.html,
        ...(options.text ? { text: options.text } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error(`[mailer] Resend ${response.status}:`, detail);
      return { ok: false };
    }
    const body = (await response.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: body?.id ?? null };
  } catch (error) {
    console.error("[mailer] send failed:", error);
    return { ok: false };
  }
}
