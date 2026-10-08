/**
 * verify-audit — audit_log carries its organisation and is append-only
 * for every role (docs/design/policy-sweep-design.md, "The audit_log
 * organisation column"). LOCAL STACK ONLY: it creates staff and grants
 * roles, which write audit rows, and the app must be up on E2E_BASE_URL
 * for the route cases.
 *
 *   - two organisations: a holder of audit_log.view in one reads none of
 *     the other's rows, and reads their own;
 *   - the staff_roles trigger writes the organisation on a grant, and on
 *     a revocation caused by DELETING the staff row (no replica mode:
 *     the staff row is gone when the trigger fires, so the role resolves it);
 *   - accept_staff_invite writes the invite's organisation;
 *   - two routes through the app with a session: a health-note view and
 *     a lead status change each write the row's organisation;
 *   - update, delete and truncate on audit_log are refused for the
 *     service role, with a message that names the table.
 * Checkout, refund and booking are covered by verify-ledger and journey
 * 03; the prospect review, resend and cancel routes are not driven here
 * (they need a prospect, an outbound email and a Stripe charge) — their
 * column comes from the row they hold and is typed.
 *
 *   SUPABASE_LOCAL=true node scripts/verify-audit.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { LOCAL_MODE, get, guard, isLocalUrl, pgSsl, supabaseEnv } from "./_env.mjs";
import { scrubTestStaff } from "./_cleanup.mjs";

guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const { url, anonKey, serviceKey } = supabaseEnv();
const dsn = get("DATABASE_URL");
if (!LOCAL_MODE || !isLocalUrl(url) || !isLocalUrl(dsn)) {
  console.error("\nHARNESS ERROR (counts as failure): verify-audit writes audit rows and runs on the LOCAL stack only (SUPABASE_LOCAL=true).");
  process.exit(1);
}
const base = (process.env.E2E_BASE_URL ?? "http://localhost:3300").replace(/\/$/, "");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const run = randomBytes(4).toString("hex");
const TAG = `VERIFY-AUDIT-${run}`;
let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function must(p, what) {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}
const made = { users: [], staff: [], roleRows: [], roles: [], clients: [], leads: [], invites: [], locations: [], orgs: [] };

async function roleWith(orgId, name, keys) {
  const role = await must(admin.from("roles").insert({ organization_id: orgId, name: `${TAG} ${name}`, is_system: false }).select("id").single(), `role ${name}`);
  made.roles.push(role.id);
  for (const key of keys) await must(admin.from("role_permissions").insert({ role_id: role.id, permission_key: key }), `role_permissions ${name}`);
  return role.id;
}
async function staffMember(orgId, label, roleId) {
  const email = `verify-audit-${label}-${run}@verify.test`;
  const password = `va-${randomBytes(12).toString("hex")}`;
  const { user } = await must(admin.auth.admin.createUser({ email, password, email_confirm: true }), `createUser ${label}`);
  made.users.push(user.id);
  const row = await must(admin.from("staff").insert({ organization_id: orgId, user_id: user.id, display_name: `${TAG} ${label}`, email, bookable: false, active: true }).select("id").single(), `staff ${label}`);
  made.staff.push(row.id);
  if (roleId) {
    await must(admin.from("staff_roles").insert({ staff_id: row.id, role_id: roleId }), `staff_roles ${label}`);
    made.roleRows.push({ staff_id: row.id, role_id: roleId });
  }
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(client.auth.signInWithPassword({ email, password }), `signIn ${label}`);
  const jar = new Map();
  const ssr = createServerClient(url, anonKey, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))) } });
  await must(ssr.auth.signInWithPassword({ email, password }), `ssr signIn ${label}`);
  for (let i = 0; i < 20 && !jar.size; i++) await new Promise((r) => setTimeout(r, 25));
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
  return { id: row.id, userId: user.id, client, cookie };
}
const rowsAbout = async (entityId) => (await admin.from("audit_log").select("action, organization_id, actor_staff_id").eq("entity_id", entityId).order("id")).data ?? [];

async function main() {
  const org = await must(admin.from("organizations").select("id").order("created_at").limit(1).single(), "seeded organisation");
  const ORG = org.id;
  console.log(`\nverify-audit (${TAG}) — ${url}, app ${base}\n`);

  // ── the writers ────────────────────────────────────────────────────
  console.log("the writers set the organisation from a row they hold");
  const viewerKeys = ["audit_log.view", "clients.view", "clients.notes.health.view", "leads.view", "leads.manage"];
  const eastRole = await roleWith(ORG, "east viewer", viewerKeys);
  const east = await staffMember(ORG, "east", eastRole);
  {
    const rows = await rowsAbout(east.id);
    check("a role grant (the staff_roles trigger, service role, no actor) writes staff_role.granted with the staff row's organisation", rows.length === 1 && rows[0].action === "staff_role.granted" && rows[0].organization_id === ORG && rows[0].actor_staff_id === null, JSON.stringify(rows));
  }
  {
    // A staff member deleted with their role, no replica mode: the cascade
    // revokes the role after the staff row is gone, and the role resolves it.
    const goner = await must(admin.from("staff").insert({ organization_id: ORG, display_name: `${TAG} goner`, email: `verify-audit-goner-${run}@verify.test`, bookable: false, active: true }).select("id").single(), "goner");
    await must(admin.from("staff_roles").insert({ staff_id: goner.id, role_id: eastRole }), "goner role");
    const { error } = await admin.from("staff").delete().eq("id", goner.id);
    const rows = await rowsAbout(goner.id);
    check("deleting a staff member with a role (no replica mode) writes staff_role.revoked with the ROLE's organisation, the staff row being gone", !error && rows.length === 2 && rows[1].action === "staff_role.revoked" && rows[1].organization_id === ORG, error?.message ?? JSON.stringify(rows));
    made.staff.push(goner.id); // for the audit cleanup by entity
  }
  {
    // accept_staff_invite, the way the invite route calls it.
    const invite = await must(admin.from("staff_invites").insert({ organization_id: ORG, email: `verify-audit-invitee-${run}@verify.test`, role_ids: [eastRole], invited_by: east.id }).select("id, token").single(), "invite");
    made.invites.push(invite.id);
    const { user } = await must(admin.auth.admin.createUser({ email: `verify-audit-invitee-${run}@verify.test`, password: `va-${randomBytes(12).toString("hex")}`, email_confirm: true }), "invitee user");
    made.users.push(user.id);
    const { data: newStaffId, error } = await admin.rpc("accept_staff_invite", { invite_token: invite.token, new_user_id: user.id, final_display_name: `${TAG} invitee` });
    if (newStaffId) { made.staff.push(newStaffId); made.roleRows.push({ staff_id: newStaffId, role_id: eastRole }); }
    const rows = newStaffId ? await rowsAbout(newStaffId) : [];
    const accepted = rows.find((r) => r.action === "staff.invite_accepted");
    check("accept_staff_invite writes staff.invite_accepted with the invite's organisation (and the role grant beside it)", !error && !!accepted && accepted.organization_id === ORG && rows.some((r) => r.action === "staff_role.granted" && r.organization_id === ORG), error?.message ?? JSON.stringify(rows));
  }
  const ping = await fetch(base).catch(() => null);
  if (!ping) {
    check(`the app answers at ${base} (start it: npm run build:check && npm run app:start)`, false, "no server");
  } else {
    const noor = await must(admin.from("clients").insert({ organization_id: ORG, first_name: "Noor", last_name: TAG, referral_source: TAG }).select("id").single(), "client");
    made.clients.push(noor.id);
    const r1 = await fetch(`${base}/api/clients/${noor.id}/health-notes`, { headers: { cookie: east.cookie } });
    const viewed = (await admin.from("audit_log").select("organization_id, actor_staff_id").eq("action", "health_note.viewed").eq("entity_id", noor.id)).data ?? [];
    check("GET /api/clients/:id/health-notes writes health_note.viewed with the client's organisation and the viewer as actor", r1.status === 200 && viewed.length === 1 && viewed[0].organization_id === ORG && viewed[0].actor_staff_id === east.id, `${r1.status} ${JSON.stringify(viewed)}`);
    const lead = await must(admin.from("leads").insert({ organization_id: ORG, first_name: "Lee", last_name: TAG, email: `lead-${run}@verify.test`, interest: "inquiry", status: "new" }).select("id").single(), "lead");
    made.leads.push(lead.id);
    const r2 = await fetch(`${base}/api/leads/${lead.id}/status`, { method: "POST", headers: { "content-type": "application/json", cookie: east.cookie }, body: JSON.stringify({ status: "contacted" }) });
    const changed = (await admin.from("audit_log").select("organization_id").eq("action", "lead.status_changed").eq("entity_id", lead.id)).data ?? [];
    check("POST /api/leads/:id/status writes lead.status_changed with the lead's organisation", r2.status === 200 && changed.length === 1 && changed[0].organization_id === ORG, `${r2.status} ${JSON.stringify(changed)}`);
  }

  // ── two organisations ──────────────────────────────────────────────
  console.log("\ntwo organisations: audit_log.view reads only the holder's own");
  const west = await must(admin.from("organizations").insert({ name: `${TAG} west`, timezone: "America/Los_Angeles" }).select("id").single(), "org west");
  made.orgs.push(west.id);
  const westRole = await roleWith(west.id, "west viewer", ["audit_log.view"]);
  const westViewer = await staffMember(west.id, "west", westRole); // its own grant writes a west row
  const eastSeesWest = await east.client.from("audit_log").select("id", { count: "exact", head: true }).eq("organization_id", west.id);
  const eastSeesEast = await east.client.from("audit_log").select("id", { count: "exact", head: true }).eq("organization_id", ORG);
  const westSeesEast = await westViewer.client.from("audit_log").select("id", { count: "exact", head: true }).eq("organization_id", ORG);
  const westSeesWest = await westViewer.client.from("audit_log").select("id", { count: "exact", head: true }).eq("organization_id", west.id);
  const westTotal = (await admin.from("audit_log").select("id", { count: "exact", head: true }).eq("organization_id", west.id)).count;
  check("the east holder reads none of west's rows and some of east's; the west holder reads none of east's and all of west's (non-vacuous: west has rows)", eastSeesWest.count === 0 && eastSeesEast.count > 0 && westSeesEast.count === 0 && westSeesWest.count === westTotal && westTotal > 0, `east→west ${eastSeesWest.count}, east→east ${eastSeesEast.count}, west→east ${westSeesEast.count}, west→west ${westSeesWest.count}/${westTotal}`);
  const noPerm = await must(admin.from("roles").insert({ organization_id: ORG, name: `${TAG} nobody`, is_system: false }).select("id").single(), "nobody role");
  made.roles.push(noPerm.id);
  const nobody = await staffMember(ORG, "nobody", noPerm.id);
  const nobodySees = await nobody.client.from("audit_log").select("id", { count: "exact", head: true });
  check("a staff member without audit_log.view reads nothing, in their own organisation", nobodySees.count === 0, String(nobodySees.count));

  // ── append-only for every role ─────────────────────────────────────
  console.log("\naudit_log is append-only for the service role");
  const some = (await admin.from("audit_log").select("id").eq("organization_id", ORG).limit(1)).data?.[0];
  const u = await admin.from("audit_log").update({ action: "edited" }).eq("id", some.id);
  const d = await admin.from("audit_log").delete().eq("id", some.id);
  check("update and delete through the service-role API raise LD003 with a message naming the table", u.error?.code === "LD003" && d.error?.code === "LD003" && /audit_log is append-only/.test(u.error?.message ?? ""), `${u.error?.code}: ${u.error?.message}`);
  const db = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
  await db.connect();
  try {
    let trunc = null;
    try { await db.query("begin"); await db.query("set local role service_role"); await db.query("truncate audit_log"); } catch (e) { trunc = e; }
    await db.query("rollback").catch(() => {});
    check("truncate audit_log as service_role is refused (42501)", trunc?.code === "42501", trunc?.code ?? "no error");
    const { rows: tr } = await db.query("select tgenabled from pg_trigger where tgname = 'trg_audit_log_append_only'");
    check("trg_audit_log_append_only exists and is enabled", tr[0]?.tgenabled === "O", JSON.stringify(tr));
  } finally {
    await db.end();
  }
}

async function cleanup() {
  for (const id of made.invites) await admin.from("staff_invites").delete().eq("id", id);
  if (made.leads.length) await admin.from("leads").delete().in("id", made.leads);
  if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);
  for (const r of made.roleRows) await admin.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id);
  if (made.staff.length) await scrubTestStaff(dsn, made.staff);
  if (made.staff.length) await admin.from("staff").delete().in("id", made.staff);
  for (const id of made.users) await admin.auth.admin.deleteUser(id);
  for (const id of made.roles) { await admin.from("role_permissions").delete().eq("role_id", id); await admin.from("roles").delete().eq("id", id); }
  for (const id of made.orgs) {
    const { error } = await admin.from("organizations").delete().eq("id", id);
    if (error) console.log(`  note  a test organisation could not be deleted: ${error.message}`);
  }
}

try { await main(); } catch (e) { console.error(`\nHARNESS ERROR (counts as failure): ${e.message}`); failed++; failures.push(`harness error: ${e.message}`); } finally { await cleanup().catch((e) => console.error(`cleanup failed: ${e.message}`)); }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`); process.exit(1); }
