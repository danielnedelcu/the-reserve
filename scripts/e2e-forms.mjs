/**
 * Public submission endpoint — end-to-end, through HTTP.
 *
 * scripts/verify-forms.mjs proves the database-layer boundaries. This file
 * proves the two properties that only exist at the route:
 *
 *   - the rate limit actually LIMITS (a 6th attempt is refused with 429,
 *     not merely counted);
 *   - the validator refuses malformed input and unknown keys THROUGH the
 *     endpoint, not just when called directly.
 *
 * Needs the dev server running:  npm run dev
 *   node scripts/e2e-forms.mjs [baseUrl]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3000";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const admin = createClient(env.NUXT_PUBLIC_SUPABASE_URL, env.NUXT_SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const FIELDS = [
  { key: "first_name", label: "First name", type: "text", required: true, sensitive: false },
  { key: "last_name", label: "Last name", type: "text", required: true, sensitive: false },
  { key: "email", label: "Email", type: "email", required: true, sensitive: false },
  { key: "conditions", label: "Conditions?", type: "textarea", required: false, sensitive: true },
];

const made = { definitionId: null, versionId: null, links: [], responses: [], prospects: [] };

/** A distinct address per case, so one case's attempts cannot limit another. */
function post(path, body, ip) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

async function setup() {
  const { data: org } = await admin.from("organizations").select("id").limit(1).single();
  const { data: staff } = await admin.from("staff").select("id").limit(1).single();

  const { data: def } = await admin
    .from("form_definitions")
    .insert({ organization_id: org.id, key: `e2e_${randomUUID().slice(0, 8)}`, name: "E2E form" })
    .select("id").single();
  made.definitionId = def.id;

  const { data: version } = await admin
    .from("form_versions")
    .insert({ form_definition_id: def.id, version: 1, fields: FIELDS, consent_text: "I agree." })
    .select("id").single();
  made.versionId = version.id;

  return { orgId: org.id, staffId: staff.id, versionId: version.id };
}

async function link(ctx) {
  const { data } = await admin
    .from("form_links")
    .insert({ organization_id: ctx.orgId, form_version_id: ctx.versionId, issued_by: ctx.staffId })
    .select("id, token").single();
  made.links.push(data.id);
  return data.token;
}

async function main() {
  const ping = await fetch(base).catch(() => null);
  if (!ping) {
    // A server that is not there is a FAILED run, never a skipped one.
    console.error(`\nHARNESS ERROR (counts as failure): no server at ${base}. Start it with npm run dev.`);
    process.exit(1);
  }

  console.log(`\nPublic submission endpoint, end to end (${base})\n`);
  const ctx = await setup();

  // ── the endpoint accepts a good submission ─────────────────────────
  console.log("the authorized path");
  const goodToken = await link(ctx);
  const okRes = await post(`/api/public/forms/${goodToken}/submit`, {
    answers: { first_name: "E2E", last_name: "Runner", email: "e2e@example.test", conditions: "none" },
    consented: true,
  }, "198.51.100.10");
  const okBody = await okRes.json().catch(() => ({}));
  check("a valid submission returns 200", okRes.status === 200, `got ${okRes.status}`);
  if (okBody.responseId) made.responses.push(okBody.responseId);

  const reuse = await post(`/api/public/forms/${goodToken}/submit`, {
    answers: { first_name: "E2E", last_name: "Runner", email: "e2e@example.test" },
    consented: true,
  }, "198.51.100.10");
  check("reusing the same token returns 410", reuse.status === 410, `got ${reuse.status}`);

  // ── validation, through HTTP ───────────────────────────────────────
  console.log("\nvalidation at the endpoint");
  const unknownKeyToken = await link(ctx);
  const unknown = await post(`/api/public/forms/${unknownKeyToken}/submit`, {
    answers: { first_name: "A", last_name: "B", email: "a@b.test", sneaky: "dropped?" },
    consented: true,
  }, "198.51.100.11");
  const unknownBody = await unknown.json().catch(() => ({}));
  check("an unknown key is REJECTED (422), not silently dropped",
    unknown.status === 422, `got ${unknown.status}`);
  check("the error names the offending key",
    JSON.stringify(unknownBody).includes("sneaky"), JSON.stringify(unknownBody).slice(0, 120));

  const { data: afterUnknown } = await admin
    .from("form_links").select("consumed_at").eq("token", unknownKeyToken).single();
  check("a rejected submission does NOT consume the token",
    !afterUnknown?.consumed_at, "token was burned by an invalid attempt");

  const missing = await post(`/api/public/forms/${await link(ctx)}/submit`, {
    answers: { last_name: "B", email: "a@b.test" },
    consented: true,
  }, "198.51.100.12");
  check("a missing required field is rejected (422)", missing.status === 422, `got ${missing.status}`);

  const badType = await post(`/api/public/forms/${await link(ctx)}/submit`, {
    answers: { first_name: "A", last_name: "B", email: "not-an-email" },
    consented: true,
  }, "198.51.100.13");
  check("a malformed value is rejected (422)", badType.status === 422, `got ${badType.status}`);

  // ── the rate limit actually limits ─────────────────────────────────
  console.log("\nrate limiting, through HTTP");
  const limitToken = await link(ctx);
  const limitIp = `198.51.100.${100 + Math.floor(Math.random() * 50)}`;
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await post(`/api/public/forms/${limitToken}/submit`, {
      answers: { first_name: "A" }, // always invalid: keeps the token unconsumed
      consented: true,
    }, limitIp);
    statuses.push(res.status);
  }
  const first = statuses.slice(0, 5);
  const later = statuses.slice(5);
  check("the first 5 attempts are processed (422, not limited)",
    first.every((s) => s === 422), `got ${first.join(",")}`);
  check("attempt 6 onward is REFUSED with 429 — the limit limits",
    later.every((s) => s === 429), `got ${later.join(",")}`);

  const stillGood = await post(`/api/public/forms/${await link(ctx)}/submit`, {
    answers: { first_name: "A", last_name: "B", email: "a@b.test" },
    consented: true,
  }, "198.51.100.200");
  check("a DIFFERENT token from a different IP still works (limit is scoped, not global)",
    stillGood.status === 200, `got ${stillGood.status}`);
  const stillGoodBody = await stillGood.json().catch(() => ({}));
  if (stillGoodBody.responseId) made.responses.push(stillGoodBody.responseId);

  // ── the public GET does not consume ────────────────────────────────
  console.log("\nreading a form");
  const readToken = await link(ctx);
  const g1 = await fetch(`${base}/api/public/forms/${readToken}`);
  const g2 = await fetch(`${base}/api/public/forms/${readToken}`);
  check("GET returns the form", g1.status === 200, `got ${g1.status}`);
  check("GET is repeatable — opening a link does not consume it", g2.status === 200, `got ${g2.status}`);
  const form = await g2.json().catch(() => ({}));
  check("GET exposes the questions", Array.isArray(form.fields) && form.fields.length === 4);
  check("GET does not leak who the link was issued to",
    !JSON.stringify(form).includes("issued_by") && !("deliveryEmail" in form));

  // ── teardown ───────────────────────────────────────────────────────
  const { data: responses } = await admin
    .from("form_responses").select("id, prospect_intake_id").eq("form_version_id", made.versionId);
  for (const r of responses ?? []) {
    await admin.from("form_responses").delete().eq("id", r.id);
    if (r.prospect_intake_id) await admin.from("prospect_intake").delete().eq("id", r.prospect_intake_id);
  }
  for (const id of made.links) await admin.from("form_links").delete().eq("id", id);
  await admin.from("form_versions").delete().eq("id", made.versionId);
  await admin.from("form_definitions").delete().eq("id", made.definitionId);

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed) {
    console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nHARNESS ERROR (counts as failure): ${error.message}`);
  process.exit(1);
});
