import { serverSupabaseServiceRole } from "#supabase/server";
import { requirePermission } from "../../../utils/requireUser";

/**
 * POST /api/prospects/:id/review
 * Body: { status: "under_review" | "approved" | "rejected" }
 *
 * THE SEAM. This route records a DECISION and creates nothing.
 *
 * There is deliberately no "create user" or "create client" here, and
 * adding one would be the single most damaging change available in this
 * feature. The state machine holds three events apart — approve (a record
 * decision), enroll (tier + card on file, the paid-membership gate), and
 * activate (the client account exists) — and a button that jumped from the
 * first to the third would mint members who never chose a tier or put a
 * card on file. That is the members-only invariant leaking through the
 * very screen meant to enforce it.
 *
 * Enrollment is §3 and owner-blocked on tier definitions. When it arrives
 * it is a SEPARATE action, taken with the prospect present and paying —
 * not a side effect of approving.
 */
const ALLOWED = ["under_review", "approved", "rejected"] as const;
type ReviewStatus = (typeof ALLOWED)[number];

export default defineEventHandler(async (event) => {
  const { client, user } = await requirePermission(event, "forms.responses.view");
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing id" });

  const body = await readBody<{ status?: string }>(event);
  if (!body?.status || !ALLOWED.includes(body.status as ReviewStatus)) {
    throw createError({
      statusCode: 400,
      statusMessage: `status must be one of: ${ALLOWED.join(", ")}`,
    });
  }
  const status = body.status as ReviewStatus;

  const { data: staffId } = await client.rpc("current_staff_id");
  if (!staffId) {
    throw createError({ statusCode: 403, statusMessage: "No staff identity in scope" });
  }

  const { data: before } = await client
    .from("prospect_intake")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!before) throw createError({ statusCode: 404, statusMessage: "Prospect not found" });

  // Update through the USER's client, so RLS is what authorises the write —
  // the service role appears below only for the audit row, which accepts no
  // authenticated inserts by design.
  const { data: updated, error } = await client
    .from("prospect_intake")
    .update({
      status,
      reviewed_by: staffId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, status, reviewed_at")
    .single();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  // `user` is DECODED JWT CLAIMS typed as a User: the auth id is the `sub`
  // claim, and `user.id` typechecks while being undefined at runtime. Both
  // accepted so a library change cannot reintroduce the NULL actor bug.
  const identity = user as unknown as { sub?: string; id?: string };

  const admin = serverSupabaseServiceRole(event);
  await admin.from("audit_log").insert({
    actor_staff_id: staffId,
    actor_user_id: identity.sub ?? identity.id ?? null,
    action: `prospect.${status}`,
    entity_type: "prospect_intake",
    entity_id: id,
    detail: {
      from_status: before.status,
      to_status: status,
      // Named explicitly so the log answers the question someone will
      // eventually ask of an approval: did this create an account?
      creates_account: false,
    },
  });

  return { prospect: updated };
});
