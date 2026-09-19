/**
 * Public lead capture — boundary verification, both directions.
 *
 * Runs against the LIVE database and a running dev server. Every check is
 * written in the shape that catches a silent hole: not "the happy path
 * works" but "the thing that must be impossible is impossible", and each
 * control is proved from BOTH sides — it stops what it must stop AND it
 * lets through what it must let through. A harness that only proves one
 * half passes while the hole is open.
 *
 * Needs the dev server running (npm run dev):
 *   npm run verify:leads [-- baseUrl]
 *
 * Two facts checked here that nothing else checks:
 *   - the interest/status sets in shared/leads/constants.ts EQUAL the
 *     database check constraints (two languages, one predicate);
 *   - the retention purge runs, purges the allowlist, and KEEPS converted —
 *     the outcome canary owed since phase 1.
 */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { LEAD_INTERESTS, LEAD_STATUSES, LEAD_HONEYPOT_FIELD } from "../shared/leads/constants.ts";

const base = process.argv[2] ?? "http://localhost:3000";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

for (const k of ["NUXT_PUBLIC_SUPABASE_URL", "NUXT_PUBLIC_SUPABASE_KEY", "NUXT_SUPABASE_SECRET_KEY", "LEADS_ORGANIZATION_ID", "LEADS_ALLOWED_ORIGINS", "TBLS_DSN"]) {
  if (!env[k]) {
    console.error(`FATAL: ${k} missing from .env — cannot verify what is not configured`);
    process.exit(1);
  }
}

const admin = createClient(env.NUXT_PUBLIC_SUPABASE_URL, env.NUXT_SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const anon = createClient(env.NUXT_PUBLIC_SUPABASE_URL, env.NUXT_PUBLIC_SUPABASE_KEY, { auth: { persistSession: false } });
const ORG = env.LEADS_ORGANIZATION_ID;
const ALLOWED_ORIGIN = env.LEADS_ALLOWED_ORIGINS.split(",")[0].trim();
const OTHER_ORIGIN = "https://someone-elses-site.example";
const SUFFIX = `@leads.verify.test`;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const run = randomUUID().slice(0, 8);
let ipCounter = 0;
/**
 * A distinct address per case so one case's attempts cannot limit another,
 * inside a /16 chosen at random per RUN so two runs within the same hour
 * do not share addresses either — the first version restarted at .1 every
 * run and the second run found every address already at its limit.
 */
const ipBlock = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
function freshIp() { ipCounter += 1; return `${ipBlock}.${ipCounter}`; }

function lead(overrides = {}) {
  return {
    first_name: "Verify",
    last_name: "Lead",
    email: `${run}-${randomUUID().slice(0, 6)}${SUFFIX}`,
    interest: "membership",
    source: "verify-harness",
    consent: true,
    ...overrides,
  };
}

async function post(body, { ip = freshIp(), origin, raw } = {}) {
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}/api/public/leads`, {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

let bystanderId = null;

async function main() {
  const ping = await fetch(base).catch(() => null);
  if (!ping) {
    console.error(`\nHARNESS ERROR (counts as failure): no server at ${base}. Start it with npm run dev.`);
    process.exit(1);
  }
  console.log(`\nPublic lead capture — boundary verification (${base})\n`);

  // An active staff member with NO roles: whatever the live roster looks
  // like, at least one person in the org must NOT be notified.
  const { data: bystander, error: bystanderErr } = await admin
    .from("staff")
    .insert({ organization_id: ORG, display_name: "Verify Bystander", email: `verify-bystander-${run}@example.test`, bookable: false })
    .select("id").single();
  if (bystanderErr) throw new Error(`fixture staff: ${bystanderErr.message}`);
  bystanderId = bystander.id;

  // ── 1. anon has no write path but the endpoint ─────────────────────
  console.log("anon privileges");
  const { error: anonInsert } = await anon.from("leads").insert({
    organization_id: ORG, first_name: "a", last_name: "b", email: `anon${SUFFIX}`, interest: "inquiry",
  });
  check("a direct anon INSERT into leads is refused BY RLS (no policy exists)",
    !!anonInsert && /row-level security|permission denied|violates/i.test(anonInsert.message), anonInsert?.message);
  const { error: anonNote } = await anon.from("lead_notes").insert({ lead_id: randomUUID(), staff_id: randomUUID(), body: "x" });
  check("a direct anon INSERT into lead_notes is refused", !!anonNote, anonNote?.message);
  const { error: anonRpc } = await anon.rpc("purge_leads");
  check("anon EXECUTE of purge_leads is refused BY GRANT", !!anonRpc && /permission denied/i.test(anonRpc.message), anonRpc?.message);

  // ── 2. the endpoint accepts a good submission, and what it stores ──
  console.log("\nthe accepted path");
  const good = lead({ phone: " 555-0100 " });
  const ok = await post(good);
  check("a valid submission returns 200", ok.status === 200, `got ${ok.status}: ${ok.text.slice(0, 100)}`);
  check("the response is thin — captured:true and nothing else",
    JSON.stringify(ok.json) === JSON.stringify({ captured: true }), ok.text.slice(0, 100));
  const { data: stored } = await admin.from("leads").select("*").eq("email", good.email).maybeSingle();
  check("a leads row exists for the submission", !!stored);
  check("…in the CONFIGURED organisation (server-side fact, not a client claim)", stored?.organization_id === ORG);
  check("…with status 'new'", stored?.status === "new");
  check("…with the posted source", stored?.source === "verify-harness");
  check("…with the posted interest", stored?.interest === "membership");
  check("…phone trimmed", stored?.phone === "555-0100");
  check("…consent recorded true", stored?.consent === true);
  const skew = stored?.consent_at ? Math.abs(Date.now() - Date.parse(stored.consent_at)) : Infinity;
  check("…consent_at stamped by the SERVER, just now (within 60s)", skew < 60_000, `skew ${Math.round(skew / 1000)}s`);
  const { data: anonRead } = await anon.from("leads").select("id").eq("email", good.email);
  check("anon cannot READ the row just written", (anonRead ?? []).length === 0);

  // ── 2b. the bell: fan-out == leads.view holders, settle, forget ────
  console.log("\nlead.captured notifications (recipients == permission holders)");
  const link = `/leads/${stored?.id}`;
  const { data: holderRows } = await admin
    .from("staff_roles")
    .select("staff_id, staff!inner(organization_id, active), roles!inner(role_permissions!inner(permission_key))")
    .eq("roles.role_permissions.permission_key", "leads.view")
    .eq("staff.organization_id", ORG)
    .eq("staff.active", true);
  const holders = new Set((holderRows ?? []).map((r) => r.staff_id));
  const { data: orgStaff } = await admin.from("staff").select("id, active").eq("organization_id", ORG);
  const nonHolders = (orgStaff ?? []).filter((s) => s.active && !holders.has(s.id)).map((s) => s.id);
  const { data: notes } = await admin.from("notifications").select("staff_id, link, read_at, title").eq("kind", "lead.captured").eq("link", link);
  const notified = new Set((notes ?? []).map((n) => n.staff_id));
  check("at least one active staff member holds leads.view (else the next check is vacuous)", holders.size > 0);
  check("the bystander fixture is an active NON-holder (else the exclusion check is vacuous)", nonHolders.includes(bystanderId));
  check("every active leads.view holder got exactly one lead.captured notification",
    [...holders].every((id) => notified.has(id)) && (notes ?? []).length === holders.size,
    `holders=${holders.size} notified=${notified.size} rows=${(notes ?? []).length}`);
  check("NO active staff member without leads.view was notified", nonHolders.every((id) => !notified.has(id)));
  check("the notification arrives unread and links to the lead",
    (notes ?? []).length > 0 && (notes ?? []).every((n) => n.read_at === null && n.link === link));
  const unreadFor = async () => (await admin.from("notifications").select("id").eq("kind", "lead.captured").eq("link", link).is("read_at", null)).data.length;
  await admin.from("leads").update({ status: "contacted" }).eq("id", stored.id);
  check("CONTACTING the lead settles the notification for every recipient (read, not deleted)",
    (await unreadFor()) === 0 && (await admin.from("notifications").select("id").eq("kind", "lead.captured").eq("link", link)).data.length === holders.size);
  await admin.from("leads").update({ status: "new" }).eq("id", stored.id);
  check("moving it back to new does NOT re-notify (one arrival, one announcement)",
    (await admin.from("notifications").select("id").eq("kind", "lead.captured").eq("link", link)).data.length === holders.size);

  const noConsentLead = lead({ consent: false });
  const noConsent = await post(noConsentLead);
  const { data: nc } = await admin.from("leads").select("consent, consent_at").eq("email", noConsentLead.email).maybeSingle();
  check("consent=false stores consent false with NO timestamp (the pairing check holds)",
    noConsent.status === 200 && nc?.consent === false && nc?.consent_at === null, JSON.stringify(nc));

  const noSource = lead({ source: undefined });
  delete noSource.source;
  const ns = await post(noSource);
  const { data: nsRow } = await admin.from("leads").select("source").eq("email", noSource.email).maybeSingle();
  check("a submission without source takes the database default 'manual'", ns.status === 200 && nsRow?.source === "manual");

  const clientStamp = await post(lead({ consent_at: "1999-01-01T00:00:00Z" }));
  check("a client-sent consent_at is REJECTED as an unknown key (the server owns the stamp)",
    clientStamp.status === 422 && /consent_at/.test(clientStamp.text), `${clientStamp.status} ${clientStamp.text.slice(0, 80)}`);

  // ── 3. the honeypot ────────────────────────────────────────────────
  console.log("\nhoneypot");
  const trapped = lead({ [LEAD_HONEYPOT_FIELD]: "https://spam.example" });
  const trap = await post(trapped);
  check("a filled honeypot is answered 200 with the SAME body as a success (leaks nothing)",
    trap.status === 200 && trap.text === ok.text, `${trap.status} ${trap.text.slice(0, 80)}`);
  const { data: trapRow } = await admin.from("leads").select("id").eq("email", trapped.email);
  check("…and NO lead row was written", (trapRow ?? []).length === 0);
  const clean = lead({ [LEAD_HONEYPOT_FIELD]: "" });
  const cleanRes = await post(clean);
  const { data: cleanRow } = await admin.from("leads").select("id").eq("email", clean.email);
  check("an EMPTY honeypot (a human) is accepted and stored", cleanRes.status === 200 && (cleanRow ?? []).length === 1);

  // ── 4. shape validation ────────────────────────────────────────────
  console.log("\nshape validation");
  const cases = [
    ["an unknown key is REJECTED (422), naming it", lead({ sneaky: "x" }), (r) => r.status === 422 && /sneaky/.test(r.text)],
    ["a missing first_name is rejected", (() => { const l = lead(); delete l.first_name; return l; })(), (r) => r.status === 422],
    ["a malformed email is rejected", lead({ email: "not-an-email" }), (r) => r.status === 422],
    ["an interest OUTSIDE the set is rejected", lead({ interest: "vip" }), (r) => r.status === 422 && /interest/.test(r.text)],
    ["a non-boolean consent is rejected", lead({ consent: "yes" }), (r) => r.status === 422],
    ["an oversized name (200 chars) is rejected", lead({ first_name: "x".repeat(200) }), (r) => r.status === 422],
  ];
  for (const [name, body, ok] of cases) {
    const r = await post(body);
    check(name, ok(r), `${r.status} ${r.text.slice(0, 80)}`);
  }
  const notObject = await post(null, { raw: "[1,2,3]" });
  check("a non-object body is rejected (422)", notObject.status === 422, `${notObject.status}`);
  const huge = await post(null, { raw: JSON.stringify(lead({ first_name: "x".repeat(10_000) })) });
  check("an oversized body is refused (413) before it is read", huge.status === 413, `${huge.status}`);
  for (const interest of LEAD_INTERESTS) {
    const r = await post(lead({ interest }));
    check(`every allowed interest is accepted: ${interest}`, r.status === 200, `${r.status}`);
  }

  // ── 5. the vocabulary agrees with the database ─────────────────────
  console.log("\nshared constants == check constraints (two languages, one predicate)");
  const c = new pg.Client({ connectionString: env.TBLS_DSN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const setFrom = async (constraint) => {
    const { rows } = await c.query(`select pg_get_constraintdef(oid) def from pg_constraint where conname = $1`, [constraint]);
    const def = rows[0]?.def ?? "";
    return [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
  };
  const { rows: pub } = await c.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'leads'`);
  check("leads is in the supabase_realtime publication (a subscription to an unpublished table reports SUBSCRIBED and receives nothing)", pub.length === 1);
  const dbInterests = await setFrom("leads_interest_check");
  const dbStatuses = await setFrom("leads_status_check");
  check("LEAD_INTERESTS equals leads_interest_check exactly",
    JSON.stringify(dbInterests) === JSON.stringify([...LEAD_INTERESTS].sort()), `db=${dbInterests} ts=${[...LEAD_INTERESTS].sort()}`);
  check("LEAD_STATUSES equals leads_status_check exactly",
    JSON.stringify(dbStatuses) === JSON.stringify([...LEAD_STATUSES].sort()), `db=${dbStatuses} ts=${[...LEAD_STATUSES].sort()}`);
  // The discriminator: lead attempts have token null; the prospect route
  // records the URL token on EVERY attempt, garbage included. Assert the
  // second half from the code that decides it, since data cannot prove a
  // negative about future prospect attempts.
  const prospectRoute = readFileSync("server/api/public/forms/[token]/submit.post.ts", "utf8");
  check("the prospect route never records a null token (every recordAttempt passes `token`)",
    /recordAttempt\(/.test(prospectRoute) && !/token:\s*null/.test(prospectRoute));
  check("the lead limiter counts ONLY null-token attempts (server/utils/leadCapture.ts)",
    readFileSync("server/utils/leadCapture.ts", "utf8").includes('.is("token", null)'));

  // ── 6. CORS — other websites cannot use the form; the marketing site can
  console.log("\nCORS");
  const pre = await fetch(`${base}/api/public/leads`, {
    method: "OPTIONS",
    headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  check("preflight from the ALLOWED origin is answered 204", pre.status === 204, `${pre.status}`);
  check("…echoing exactly that origin (never *)", pre.headers.get("access-control-allow-origin") === ALLOWED_ORIGIN, String(pre.headers.get("access-control-allow-origin")));
  check("…allowing POST", /POST/.test(pre.headers.get("access-control-allow-methods") ?? ""), String(pre.headers.get("access-control-allow-methods")));
  const preBad = await fetch(`${base}/api/public/leads`, {
    method: "OPTIONS",
    headers: { origin: OTHER_ORIGIN, "access-control-request-method": "POST" },
  });
  check("preflight from ANOTHER origin is refused (403) with no allow-origin header",
    preBad.status === 403 && !preBad.headers.get("access-control-allow-origin"), `${preBad.status}`);
  const badOriginLead = lead();
  const postBad = await post(badOriginLead, { origin: OTHER_ORIGIN });
  const { data: badOriginRow } = await admin.from("leads").select("id").eq("email", badOriginLead.email);
  check("a POST claiming another origin is refused (403) and writes nothing",
    postBad.status === 403 && (badOriginRow ?? []).length === 0, `${postBad.status}, rows=${(badOriginRow ?? []).length}`);
  const postGood = await post(lead(), { origin: ALLOWED_ORIGIN });
  check("a POST from the allowed origin succeeds with the allow-origin header on the response",
    postGood.status === 200 && postGood.headers.get("access-control-allow-origin") === ALLOWED_ORIGIN, `${postGood.status} ${postGood.headers.get("access-control-allow-origin")}`);
  check("a POST with NO origin (server-to-server) still works — the endpoint is open by design",
    ok.status === 200);

  // ── 7. the rate limit actually limits, per address ─────────────────
  console.log("\nrate limiting, through HTTP");
  const limitIp = freshIp();
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await post(lead({ interest: "vip" }), { ip: limitIp }); // always 422: nothing stored, every attempt counted
    statuses.push(r.status);
  }
  check("the first 5 attempts from one address are processed (422, not limited)",
    statuses.slice(0, 5).every((s) => s === 422), statuses.join(","));
  check("attempt 6 onward is REFUSED with 429 — the limit limits",
    statuses.slice(5).every((s) => s === 429), statuses.join(","));
  const other = await post(lead(), { ip: freshIp() });
  check("a DIFFERENT address is still served (the limit is per-IP, not global)", other.status === 200, `${other.status}`);
  const { data: leadAttempts } = await admin.from("form_submission_attempts")
    .select("outcome").is("token", null).eq("organization_id", ORG).gte("created_at", new Date(Date.now() - 120_000).toISOString());
  check("lead attempts are recorded in form_submission_attempts with token NULL, rejected ones included",
    (leadAttempts ?? []).some((a) => a.outcome === "rejected") && (leadAttempts ?? []).some((a) => a.outcome === "accepted"),
    `rows=${(leadAttempts ?? []).length}`);

  // ── 8. retention — the canary owed since phase 1, both directions ──
  console.log("\nretention (purge_leads)");
  const stale = await admin.from("leads").insert({
    organization_id: ORG, first_name: "Stale", last_name: "New", email: `stale-new-${run}${SUFFIX}`, interest: "inquiry",
    status: "new", created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  }).select("id").single();
  const { data: staffRow } = await admin.from("staff").select("id").eq("organization_id", ORG).eq("active", true).limit(1).single();
  await admin.from("lead_notes").insert({ lead_id: stale.data.id, staff_id: staffRow.id, body: "stale note" });
  const kept = await admin.from("leads").insert({
    organization_id: ORG, first_name: "Stale", last_name: "Converted", email: `stale-converted-${run}${SUFFIX}`, interest: "membership",
    status: "converted", created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
  }).select("id").single();
  const pre40 = await admin.from("leads").select("id").eq("id", stale.data.id).maybeSingle();
  check("a 40-day-old 'new' lead exists BEFORE purging (else the next check is vacuous)", !!pre40.data);
  const { data: purged, error: purgeErr } = await admin.rpc("purge_leads");
  check("purge_leads runs under the service role", !purgeErr, purgeErr?.message);
  check("…and reports at least one deletion", typeof purged === "number" && purged >= 1, `returned ${purged}`);
  check("a 40-day-old 'new' lead IS purged", !(await admin.from("leads").select("id").eq("id", stale.data.id).maybeSingle()).data);
  check("its note went with it (cascade)", (await admin.from("lead_notes").select("id").eq("lead_id", stale.data.id)).data.length === 0);
  check("a 400-day-old CONVERTED lead SURVIVES — kept by omission from the allowlist, the destructive direction",
    !!(await admin.from("leads").select("id").eq("id", kept.data.id).maybeSingle()).data);
  const { data: canary } = await admin.from("leads").select("id")
    .in("status", ["new", "contacted", "qualified", "lost"])
    .lt("created_at", new Date(Date.now() - 31 * 86_400_000).toISOString());
  check("OUTCOME CANARY: no lead past the one-month window remains in a purgeable status",
    (canary ?? []).length === 0, `${(canary ?? []).length} stale row(s) — the nightly purge may not be running`);
  await c.end();

  // ── teardown ───────────────────────────────────────────────────────
  await admin.from("leads").delete().like("email", `%${SUFFIX}`);
  const { data: orphans } = await admin.from("notifications").select("id").eq("kind", "lead.captured").eq("link", link);
  check("deleting the lead removes its notifications (no dangling bell entry)", (orphans ?? []).length === 0);
  if (bystanderId) await admin.from("staff").delete().eq("id", bystanderId);

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
