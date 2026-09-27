/**
 * The pure logic behind marketing campaigns, phase 1
 * (docs/design/marketing-campaigns-design.md). Everything that DECIDES —
 * who is in the audience, what the two bodies look like, whether a
 * token is well-formed — lives here so it can be unit-tested; the routes
 * do the I/O.
 *
 * The audience is computed in TypeScript over rows rather than in one
 * SQL statement because Supabase's query builder cannot express the
 * design doc's EXISTS-with-interval, and a database function would put
 * the predicate on the far side of the two-paths seam. The route fetches
 * the opted-in clients and the completed appointments since the cutoff,
 * and this module joins them. One implementation; the preview and the
 * send both call it.
 */

export const AUDIENCE_MONTHS = [1, 3, 6, 12] as const;

export interface AudienceFilter {
  last_visit_months: number;
}

/**
 * Parse the request's audience_filter. Null/undefined/{} = everyone
 * opted in. Returns undefined for anything malformed so the route can
 * 422 instead of quietly sending to everyone.
 */
export function parseAudienceFilter(
  input: unknown,
): AudienceFilter | null | undefined {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  if (!("last_visit_months" in o) || o.last_visit_months === null) return null;
  const n = o.last_visit_months;
  if (typeof n !== "number" || !(AUDIENCE_MONTHS as readonly number[]).includes(n)) {
    return undefined;
  }
  return { last_visit_months: n };
}

/** now minus N calendar months — the start of the recency window. */
export function recencyCutoff(months: number, now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export interface AudienceClient {
  id: string;
  email: string | null;
  first_name: string;
  last_name: string;
  communication_opted_in: boolean;
}

export interface AudienceAppointment {
  client_id: string;
  status: string;
  starts_at: string;
}

/**
 * The recipient list. Opted-in clients with an email address; with a
 * recency filter, only those with a COMPLETED appointment that started
 * on or after the cutoff. Sorted by last name then first name, as the
 * design's query orders it.
 */
export function buildAudience(input: {
  clients: readonly AudienceClient[];
  appointments: readonly AudienceAppointment[];
  filter: AudienceFilter | null;
  now: Date;
}): AudienceClient[] {
  let recent: Set<string> | null = null;
  if (input.filter) {
    const cutoff = recencyCutoff(input.filter.last_visit_months, input.now).getTime();
    recent = new Set(
      input.appointments
        .filter((a) => a.status === "completed" && Date.parse(a.starts_at) >= cutoff)
        .map((a) => a.client_id),
    );
  }
  return input.clients
    .filter((c) => c.communication_opted_in && !!c.email)
    .filter((c) => !recent || recent.has(c.id))
    .sort(
      (a, b) =>
        a.last_name.localeCompare(b.last_name) ||
        a.first_name.localeCompare(b.first_name),
    );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed token id; anything else is invalid before any lookup. */
export function isValidTokenId(token: unknown): token is string {
  return typeof token === "string" && UUID.test(token);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The two bodies from one plain-text composition. The HTML wraps the
 * text in a simple brand shell (paragraphs on blank lines, line breaks
 * within); the text is the composition as typed. BOTH end with the
 * unsubscribe line — the text version is what CAN-SPAM requires, and
 * the link must be in it, not only in the HTML.
 */
export function campaignBodies(input: {
  bodyPlain: string;
  unsubscribeUrl: string;
}): { html: string; text: string } {
  const plain = input.bodyPlain.replace(/\r\n/g, "\n").trim();
  const paragraphs = plain
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#ece3d0;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr><td align="center" style="padding-bottom:24px;">
          <p style="margin:0;font-size:20px;letter-spacing:5px;color:#3b2f1e;">THE RESERVE</p>
          <p style="margin:6px 0 0;font-size:10px;letter-spacing:4px;color:#7a6c54;">WELLNESS CLUB</p>
        </td></tr>
        <tr><td style="background-color:#faf7f0;border-radius:12px;padding:32px;color:#3b2f1e;font-size:15px;line-height:1.6;">
${paragraphs}
        </td></tr>
        <tr><td align="center" style="padding-top:20px;font-size:12px;color:#7a6c54;">
          You are receiving this because you opted in to news and offers from The Reserve.<br />
          <a href="${input.unsubscribeUrl}" style="color:#7a6c54;">Unsubscribe from promotional emails</a>.
          Appointment confirmations and reminders are not affected.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const text = `${plain}

--
You are receiving this because you opted in to news and offers from The Reserve.
Unsubscribe from promotional emails: ${input.unsubscribeUrl}
Appointment confirmations and reminders are not affected.
`;
  return { html, text };
}
