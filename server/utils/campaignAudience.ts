import type { H3Event } from "h3";
import { serverSupabaseServiceRole } from "#supabase/server";
import {
  buildAudience,
  recencyCutoff,
  type AudienceClient,
  type AudienceFilter,
} from "./campaigns";

/**
 * The I/O half of the campaign audience (marketing campaigns, phase 1).
 * Both the preview and the send routes call loadAudience(), so the list
 * a sender previews and the list the send goes to come from one
 * function — the send still runs it fresh at send time, once.
 */

/**
 * Admin + super_admin gate for the marketing routes, plus the identity
 * the send needs. The org and staff id come from the SESSION — RPCs
 * through the user's own client — never from current_org_id() under
 * the service role, which is null there.
 */
export async function requireAdmin(event: H3Event) {
  const { client: userClient, user } = await requireUser(event);
  const [{ data: admin }, { data: orgId }, { data: staffId }] =
    await Promise.all([
      userClient.rpc("is_admin"),
      userClient.rpc("current_org_id"),
      userClient.rpc("current_staff_id"),
    ]);
  if (admin !== true || !orgId || !staffId) {
    throw createError({
      statusCode: 403,
      statusMessage: "Campaigns are for admins only",
    });
  }
  return { userClient, user, orgId, staffId };
}

/** Opted-in clients of the org, narrowed by the recency filter. */
export async function loadAudience(
  event: H3Event,
  orgId: string,
  filter: AudienceFilter | null,
  now = new Date(),
): Promise<AudienceClient[]> {
  const admin = serverSupabaseServiceRole(event);
  const { data: clients, error } = await admin
    .from("clients")
    .select("id, email, first_name, last_name, communication_opted_in")
    .eq("organization_id", orgId)
    .eq("active", true)
    .eq("communication_opted_in", true);
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message });
  }
  let appointments: { client_id: string; status: string; starts_at: string }[] = [];
  if (filter) {
    const { data, error: apptError } = await admin
      .from("appointments")
      .select("client_id, status, starts_at")
      .eq("organization_id", orgId)
      .eq("status", "completed")
      .gte("starts_at", recencyCutoff(filter.last_visit_months, now).toISOString());
    if (apptError) {
      throw createError({ statusCode: 500, statusMessage: apptError.message });
    }
    appointments = data ?? [];
  }
  return buildAudience({ clients: clients ?? [], appointments, filter, now });
}
