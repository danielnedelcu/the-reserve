/**
 * Messaging boundary verification (docs/design/messaging-as-built.md).
 *
 * Everything messaging decides is decided in Postgres: four security
 * definer functions keyed on current_staff_id(), RLS that scopes reads to
 * participants, and triggers that fan out bell notifications. So the
 * harness does what the app does — creates real staff, signs them in
 * through GoTrue, and calls the functions on real sessions — and asserts
 * each rule in BOTH directions, so a rule that quietly stopped holding
 * fails here rather than in a client's inbox:
 *
 *   - a DM is canonical: the same pair, asked in either order, is ONE
 *     conversation; a different pair is a different one;
 *   - a group holds exactly the people named (creator included, repeats
 *     ignored), and someone outside it cannot see it;
 *   - unread is derived from last_read_at and cleared by
 *     mark_conversation_read for the reader ONLY — the other recipient's
 *     bell entry survives;
 *   - leaving removes one participant and garbage-collects the
 *     conversation only when the LAST one leaves (messages cascade);
 *   - the prospect status vocabulary the TypeScript decides with equals
 *     the database's check constraint (two languages, one predicate).
 *
 * Runs against whatever scripts/_env.mjs resolves: the hosted project
 * from apps/reserve/.env, or the local stack under SUPABASE_LOCAL=true.
 * Rows are tagged VERIFY-MSG-<run> and removed afterwards, even on failure.
 * A connection failure counts as FAIL, never as PASS.
 *
 *   node scripts/verify-messages.mjs
 */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LOCAL_MODE, ROOT, get, guard, pgSsl, supabaseEnv } from "./_env.mjs";
import { scrubTestStaff } from "./_cleanup.mjs";

const { url, anonKey, serviceKey } = supabaseEnv();
if (!LOCAL_MODE) {
  console.log("  skip  every case: this harness creates staff and grants roles, which writes append-only audit rows, so it runs on the LOCAL stack only (CLAUDE.md); nothing was run on this hosted stack");
  process.exit(0);
}
guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const DATABASE_URL = get("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("FATAL: need DATABASE_URL (or DB_URL / TBLS_DSN) for the constraint check");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const run = randomBytes(4).toString("hex");
const TAG = `VERIFY-MSG-${run}`;

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
async function must(p, what) {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Fixture: three staff members with real sessions
// ---------------------------------------------------------------------------
const created = { users: [], staff: [] };

async function staffMember(label) {
  const email = `verify-msg-${label}-${run}@verify.test`;
  const password = `vm-${randomBytes(12).toString("hex")}`;
  const { user } = await must(
    admin.auth.admin.createUser({ email, password, email_confirm: true }),
    `createUser ${label}`,
  );
  created.users.push(user.id);
  const row = await must(
    admin
      .from("staff")
      .insert({
        organization_id: ORG,
        user_id: user.id,
        display_name: `${TAG} ${label}`,
        email,
        bookable: false,
        active: true,
      })
      .select("id")
      .single(),
    `staff ${label}`,
  );
  created.staff.push(row.id);
  // A real session, the way the app gets one: GoTrue signs the password in.
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(client.auth.signInWithPassword({ email, password }), `signIn ${label}`);
  return { id: row.id, label, client };
}

let ORG;
try {
  // One real connection, or nothing is reported.
  const ping = await admin.from("organizations").select("id, name").order("created_at").limit(1);
  if (ping.error) throw new Error(ping.error.message);
  if (!ping.data?.length) throw new Error("no organizations row");
  ORG = ping.data[0].id;
  console.log(`connected; organisation "${ping.data[0].name}" (run ${run})\n`);
} catch (e) {
  console.log(`CANNOT CONNECT: ${e.message}`);
  console.log("No boundary checks were run.");
  process.exit(1);
}

/**
 * Two organisations, one approver each, one request. Everything it makes
 * is tracked and removed in its own finally (the second organisation's
 * role is created with is_system = false so the roles trigger lets it go).
 */
async function timeoffScoping() {
  const made = { orgs: [], locations: [], roles: [], staff: [], roleRows: [], requests: [] };
  const org = async (name, timezone) => {
    const o = await must(admin.from("organizations").insert({ name: `${TAG} ${name}`, timezone }).select("id").single(), `org ${name}`);
    made.orgs.push(o.id);
    await must(admin.from("locations").insert({ organization_id: o.id, name: `${TAG} ${name} spa`, timezone }).select("id").single(), `location ${name}`)
      .then((l) => made.locations.push(l.id));
    const role = await must(
      admin.from("roles").insert({ organization_id: o.id, name: `${TAG} approver`, is_system: false }).select("id").single(), `role ${name}`);
    made.roles.push(role.id);
    await must(admin.from("role_permissions").insert({ role_id: role.id, permission_key: "timeoff.approve" }), `role_permissions ${name}`);
    return { id: o.id, roleId: role.id, timezone };
  };
  const person = async (o, label, approver) => {
    const row = await must(
      admin.from("staff").insert({ organization_id: o.id, display_name: `${TAG} ${label}`, email: `${TAG}-${label}@verify.test`.toLowerCase(), bookable: false, active: true }).select("id").single(),
      `staff ${label}`);
    made.staff.push(row.id);
    if (approver) {
      await must(admin.from("staff_roles").insert({ staff_id: row.id, role_id: o.roleId }), `staff_roles ${label}`);
      made.roleRows.push({ staff_id: row.id, role_id: o.roleId });
    }
    return row.id;
  };
  try {
    const east = await org("east", "America/New_York");
    const west = await org("west", "America/Los_Angeles");
    const requester = await person(east, "requester", false);
    const eastApprover = await person(east, "east-approver", true);
    const westApprover = await person(west, "west-approver", true);

    const startsAt = "2026-11-10T19:30:00Z"; // 2:30 PM New York, 11:30 AM Los Angeles
    const req = await must(
      admin.from("availability_exceptions").insert({ staff_id: requester, created_by: requester, kind: "time_off", status: "requested", starts_at: startsAt, ends_at: "2026-11-10T21:30:00Z" }).select("id").single(),
      "time-off request");
    made.requests.push(req.id);

    const bellsFor = async (staffId) =>
      (await must(admin.from("notifications").select("body").eq("staff_id", staffId).eq("kind", "timeoff.requested"), "notifications")) ?? [];
    const eastBells = await bellsFor(eastApprover);
    check("the approver in the requester's organisation gets exactly one notification", eastBells.length === 1, `${eastBells.length} rows`);
    check("the approver in the OTHER organisation gets none (non-vacuous: they hold timeoff.approve too)", (await bellsFor(westApprover)).length === 0);
    check("the requester gets none", (await bellsFor(requester)).length === 0);
    check("the time is formatted in the requester's organisation's zone, not the other's",
      eastBells.length === 1 && eastBells[0].body.includes("2:30 PM") && !eastBells[0].body.includes("11:30 AM"), eastBells[0]?.body);
  } finally {
    for (const id of made.requests) await admin.from("availability_exceptions").delete().eq("id", id);
    if (made.staff.length) await admin.from("notifications").delete().in("staff_id", made.staff);
    for (const r of made.roleRows) await admin.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id);
    if (made.staff.length) await scrubTestStaff(DATABASE_URL, made.staff);
    if (made.staff.length) await admin.from("staff").delete().in("id", made.staff);
    for (const id of made.roles) {
      await admin.from("role_permissions").delete().eq("role_id", id);
      const { error } = await admin.from("roles").delete().eq("id", id);
      if (error) console.log(`  note  the second organisation's role could not be deleted: ${error.message}`);
    }
    if (made.locations.length) await admin.from("locations").delete().in("id", made.locations);
    for (const id of made.orgs) {
      const { error } = await admin.from("organizations").delete().eq("id", id);
      if (error) console.log(`  note  a test organisation could not be deleted: ${error.message}`);
    }
  }
}

try {
  const [A, B, C] = await Promise.all([staffMember("a"), staffMember("b"), staffMember("c")]);
  const participants = async (conv) =>
    (await must(admin.from("conversation_participants").select("staff_id").eq("conversation_id", conv), "participants"))
      .map((r) => r.staff_id)
      .sort();
  const exists = async (conv) =>
    (await must(admin.from("conversations").select("id").eq("id", conv).maybeSingle(), "conversation")) !== null;
  const bells = async (staffId, conv) =>
    (await must(
      admin.from("notifications").select("id").eq("staff_id", staffId).eq("kind", "message.received").eq("link", `/messages/${conv}`).is("read_at", null),
      "notifications",
    )).length;

  // ── 1. DMs are canonical ────────────────────────────────────────────
  console.log("DMs are canonical");
  const ab1 = await must(A.client.rpc("find_or_create_dm", { p_other_staff_id: B.id }), "A→B");
  const ab2 = await must(A.client.rpc("find_or_create_dm", { p_other_staff_id: B.id }), "A→B again");
  const ba = await must(B.client.rpc("find_or_create_dm", { p_other_staff_id: A.id }), "B→A");
  const ac = await must(A.client.rpc("find_or_create_dm", { p_other_staff_id: C.id }), "A→C");
  check("asking twice returns the same DM", ab1 === ab2, `${ab1} vs ${ab2}`);
  check("asking from the other side returns the same DM", ba === ab1, `${ba} vs ${ab1}`);
  check("a different pair is a different conversation (non-vacuous)", ac !== ab1);
  check("the DM holds exactly the two of them", JSON.stringify(await participants(ab1)) === JSON.stringify([A.id, B.id].sort()));
  const self = await A.client.rpc("find_or_create_dm", { p_other_staff_id: A.id });
  check("a DM to yourself is refused", !!self.error, self.error?.message ?? "succeeded");
  const ghost = await A.client.rpc("find_or_create_dm", { p_other_staff_id: "00000000-0000-4000-8000-000000000000" });
  check("a DM to an unknown staff member is refused", !!ghost.error, ghost.error?.message ?? "succeeded");
  const rlsOutsider = await must(C.client.from("conversations").select("id").eq("id", ab1), "C reads A↔B");
  check("a non-participant cannot read the DM (RLS)", rlsOutsider.length === 0, `C saw ${rlsOutsider.length}`);
  const rlsMember = await must(B.client.from("conversations").select("id").eq("id", ab1), "B reads A↔B");
  check("a participant can read it (non-vacuous)", rlsMember.length === 1);

  // ── 2. Groups ───────────────────────────────────────────────────────
  console.log("\ngroups");
  const group = await must(A.client.rpc("create_group_conversation", { p_name: `${TAG} group`, p_staff_ids: [B.id, C.id] }), "group");
  check("a group holds exactly the people named, creator included", JSON.stringify(await participants(group)) === JSON.stringify([A.id, B.id, C.id].sort()));
  const dupes = await must(A.client.rpc("create_group_conversation", { p_name: "", p_staff_ids: [B.id, B.id, A.id] }), "group with repeats");
  const dupeMembers = await participants(dupes);
  check("repeats and the creator's own id collapse to one row each", JSON.stringify(dupeMembers) === JSON.stringify([A.id, B.id].sort()), `${dupeMembers.length} rows`);
  const dupeRow = await must(admin.from("conversations").select("name, kind").eq("id", dupes).single(), "group row");
  check("an empty name is stored as null, kind is group", dupeRow.name === null && dupeRow.kind === "group");
  const empty = await A.client.rpc("create_group_conversation", { p_name: "x", p_staff_ids: [] });
  check("a group with nobody named is refused", !!empty.error, empty.error?.message ?? "succeeded");
  const cSees = await must(C.client.from("conversations").select("id").eq("id", dupes), "C reads A+B group");
  check("someone outside a group cannot see it (RLS)", cSees.length === 0, `C saw ${cSees.length}`);
  const bSees = await must(B.client.from("conversations").select("id").eq("id", dupes), "B reads A+B group");
  check("a member can (non-vacuous)", bSees.length === 1);

  // ── 3. Unread is derived; mark-read clears it for the reader only ──
  console.log("\nunread and mark-read");
  const sent = await must(
    A.client.from("messages").insert({ conversation_id: group, sender_staff_id: A.id, body: `${TAG} hello` }).select("id, created_at").single(),
    "A sends",
  );
  const bRow = async () =>
    await must(admin.from("conversation_participants").select("last_read_at").eq("conversation_id", group).eq("staff_id", B.id).single(), "B row");
  const before = await bRow();
  const unreadBefore = !before.last_read_at || Date.parse(before.last_read_at) < Date.parse(sent.created_at);
  check("B is unread after A's message (last_read_at behind the message)", unreadBefore);
  check("B got one bell entry", (await bells(B.id, group)) === 1);
  check("C got one bell entry", (await bells(C.id, group)) === 1);
  check("the sender got none", (await bells(A.id, group)) === 0);
  await must(A.client.from("messages").insert({ conversation_id: group, sender_staff_id: A.id, body: `${TAG} again` }), "A sends again");
  check("a second message does not add a second bell entry (dedupe)", (await bells(B.id, group)) === 1);
  const forged = await C.client.from("messages").insert({ conversation_id: group, sender_staff_id: A.id, body: "forged" });
  check("a message cannot be sent as someone else (RLS)", !!forged.error, forged.error?.message ?? "succeeded");
  const stranger = await must(
    admin.from("conversation_participants").select("staff_id").eq("conversation_id", ab1),
    "A↔B",
  );
  void stranger;
  const intruder = await C.client.from("messages").insert({ conversation_id: ab1, sender_staff_id: C.id, body: "intruding" });
  check("a non-participant cannot post into a conversation (RLS)", !!intruder.error, intruder.error?.message ?? "succeeded");

  await must(B.client.rpc("mark_conversation_read", { p_conversation_id: group }), "B marks read");
  const after = await bRow();
  const latest = await must(admin.from("messages").select("created_at").eq("conversation_id", group).order("created_at", { ascending: false }).limit(1).single(), "latest");
  check("mark-read moves B's last_read_at past the latest message", !!after.last_read_at && Date.parse(after.last_read_at) >= Date.parse(latest.created_at));
  check("mark-read clears B's bell entry", (await bells(B.id, group)) === 0);
  check("C's bell entry survives B's mark-read (reader only, non-vacuous)", (await bells(C.id, group)) === 1);
  const cross = await must(
    C.client.from("conversation_participants").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", group).eq("staff_id", B.id).select("staff_id"),
    "C updates B's row",
  );
  check("one participant cannot mark another's row read (RLS: own row only)", cross.length === 0, `${cross.length} rows updated`);

  // ── 4. Leaving, and garbage collection on the last one out ─────────
  console.log("\nleaving");
  await must(C.client.rpc("leave_conversation", { p_conversation_id: group }), "C leaves");
  check("C is gone from the group", !(await participants(group)).includes(C.id));
  check("C's bell entry is cleared on leaving", (await bells(C.id, group)) === 0);
  check("the conversation still exists with people in it", await exists(group));
  const msgCount = async () => (await must(admin.from("messages").select("id").eq("conversation_id", group), "messages")).length;
  check("its messages are intact", (await msgCount()) === 2);
  const cBack = await must(C.client.from("conversations").select("id").eq("id", group), "C after leaving");
  check("after leaving, C can no longer read it (RLS)", cBack.length === 0);
  await must(B.client.rpc("leave_conversation", { p_conversation_id: group }), "B leaves");
  check("two out, one left: still not collected (non-vacuous)", (await exists(group)) && (await participants(group)).length === 1);
  await must(A.client.rpc("leave_conversation", { p_conversation_id: group }), "A leaves last");
  check("the last one out garbage-collects the conversation", !(await exists(group)));
  check("its messages cascaded away", (await msgCount()) === 0);
  const dmAlive = await exists(ab1);
  check("other conversations are untouched", dmAlive && (await exists(ac)) && (await exists(dupes)));

  // ── 5. Prospect status: the TypeScript and the check constraint agree ──
  console.log("\nprospect status vocabulary == check constraint (two languages, one predicate)");
  const c = new pg.Client({ connectionString: DATABASE_URL, ssl: pgSsl(DATABASE_URL) });
  await c.connect();
  try {
    const { rows } = await c.query(`select pg_get_constraintdef(oid) def from pg_constraint where conname = $1`, ["prospect_intake_status_check"]);
    const dbSet = [...(rows[0]?.def ?? "").matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    // No single constant holds the vocabulary: the review route decides the
    // transitions, the queue composable decides what counts as undecided.
    // Their union is what the TypeScript knows; it must be exactly the DB's set.
    const route = readFileSync(`${ROOT}/apps/reserve/server/api/prospects/[id]/review.post.ts`, "utf8");
    const queue = readFileSync(`${ROOT}/apps/reserve/app/composables/useProspectQueue.ts`, "utf8");
    const listOf = (src, name) => {
      const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
      return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    };
    const allowed = listOf(route, "const ALLOWED");
    const undecided = listOf(queue, "UNDECIDED_STATUSES");
    const tsSet = [...new Set([...allowed, ...undecided])].sort();
    check("both TypeScript sets were found (non-vacuous)", allowed.length > 0 && undecided.length > 0, `allowed=${allowed} undecided=${undecided}`);
    check("the constraint was found", dbSet.length > 0);
    check("TypeScript's union equals prospect_intake_status_check exactly", JSON.stringify(tsSet) === JSON.stringify(dbSet), `db=${dbSet} ts=${tsSet}`);
    check("every TS status is a real DB status", tsSet.every((s) => dbSet.includes(s)));
    check("every DB status is known to the TS (none unreachable)", dbSet.every((s) => tsSet.includes(s)));
  } finally {
    await c.end().catch(() => {});
  }
  // ── 6. The time-off bell is scoped to the requester's organisation ──
  // notify_timeoff_requested() once rang every approver in every
  // organisation (timeoff_bell_scoped_to_organization migration). Two
  // organisations with different zones, one approver each, a request in
  // the first: only the first's approver hears it, in the first's zone.
  // LOCAL STACK ONLY: it creates a second organisation, which a harness
  // must never do to the hosted project. Skipped there, counted as neither.
  console.log("\ntime-off bell scoping (two organisations)");
  if (!LOCAL_MODE) {
    console.log("  skip  time-off bell scoping (needs the local stack: creates a second organisation)");
  } else {
    await timeoffScoping();
  }
} catch (e) {
  failed++;
  failures.push(`harness error: ${e.message}`);
  console.log(`\n  FAIL  harness error — ${e.message}`);
} finally {
  // Cleanup, newest dependents first. Conversations cascade their
  // participants and messages; notifications and staff go by id; auth
  // users last.
  if (created.staff.length) {
    await admin.from("conversations").delete().in("created_by", created.staff);
    await admin.from("notifications").delete().in("staff_id", created.staff);
    await scrubTestStaff(DATABASE_URL, created.staff); // what the roles trigger wrote about them
    await admin.from("staff").delete().in("id", created.staff);
  }
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
