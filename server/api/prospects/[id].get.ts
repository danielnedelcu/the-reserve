import { requirePermission } from "../../utils/requireUser";
import { parseFields } from "~~/shared/forms/fields";

/**
 * GET /api/prospects/:id
 * One prospect's submission, as the reviewer sees it.
 *
 * HEALTH ANSWERS ARE NOT FETCHED. Not filtered out downstream, not
 * returned and hidden by the UI — this route never asks for them. Approval
 * is a non-health decision, so the reviewing screen has no reason to hold
 * that data even momentarily. form_response_health's RLS would refuse a
 * front-desk caller anyway; not querying it means the same answer without
 * depending on that.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "forms.responses.view");
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing id" });

  const { data: prospect, error } = await client
    .from("prospect_intake")
    .select("id, first_name, last_name, email, phone, status, submitted_at, reviewed_at, reviewed_by")
    .eq("id", id)
    .maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!prospect) throw createError({ statusCode: 404, statusMessage: "Prospect not found" });

  const { data: response } = await client
    .from("form_responses")
    .select(
      "id, answers, consent_text, consented_at, submitted_at, form_versions(version, fields, form_definitions(name))",
    )
    .eq("prospect_intake_id", id)
    .maybeSingle();

  // Rendered against the version they ANSWERED, so a later publish cannot
  // relabel what someone said.
  const fields = response ? parseFields(response.form_versions.fields) : [];

  return {
    prospect,
    submission: response
      ? {
          id: response.id,
          formName: response.form_versions.form_definitions.name,
          version: response.form_versions.version,
          consentText: response.consent_text,
          consentedAt: response.consented_at,
          submittedAt: response.submitted_at,
          // Only the non-sensitive fields, paired with their answers.
          // Sensitive fields are omitted entirely rather than shown empty:
          // an empty row would advertise that there is something to see.
          answers: fields
            .filter((f) => !f.sensitive)
            .map((f) => ({
              key: f.key,
              label: f.label,
              value: (response.answers as Record<string, unknown>)[f.key] ?? null,
            })),
        }
      : null,
  };
});
