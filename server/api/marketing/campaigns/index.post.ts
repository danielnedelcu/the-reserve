import { serverSupabaseServiceRole } from "#supabase/server";
import type { Json } from "~~/shared/types/database";
import { loadAudience, requireAdmin } from "~~/server/utils/campaignAudience";
import { campaignBodies, parseAudienceFilter } from "~~/server/utils/campaigns";
import { sendMailDetailed } from "~~/server/utils/mailer";

/**
 * POST /api/marketing/campaigns   body: { subject, body, audience_filter }
 * The campaign send (marketing campaigns, phase 1 —
 * docs/design/marketing-campaigns-design.md).
 *
 * Admin + super_admin only. The sequence:
 *  1. Validate. `body` is the plain-text composition; both bodies are
 *     generated here (HTML shell + CAN-SPAM text fallback), never
 *     trusted from the client.
 *  2. Run the audience ONCE. This list is what is sent to; the preview
 *     the sender saw is not re-used, so an opt-out between preview and
 *     send is honoured.
 *  3. Insert the campaign as 'sending' with the recipient count.
 *  4. Per recipient, in sequence (Resend rate limits): mint an
 *     unsubscribe token, send with the link in the footer and a
 *     List-Unsubscribe header, and on acceptance insert the recipient
 *     row carrying Resend's message id — the key phase 2's webhook
 *     matches events by. A failed send is logged and skipped; one
 *     failure never aborts the campaign.
 *  5. Mark the campaign 'sent'.
 *
 * organization_id on every insert is the SESSION's org (requireAdmin),
 * never current_org_id() under the service role. Campaigns never write
 * communications_sent — that is the transactional trail.
 *
 * Synchronous on purpose: tens to low hundreds of recipients. The scale
 * trigger for a queued send is a synchronous run approaching Vercel's
 * function timeout; see the design doc.
 */
export default defineEventHandler(async (event) => {
  const { orgId, staffId } = await requireAdmin(event);
  const body = await readBody<{
    subject?: string;
    body?: string;
    audience_filter?: unknown;
  }>(event);

  const subject = body?.subject?.trim() ?? "";
  const composition = body?.body?.trim() ?? "";
  if (!subject || !composition) {
    throw createError({
      statusCode: 422,
      statusMessage: "A subject and a message are both required",
    });
  }
  if (subject.length > 200) {
    throw createError({ statusCode: 422, statusMessage: "Subject is too long" });
  }
  const filter = parseAudienceFilter(body?.audience_filter);
  if (filter === undefined) {
    throw createError({
      statusCode: 422,
      statusMessage: "audience_filter must be empty or { last_visit_months: 1 | 3 | 6 | 12 }",
    });
  }

  const admin = serverSupabaseServiceRole(event);
  const audience = await loadAudience(event, orgId, filter);
  if (!audience.length) {
    throw createError({
      statusCode: 422,
      statusMessage: "Nobody matches this audience — nothing to send",
    });
  }

  // Configured site URL in deployed environments; the request's origin
  // otherwise, so a link mailed from staging cannot point at production
  // (same reasoning as the cancel link).
  const base = useRuntimeConfig(event).public.siteUrl || getRequestURL(event).origin;
  // Stored bodies carry a placeholder where each recipient's own link goes.
  const stored = campaignBodies({ bodyPlain: composition, unsubscribeUrl: `${base}/unsubscribe/{token}` });

  const { data: campaign, error: campaignError } = await admin
    .from("campaigns")
    .insert({
      organization_id: orgId,
      subject,
      body_html: stored.html,
      body_text: stored.text,
      audience_filter: (filter as Json | null) ?? null,
      recipient_count: audience.length,
      sent_by: staffId,
      status: "sending",
    })
    .select("id")
    .single();
  if (campaignError || !campaign) {
    throw createError({
      statusCode: 500,
      statusMessage: campaignError?.message ?? "Could not create the campaign",
    });
  }

  let sent = 0;
  let failed = 0;
  for (const recipient of audience) {
    const { data: token, error: tokenError } = await admin
      .from("campaign_unsubscribe_tokens")
      .insert({
        campaign_id: campaign.id,
        client_id: recipient.id,
        organization_id: orgId,
      })
      .select("id")
      .single();
    if (tokenError || !token) {
      failed++;
      console.error(
        `[campaigns] token not minted for client ${recipient.id}:`,
        tokenError?.message,
      );
      continue;
    }
    const unsubscribeUrl = `${base}/unsubscribe/${token.id}`;
    const bodies = campaignBodies({ bodyPlain: composition, unsubscribeUrl });
    // TODO(sms): email-only; communication_channel is recorded but not
    // yet a delivery choice.
    const result = await sendMailDetailed({
      to: recipient.email!,
      subject,
      html: bodies.html,
      text: bodies.text,
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
    });
    if (!result.ok) {
      failed++;
      console.error(`[campaigns] send failed for client ${recipient.id}`);
      continue;
    }
    const { error: recipientError } = await admin.from("campaign_recipients").insert({
      campaign_id: campaign.id,
      client_id: recipient.id,
      organization_id: orgId,
      resend_message_id: result.id,
      sent_at: new Date().toISOString(),
    });
    if (recipientError) {
      console.error(
        `[campaigns] sent to client ${recipient.id} but recipient row not written:`,
        recipientError.message,
      );
    }
    sent++;
  }

  // 'sent' when at least one message left; 'failed' only when none did.
  const status = sent > 0 ? "sent" : "failed";
  await admin
    .from("campaigns")
    .update({ status, sent_at: new Date().toISOString() })
    .eq("id", campaign.id);

  return { id: campaign.id, status, recipientCount: audience.length, sent, failed };
});
