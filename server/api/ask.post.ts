import Anthropic from "@anthropic-ai/sdk";
import { serverSupabaseServiceRole } from "#supabase/server";
import { ASK_SYSTEM_PROMPT } from "../utils/askSchema";
import { PRESET_SQL } from "../utils/askPresets";
import { assertAskConfigured, executeAskQuery } from "../utils/askConnection";

/**
 * POST /api/ask — Ask The Reserve, phase 1 (text-to-SQL, read-only).
 *
 * Two paths behind one endpoint:
 *   preset  → known-good SQL from PRESET_SQL. No LLM, no tokens.
 *   free    → one Anthropic call turning question + schema into SELECT.
 *
 * The LLM call happens BEFORE execution and never after: the question and
 * the schema description go out, result rows never do. That is the whole
 * egress story for this feature, and it is deliberately categorical —
 * "client data never leaves the database" is worth more than prose
 * answers. The caption below is generated from the row shape instead.
 * Summarization is a v2 decision gated on an explicit BAA/egress review.
 *
 * Execution happens on a dedicated connection whose SESSION USER is
 * ask_readonly (SELECT on an allowlist, read-only, 10s timeout) — never
 * by switching roles inside the app's own privileged session. The asking
 * admin's identity is injected as request.jwt.claims, so RLS still
 * scopes every row to their organization and permissions.
 */

const ROW_LIMIT = 500;
const ASK_MODEL = "claude-opus-5";

/**
 * Rates in US dollars per million tokens, for the model above.
 *
 * Kept beside the call rather than in config on purpose: the cost written
 * to ask_queries is a SNAPSHOT priced at the moment the ask ran, so this
 * constant changing later must not retroactively alter what past asks
 * cost. Same reasoning as price snapshots on transaction_items.
 */
const RATES_PER_MTOK = {
  input: 5,
  output: 25,
  cacheRead: 0.5, // cached input bills at roughly a tenth
  cacheWrite: 6.25, // writing to the cache carries a small premium
};

/** What one model call cost and consumed. Null on the preset path. */
interface AskUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
}

/** Millionths of a dollar — cents would round a two-cent ask to nothing. */
function priceInMicros(u: Omit<AskUsage, "model" | "costMicros">): number {
  const dollars =
    (u.inputTokens * RATES_PER_MTOK.input +
      u.outputTokens * RATES_PER_MTOK.output +
      u.cacheReadTokens * RATES_PER_MTOK.cacheRead +
      u.cacheWriteTokens * RATES_PER_MTOK.cacheWrite) /
    1_000_000;
  return Math.round(dollars * 1_000_000);
}

interface AskBody {
  question?: string;
  presetId?: string;
  route?: string;
}

interface AskResponse {
  source: "preset" | "llm";
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  answer: string | null;
  truncated: boolean;
}

/**
 * A caption built from the result shape alone — no model involved, so no
 * rows leave the database to produce it. Deterministic by construction:
 * the same result always reads the same way.
 */
function buildCaption(
  rows: Record<string, unknown>[],
  columns: string[],
  truncated: boolean,
): string {
  if (!rows.length) return "No rows matched that question.";

  // A single number is the common shape for "how many" / "how much".
  if (rows.length === 1 && columns.length === 1) {
    const column = columns[0]!;
    const value = rows[0]![column];
    const label = column.replace(/_cents$/, "").replace(/_/g, " ");
    const formatted =
      typeof value === "number" && column.endsWith("_cents")
        ? new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(value / 100)
        : String(value ?? "—");
    return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${formatted}`;
  }

  const noun = rows.length === 1 ? "row" : "rows";
  return truncated
    ? `${rows.length} ${noun} (capped at ${ROW_LIMIT}).`
    : `${rows.length} ${noun}.`;
}

/** Asks Claude for one SELECT. Returns null when the question is unanswerable. */
async function generateSql(
  question: string,
  route: string | undefined,
): Promise<{ sql: string | null; reason: string | null; usage: AskUsage }> {
  const apiKey = useRuntimeConfig().anthropicApiKey;
  if (!apiKey) {
    throw createError({
      statusCode: 503,
      statusMessage: "Ask is not configured on this server (missing API key).",
    });
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: ASK_MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    // The schema prompt is long and identical on every ask — cache it.
    system: [
      {
        type: "text",
        text: ASK_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: "answer_with_sql",
        description:
          "Return the single SELECT statement that answers the question, or explain why it cannot be answered from the available tables.",
        input_schema: {
          type: "object",
          properties: {
            sql: {
              type: ["string", "null"],
              description:
                "One PostgreSQL SELECT (or WITH ... SELECT). Null if unanswerable.",
            },
            reason: {
              type: ["string", "null"],
              description:
                "When sql is null, one short sentence on what is missing. Otherwise null.",
            },
          },
          required: ["sql", "reason"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: "tool", name: "answer_with_sql" },
    messages: [
      {
        role: "user",
        content: route
          ? `The admin is on the ${route} page. Question: ${question}`
          : question,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw createError({
      statusCode: 422,
      statusMessage: "That question was declined. Try rephrasing it.",
    });
  }

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw createError({
      statusCode: 502,
      statusMessage: "Could not turn that into a query. Try rephrasing it.",
    });
  }

  const input = toolUse.input as { sql?: string | null; reason?: string | null };

  // Recorded even when the model declines: a decline still costs money, and
  // a spike in declines is exactly the kind of thing the meter should show.
  const counts = {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  };

  return {
    sql: input.sql ?? null,
    reason: input.reason ?? null,
    usage: { model: ASK_MODEL, ...counts, costMicros: priceInMicros(counts) },
  };
}

export default defineEventHandler(async (event): Promise<AskResponse> => {
  const { user, client } = await requirePermission(event, "ask.query");

  // serverSupabaseUser() returns DECODED JWT CLAIMS in this version of
  // @nuxtjs/supabase — the user id is `sub`, not `id`. The module types it
  // as a User object, so `user.id` typechecks while being undefined at
  // runtime; that produced claims with no `sub`, and RLS correctly answered
  // with zero rows. A silent wrong answer, which is the worst failure this
  // feature can have. Accept either shape so a library change can't
  // reintroduce it.
  const identity = user as unknown as { sub?: string; id?: string };
  const userId = identity.sub ?? identity.id;
  if (!userId) {
    throw createError({
      statusCode: 500,
      statusMessage: "Could not resolve the signed-in user.",
    });
  }

  // Fail closed before spending anything: both paths need this connection,
  // and the free-text path would otherwise pay for a generation first.
  assertAskConfigured();

  const body = await readBody<AskBody>(event);

  const presetId = body.presetId?.trim();
  const question = body.question?.trim();

  if (!presetId && !question) {
    throw createError({ statusCode: 400, statusMessage: "Ask a question first." });
  }
  if (question && question.length > 500) {
    throw createError({
      statusCode: 400,
      statusMessage: "That question is too long — try a shorter one.",
    });
  }

  const source: "preset" | "llm" = presetId ? "preset" : "llm";
  const startedAt = Date.now();

  let sql: string | null;
  let unanswerableReason: string | null = null;
  let usage: AskUsage | null = null;

  if (presetId) {
    sql = PRESET_SQL[presetId] ?? null;
    if (!sql) {
      throw createError({ statusCode: 400, statusMessage: "Unknown question." });
    }
  } else {
    const generated = await generateSql(question!, body.route);
    sql = generated.sql;
    unanswerableReason = generated.reason;
    usage = generated.usage;
  }

  // The model declined to invent a query. That is a good outcome, not an
  // error — report it as an answer with no rows.
  if (!sql) {
    await logAsk(event, {
      staffId: await currentStaffId(client),
      source,
      presetId: presetId ?? null,
      question: question ?? null,
      sql: null,
      rowCount: null,
      durationMs: Date.now() - startedAt,
      error: unanswerableReason ?? "No SQL generated",
      usage,
    });
    return {
      source,
      sql: null,
      columns: [],
      rows: [],
      answer:
        unanswerableReason ??
        "That question can't be answered from the data available here.",
      truncated: false,
    };
  }

  // Execute on the ask_readonly connection: session_user is the leash,
  // and the injected claims keep RLS scoped to this admin.
  const staffId = await currentStaffId(client);
  let execution;
  try {
    execution = await executeAskQuery(sql, userId, ROW_LIMIT);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logAsk(event, {
      staffId,
      source,
      presetId: presetId ?? null,
      question: question ?? null,
      sql,
      rowCount: null,
      durationMs: Date.now() - startedAt,
      error: message,
      usage,
    });
    // A 503 from the connection helper means Ask is unconfigured — let
    // that through rather than reporting it as a bad question.
    if (typeof error === "object" && error && "statusCode" in error) throw error;
    throw createError({
      statusCode: 400,
      statusMessage:
        source === "preset"
          ? "That question could not be answered right now."
          : "The generated query didn't run. Try rephrasing the question.",
    });
  }

  const { rows, columns, truncated } = execution;
  const durationMs = Date.now() - startedAt;

  await logAsk(event, {
    staffId,
    source,
    presetId: presetId ?? null,
    question: question ?? null,
    sql,
    rowCount: rows.length,
    durationMs,
    error: null,
    usage,
  });

  return {
    source,
    // Presets are human-written and reviewed; the affordance is for
    // generated SQL, which is the only kind an admin needs to audit.
    sql: source === "llm" ? sql : null,
    columns,
    rows,
    answer: buildCaption(rows, columns, truncated),
    truncated,
  };
});

/** The asking admin's staff row, for attribution on the log entry. */
async function currentStaffId(
  client: Awaited<ReturnType<typeof requirePermission>>["client"],
): Promise<string | null> {
  const { data } = await client.rpc("current_staff_id");
  return (data as string | null) ?? null;
}

/**
 * Writes the ask_queries row with the service role: the log has no
 * authenticated insert policy, because an entry the asker could forge
 * is not evidence.
 */
async function logAsk(
  event: Parameters<typeof serverSupabaseServiceRole>[0],
  entry: {
    staffId: string | null;
    source: "preset" | "llm";
    presetId: string | null;
    question: string | null;
    sql: string | null;
    rowCount: number | null;
    durationMs: number;
    error: string | null;
    /** Null on the preset path — no model was called. */
    usage: AskUsage | null;
  },
) {
  if (!entry.staffId) return;

  const admin = serverSupabaseServiceRole(event);
  const { data: staff } = await admin
    .from("staff")
    .select("organization_id")
    .eq("id", entry.staffId)
    .single();
  if (!staff) return;

  await admin.from("ask_queries").insert({
    organization_id: staff.organization_id,
    staff_id: entry.staffId,
    source: entry.source,
    preset_id: entry.presetId,
    question: entry.question,
    generated_sql: entry.sql,
    row_count: entry.rowCount,
    duration_ms: entry.durationMs,
    error: entry.error,
    model: entry.usage?.model ?? null,
    input_tokens: entry.usage?.inputTokens ?? null,
    output_tokens: entry.usage?.outputTokens ?? null,
    cache_read_tokens: entry.usage?.cacheReadTokens ?? null,
    cache_write_tokens: entry.usage?.cacheWriteTokens ?? null,
    cost_micros: entry.usage?.costMicros ?? null,
  });
}
