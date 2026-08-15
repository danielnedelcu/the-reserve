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
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  if (!apiKey || !from) {
    console.warn(
      "[mailer] RESEND_API_KEY or MAIL_FROM not set — email not sent:",
      options.subject,
    );
    return false;
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
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error(`[mailer] Resend ${response.status}:`, detail);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[mailer] send failed:", error);
    return false;
  }
}
