import { requirePermission } from "../../utils/requireUser";
import { listDefinitions, formShapeError } from "../../utils/formEngine";

/**
 * GET /api/forms
 * Every form definition in the org, each with its newest published version.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "forms.manage");
  try {
    return { definitions: await listDefinitions(client) };
  } catch (error) {
    formShapeError(error);
  }
});
