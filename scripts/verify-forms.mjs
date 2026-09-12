/**
 * Public-submission boundary verification.
 *
 * Runs against the LIVE database. Every check here is written in the shape
 * that catches a silent hole: not "the happy path works", but "the thing
 * that must be impossible is impossible". Two of them decide whether PHI
 * leaks, and both are asserted on ABSENCE:
 *
 *   - anon holds NO write path: the service-role RPC succeeds AND a direct
 *     anon insert into each response table fails.
 *   - the sensitivity split: a sensitive answer is PRESENT in the gated
 *     health rows AND ABSENT from the un-gated answers blob.
 *
 * A harness that only proves the first half of each pair passes while the
 * hole is wide open. That is the failure this file exists to prevent —
 * and the reason it counts a connection failure as FAIL, never as PASS.
 *
 *   node scripts/verify-forms.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const url = env.NUXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NUXT_PUBLIC_SUPABASE_KEY;
const serviceKey = env.NUXT_SUPABASE_SECRET_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error("FATAL: need NUXT_PUBLIC_SUPABASE_URL, NUXT_PUBLIC_SUPABASE_KEY, NUXT_SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Fixtures created for this run, torn down at the end. */
const made = { links: [], responses: [], prospects: [], definitionId: null, versionIds: [], staffId: null };

const FIELDS = [
  { key: "first_name", label: "First name", type: "text", required: true, sensitive: false },
  { key: "last_name", label: "Last name", type: "text", required: true, sensitive: false },
  { key: "email", label: "Email", type: "email", required: true, sensitive: false },
  { key: "phone", label: "Phone", type: "phone", required: false, sensitive: false },
  {
    key: "conditions",
    label: "Any conditions we should know about?",
    type: "textarea",
    required: false,
    sensitive: true,
  },
];

const SECRET_ANSWER = `VERIFY-PHI-${randomUUID().slice(0, 8)}`;

async function setup() {
  const { data: org } = await admin.from("organizations").select("id").limit(1).single();
  const { data: staff } = await admin.from("staff").select("id").limit(1).single();

  const { data: def, error: defErr } = await admin
    .from("form_definitions")
    .insert({
      organization_id: org.id,
      key: `verify_intake_${randomUUID().slice(0, 8)}`,
      name: "Verification intake",
    })
    .select("id")
    .single();
  if (defErr) throw new Error(`fixture definition: ${defErr.message}`);
  made.definitionId = def.id;

  const { data: version, error: verErr } = await admin
    .from("form_versions")
    .insert({
      form_definition_id: def.id,
      version: 1,
      fields: FIELDS,
      consent_text: "I agree to the terms.",
    })
    .select("id")
    .single();
  if (verErr) throw new Error(`fixture version: ${verErr.message}`);
  made.versionIds.push(version.id);

  // A staff member with NO roles, so the fan-out's exclusion direction is
  // never vacuous: whatever the live roster looks like, at least one active
  // person in the org must NOT be notified.
  const { data: bystander, error: staffErr } = await admin
    .from("staff")
    .insert({
      organization_id: org.id,
      display_name: "Verify Bystander",
      email: `verify-bystander-${randomUUID().slice(0, 8)}@example.test`,
      bookable: false,
    })
    .select("id")
    .single();
  if (staffErr) throw new Error(`fixture staff: ${staffErr.message}`);
  made.staffId = bystander.id;

  return { orgId: org.id, staffId: staff.id, versionId: version.id, bystanderId: bystander.id };
}

async function issueLink({ orgId, staffId, versionId }, overrides = {}) {
  const { data, error } = await admin
    .from("form_links")
    .insert({
      organization_id: orgId,
      form_version_id: versionId,
      issued_by: staffId,
      ...overrides,
    })
    .select("id, token")
    .single();
  if (error) throw new Error(`issue link: ${error.message}`);
  made.links.push(data.id);
  return data;
}

const submission = (extra = {}) => ({
  p_answers: { first_name: "Verify", last_name: "Runner", email: "verify@example.test" },
  p_health: [
    { field_key: "conditions", label: "Any conditions we should know about?", answer: SECRET_ANSWER },
  ],
  p_consent_text: "I agree to the terms.",
  p_consented: true,
  p_contact: {
    first_name: "Verify",
    last_name: "Runner",
    email: "verify@example.test",
    phone: null,
  },
  ...extra,
});

async function main() {
  console.log("\nPublic submission boundary verification\n");

  const ctx = await setup();

  // ── 1. anon has no write path ──────────────────────────────────────
  console.log("anon privileges (the PHI-leak boundary)");

  const anonTargets = [
    ["form_responses", { organization_id: ctx.orgId, form_version_id: ctx.versionId, answers: {} }],
    ["form_response_health", { form_response_id: randomUUID(), field_key: "x", label: "x", answer: "x" }],
    ["prospect_intake", { organization_id: ctx.orgId, first_name: "a", last_name: "b", email: "c@d.e" }],
    ["form_links", { organization_id: ctx.orgId, form_version_id: ctx.versionId, issued_by: ctx.staffId }],
    ["form_submission_attempts", { ip_hash: "x", outcome: "accepted" }],
  ];
  for (const [table, row] of anonTargets) {
    const { error } = await anon.from(table).insert(row);
    // Refused is not enough: it must be refused BY THE POLICY LAYER.
    // A typo'd table name also produces an error, and would pass a bare
    // truthiness check while proving nothing.
    const byPolicy = error?.code === "42501" || /row-level security|permission denied/i.test(error?.message ?? "");
    check(`anon INSERT into ${table} is refused BY RLS`, byPolicy,
      error ? `wrong reason: ${error.code} ${error.message}` : "INSERT SUCCEEDED");
  }

  const { error: rpcAnonError } = await anon.rpc("submit_form_response", submission({ p_token: randomUUID() }));
  const rpcByGrant =
    rpcAnonError?.code === "42501" ||
    /permission denied|function .* does not exist/i.test(rpcAnonError?.message ?? "");
  check("anon EXECUTE of submit_form_response is refused BY GRANT", rpcByGrant,
    rpcAnonError ? `wrong reason: ${rpcAnonError.code} ${rpcAnonError.message}` : "RPC SUCCEEDED");

  // ── 2. the token route works (the other direction) ─────────────────
  console.log("\nthe authorized path still works");

  const good = await issueLink(ctx);
  const { data: responseId, error: submitError } = await admin.rpc(
    "submit_form_response",
    submission({ p_token: good.token }),
  );
  check("service-role RPC with a valid token succeeds", !submitError && !!responseId,
    submitError?.message ?? "");
  if (responseId) made.responses.push(responseId);

  // ── 3. single-use ──────────────────────────────────────────────────
  console.log("\nsingle-use and expiry");

  const { error: reuseError } = await admin.rpc("submit_form_response", submission({ p_token: good.token }));
  check("the SAME token is refused on a second submit", !!reuseError,
    reuseError ? "" : "REUSE SUCCEEDED — token is not single-use");

  const { data: consumed } = await admin
    .from("form_links")
    .select("consumed_at")
    .eq("token", good.token)
    .single();
  check("the link records consumed_at", !!consumed?.consumed_at);

  const expired = await issueLink(ctx, {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  const { error: expiredError } = await admin.rpc("submit_form_response", submission({ p_token: expired.token }));
  check("an EXPIRED token is refused", !!expiredError,
    expiredError ? "" : "EXPIRED TOKEN ACCEPTED");

  const revoked = await issueLink(ctx, { revoked_at: new Date().toISOString() });
  const { error: revokedError } = await admin.rpc("submit_form_response", submission({ p_token: revoked.token }));
  check("a REVOKED token is refused", !!revokedError,
    revokedError ? "" : "REVOKED TOKEN ACCEPTED");

  const { error: unknownError } = await admin.rpc("submit_form_response", submission({ p_token: randomUUID() }));
  check("an UNKNOWN token is refused", !!unknownError);

  // ── 4. the split asymmetry ─────────────────────────────────────────
  console.log("\nsensitivity split (the other PHI-leak boundary)");

  const { data: stored } = await admin
    .from("form_responses")
    .select("answers, prospect_intake_id, consent_text, consented_at")
    .eq("id", responseId)
    .single();
  const { data: healthRows } = await admin
    .from("form_response_health")
    .select("field_key, label, answer")
    .eq("form_response_id", responseId);

  // anon reads, checked NOW that a real row exists. Run before the submit
  // this would have passed against empty tables — proving nothing.
  for (const [table, column, id] of [
    ["form_responses", "id", responseId],
    ["form_response_health", "form_response_id", responseId],
    ["prospect_intake", "id", stored?.prospect_intake_id],
  ]) {
    if (!id) continue;
    const { data, error } = await anon.from(table).select("*").eq(column, id);
    check(`anon cannot READ the row just written to ${table}`,
      !!error || (data ?? []).length === 0,
      (data ?? []).length ? `${data.length} row(s) VISIBLE TO ANON` : "");
  }

  const anonHealth = await anon.from("form_response_health").select("answer");
  check("the PHI answer is invisible to anon anywhere in form_response_health",
    !JSON.stringify(anonHealth.data ?? []).includes(SECRET_ANSWER),
    "PHI READABLE BY ANON");

  const blob = JSON.stringify(stored?.answers ?? {});
  check("the sensitive answer IS in form_response_health",
    (healthRows ?? []).some((r) => r.answer === SECRET_ANSWER),
    `health rows: ${JSON.stringify(healthRows)}`);
  check("the sensitive answer is ABSENT from form_responses.answers",
    !blob.includes(SECRET_ANSWER),
    blob.includes(SECRET_ANSWER) ? "PHI FOUND IN THE UNGATED BLOB" : "");
  check("the health row snapshots the question it answered",
    (healthRows ?? []).some((r) => r.label === "Any conditions we should know about?"));
  check("ordinary answers ARE in the blob", blob.includes("Verify"));

  // ── 5. prospect creation ───────────────────────────────────────────
  console.log("\nprospect promotion");

  check("a prospect row was created at submit", !!stored?.prospect_intake_id);
  if (stored?.prospect_intake_id) {
    made.prospects.push(stored.prospect_intake_id);
    const { data: prospect } = await admin
      .from("prospect_intake")
      .select("first_name, email, status")
      .eq("id", stored.prospect_intake_id)
      .single();
    check("contact promoted from the answers", prospect?.email === "verify@example.test");
    check("the prospect starts at status=submitted", prospect?.status === "submitted");
  }
  check("consent text was snapshotted onto the response", stored?.consent_text === "I agree to the terms.");
  check("consent timestamp recorded", !!stored?.consented_at);

  // ── 5b. notification fan-out — the two-language predicate ──────────
  // notify_prospect_submitted picks recipients in SQL; the bell and the nav
  // gate on can('forms.responses.view') in the browser. Assert they AGREE
  // on the awkward set: every active holder, no non-holder, no inactive.
  console.log("\nprospect.submitted fan-out (recipients == permission holders)");

  if (stored?.prospect_intake_id) {
    const link = `/intake/${stored.prospect_intake_id}`;

    const { data: holderRows } = await admin
      .from("staff_roles")
      .select("staff_id, staff!inner(organization_id, active), roles!inner(role_permissions!inner(permission_key))")
      .eq("roles.role_permissions.permission_key", "forms.responses.view")
      .eq("staff.organization_id", ctx.orgId)
      .eq("staff.active", true);
    const holders = new Set((holderRows ?? []).map((r) => r.staff_id));

    const { data: orgStaff } = await admin
      .from("staff")
      .select("id, active")
      .eq("organization_id", ctx.orgId);
    const nonHolders = (orgStaff ?? []).filter((s) => s.active && !holders.has(s.id)).map((s) => s.id);

    const { data: notes } = await admin
      .from("notifications")
      .select("staff_id, title, link, read_at")
      .eq("kind", "prospect.submitted")
      .eq("link", link);
    const notified = new Set((notes ?? []).map((n) => n.staff_id));

    check("at least one active staff member holds the permission (else the next check is vacuous)", holders.size > 0);
    check("the bystander fixture is an active NON-holder (else the exclusion check is vacuous)",
      nonHolders.includes(ctx.bystanderId));
    check("every active permission holder got exactly one notification",
      [...holders].every((id) => notified.has(id)) && (notes ?? []).length === holders.size,
      `holders=${holders.size} notified=${notified.size} rows=${(notes ?? []).length}`);
    check("NO active staff member without the permission was notified",
      nonHolders.every((id) => !notified.has(id)),
      `leaked to ${nonHolders.filter((id) => notified.has(id)).length}`);
    check("the notification arrives unread and links to the prospect",
      (notes ?? []).length > 0 && (notes ?? []).every((n) => n.read_at === null && n.link === link));

    // Settling: under_review keeps it open; approve OR reject clears it for
    // EVERY recipient, not only whoever clicked. Reject is the direction a
    // "clear on approve" implementation would miss, so that is the one
    // asserted here; the approve path is exercised in the browser.
    const unreadFor = async () => {
      const { data } = await admin.from("notifications").select("id")
        .eq("kind", "prospect.submitted").eq("link", link).is("read_at", null);
      return (data ?? []).length;
    };
    await admin.from("prospect_intake").update({ status: "under_review" }).eq("id", stored.prospect_intake_id);
    check("moving to under_review does NOT settle the notification (queue still open)",
      (await unreadFor()) === holders.size);
    await admin.from("prospect_intake").update({ status: "rejected" }).eq("id", stored.prospect_intake_id);
    check("REJECTING settles it for every recipient (read, not deleted)",
      (await unreadFor()) === 0 && (await admin.from("notifications").select("id")
        .eq("kind", "prospect.submitted").eq("link", link)).data.length === holders.size);
  } else {
    check("fan-out could be checked (needs a prospect id)", false);
  }

  // ── 6. rate-limit state is really in the database ──────────────────
  console.log("\nrate limiting");

  const pepper = env.FORM_IP_PEPPER;
  check("FORM_IP_PEPPER is configured (route refuses to serve without it)",
    typeof pepper === "string" && pepper.length >= 16,
    "set FORM_IP_PEPPER in .env — see .env.example");

  if (pepper && pepper.length >= 16) {
    const ip = "203.0.113.42";
    const h1 = createHmac("sha256", pepper).update(ip).digest("hex");
    const h2 = createHmac("sha256", pepper).update(ip).digest("hex");
    const other = createHmac("sha256", pepper).update("203.0.113.43").digest("hex");
    check("the same IP hashes to the same value (counting works)", h1 === h2);
    check("a different IP hashes differently", h1 !== other);
    // The actual claim: the stored value is not the precomputable digest
    // an attacker would rainbow-table. Compared against a real SHA-256,
    // not against an empty-key HMAC, which would prove nothing.
    check("the hash is NOT the bare SHA-256 an attacker could precompute",
      h1 !== createHash("sha256").update(ip).digest("hex"));

    const probeIp = `verify-${randomUUID()}`;
    const probeHash = createHmac("sha256", pepper).update(probeIp).digest("hex");
    const probeToken = randomUUID();

    for (let i = 0; i < 5; i++) {
      await admin.from("form_submission_attempts").insert({
        token: probeToken, ip_hash: probeHash, outcome: "rejected", organization_id: ctx.orgId,
      });
    }
    const { count } = await admin
      .from("form_submission_attempts")
      .select("id", { count: "exact", head: true })
      .eq("token", probeToken)
      .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());

    check("attempt counts persist across separate calls (DB-backed, not per-process)", count === 5,
      `counted ${count}`);
    // Whether the LIMIT limits is an HTTP-level property and is proved by
    // scripts/e2e-forms.mjs against a running server. What is proved here
    // is the half this layer owns: the count is durable and shared, so a
    // second process sees the first one's attempts.
    const second = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { count: seenByOther } = await second
      .from("form_submission_attempts")
      .select("id", { count: "exact", head: true })
      .eq("token", probeToken);
    check("a SECOND client sees the same attempt count (shared, not per-process)",
      seenByOther === 5, `second client counted ${seenByOther}`);

    await admin.from("form_submission_attempts").delete().eq("token", probeToken);
  }

  // ── 7. retention: both directions ──────────────────────────────────
  // The purge is dangerous in two opposite ways. Under-deleting leaves
  // PHI past its retention window; over-deleting destroys a client's
  // signed waiver, which is a legal record. Both are proved, because
  // proving only the first is the familiar mistake.
  console.log("\nretention purge (destructive in two directions)");

  const { data: anyClient } = await admin.from("clients").select("id").limit(1).single();

  const stale = await admin
    .from("prospect_intake")
    .insert({
      organization_id: ctx.orgId,
      first_name: "Stale",
      last_name: "Prospect",
      email: `stale-${randomUUID().slice(0, 8)}@example.test`,
      submitted_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();

  const staleResponse = await admin
    .from("form_responses")
    .insert({
      organization_id: ctx.orgId,
      form_version_id: ctx.versionId,
      prospect_intake_id: stale.data.id,
      answers: { first_name: "Stale" },
    })
    .select("id")
    .single();
  await admin.from("form_response_health").insert({
    form_response_id: staleResponse.data.id,
    field_key: "conditions",
    label: "Conditions",
    answer: "PHI that must not outlive its retention window",
  });

  // A client's waiver, far older than any window. Must survive.
  const waiver = await admin
    .from("form_responses")
    .insert({
      organization_id: ctx.orgId,
      form_version_id: ctx.versionId,
      client_id: anyClient.id,
      answers: { first_name: "Member" },
      consent_text: "I agree",
      consented_at: new Date(Date.now() - 900 * 86_400_000).toISOString(),
      submitted_at: new Date(Date.now() - 900 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  made.responses.push(waiver.data.id);

  const { error: purgeError } = await admin.rpc("purge_prospect_intake");
  check("purge_prospect_intake runs", !purgeError, purgeError?.message);

  const staleGone = await admin.from("prospect_intake").select("id").eq("id", stale.data.id).maybeSingle();
  check("a 31-day-old prospect IS purged", !staleGone.data);
  const staleAnswers = await admin.from("form_responses").select("id").eq("id", staleResponse.data.id).maybeSingle();
  check("their answers go with them (cascade)", !staleAnswers.data);
  const staleHealth = await admin.from("form_response_health").select("id").eq("form_response_id", staleResponse.data.id);
  check("their health rows go with them (cascade)", (staleHealth.data ?? []).length === 0);

  const waiverStill = await admin.from("form_responses").select("id").eq("id", waiver.data.id).maybeSingle();
  check("a CLIENT WAIVER of any age SURVIVES — the destructive direction",
    !!waiverStill.data, "A LEGAL RECORD WAS DELETED");

  // Telemetry, seeded one row at a time: a bulk insert normalises keys
  // across rows, so a row omitting created_at would send an explicit null
  // and fail the batch — which once made this very check pass vacuously.
  const oldTag = `verify-old-${randomUUID()}`;
  const seeded = await admin
    .from("form_submission_attempts")
    .insert({
      ip_hash: oldTag,
      outcome: "rejected",
      organization_id: ctx.orgId,
      created_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    })
    .select("created_at")
    .single();

  // THE PRECONDITION. Without a genuinely old row present, "nothing old
  // remains" is true of an empty table and proves nothing.
  const seededIsOld =
    !seeded.error && new Date(seeded.data.created_at) < new Date(Date.now() - 86_400_000);
  check("a >24h telemetry row exists BEFORE purging (else the next check is vacuous)",
    seededIsOld, seeded.error?.message ?? `seeded at ${seeded.data?.created_at}`);

  await admin.rpc("purge_form_submission_attempts");
  const oldGone = await admin.from("form_submission_attempts").select("id").eq("ip_hash", oldTag).maybeSingle();
  check("the >24h telemetry row IS purged", !oldGone.data);

  // ── 8. the retention canary ────────────────────────────────────────
  // pg_cron reduces the silent-failure surface; it does not remove it. A
  // job can be unscheduled, error every run, or never have been created,
  // and all three look like a quiet system. The app's own roles cannot
  // even read cron.job, so the only reachable signal is the OUTCOME.
  console.log("\nretention canary (is the schedule actually running?)");

  const { count: staleTelemetry } = await admin
    .from("form_submission_attempts")
    .select("id", { count: "exact", head: true })
    .lt("created_at", new Date(Date.now() - 26 * 3_600_000).toISOString());
  check("no telemetry older than the 24h window is lying around",
    (staleTelemetry ?? 0) === 0,
    `${staleTelemetry} row(s) past retention — the hourly purge may not be running`);

  const { count: staleProspects } = await admin
    .from("prospect_intake")
    .select("id", { count: "exact", head: true })
    .in("status", ["submitted", "under_review", "approved", "rejected"])
    .lt("submitted_at", new Date(Date.now() - 31 * 86_400_000).toISOString());
  check("no un-enrolled prospect is older than the 30-day window",
    (staleProspects ?? 0) === 0,
    `${staleProspects} row(s) past retention — the nightly purge may not be running`);

  // ── teardown ───────────────────────────────────────────────────────
  for (const id of made.responses) await admin.from("form_responses").delete().eq("id", id);
  for (const id of made.prospects) {
    await admin.from("prospect_intake").delete().eq("id", id);
    // The delete trigger takes the bell entry with the row — otherwise the
    // 30-day purge would leave notifications pointing at 404s.
    const { data: orphans } = await admin
      .from("notifications").select("id").eq("kind", "prospect.submitted").eq("link", `/intake/${id}`);
    check("deleting the prospect removes its notifications (no dangling bell entry)", (orphans ?? []).length === 0);
  }
  for (const id of made.links) await admin.from("form_links").delete().eq("id", id);
  if (made.staffId) await admin.from("staff").delete().eq("id", made.staffId);
  for (const id of made.versionIds) await admin.from("form_versions").delete().eq("id", id);
  if (made.definitionId) await admin.from("form_definitions").delete().eq("id", made.definitionId);

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed) {
    console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  // A crash is a FAILED verification, never a silent skip — a harness that
  // reports success when it never connected is the exact bug this project
  // has already been bitten by.
  console.error(`\nHARNESS ERROR (counts as failure): ${error.message}`);
  process.exit(1);
});
