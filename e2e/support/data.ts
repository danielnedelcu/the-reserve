import { randomBytes } from "node:crypto";
import { testEnv, type TestEnv } from "./env";
import { get } from "../../scripts/_env.mjs";
import { removeTestOrganisation, scrubTestStaff } from "../../scripts/_cleanup.mjs";

/**
 * Test data for one journey, on the LOCAL stack, tagged with a run id and
 * removed afterwards (the `data` fixture's finally). Rows are written with
 * the service role; the journey then exercises them as a person would.
 *
 * The first builder is a staff member — The Reserve's app is staff-only
 * and invitation-only, so every journey starts from one — created the way
 * accept_staff_invite leaves one: an auth user with a password, a `staff`
 * row in the seeded organisation, and a `staff_roles` row for the role
 * under test, which is what decides what the person may see and do.
 *
 * Two shapes (docs/testing-design.md, "The money journeys"):
 * - `TestData.create()`: rows in the SEEDED organisation, removed one
 *   table at a time through the service role. For journeys that write no
 *   ledger row.
 * - `TestData.createOrganisation()`: the run's OWN organisation — a
 *   location, the four system roles with the seeded permission matrix —
 *   so every row the journey writes, ledger lines and payments included,
 *   carries that organisation's id, and cleanup removes the whole
 *   organisation on the direct postgres connection in replica mode
 *   (removeTestOrganisation). The money journeys use this: the ledger is
 *   append-only for every role and every key out of it is restrict, so
 *   nothing a sale wrote can be deleted any other way, and a fresh
 *   organisation makes every figure on /financials exact.
 */

export type RoleName = "super_admin" | "admin" | "front_desk" | "provider";

export interface TestStaff {
  id: string;
  userId: string;
  email: string;
  password: string;
  displayName: string;
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  if (data === null || data === undefined) throw new Error(`${what}: no row`);
  return data;
}

export class TestData {
  readonly tag: string;
  private users: string[] = [];
  private staff: string[] = [];
  private roleRows: { staff_id: string; role_id: string }[] = [];
  private roles: string[] = [];
  private clients: string[] = [];
  private services: string[] = [];
  private products: string[] = [];
  private giftCards: string[] = [];
  private bulkClients = false;
  private locationTimezone: { id: string; timezone: string } | null = null;

  private constructor(
    readonly env: TestEnv,
    readonly orgId: string,
    readonly run: string,
    /** Set when the run OWNS its organisation (createOrganisation): its location, and the whole organisation goes at cleanup. */
    private readonly owned: { locationId: string; timezone: string } | null,
  ) {
    this.tag = `E2E-${run}`;
  }

  static async create(): Promise<TestData> {
    const env = testEnv();
    const org = await must(env.db.from("organizations").select("id").order("created_at").limit(1).single(), "seeded organisation");
    return new TestData(env, org.id as string, randomBytes(4).toString("hex"), null);
  }

  /**
   * The run's own organisation: a location in the given zone with the
   * given tax rate, and the four system roles carrying the SEEDED
   * organisation's permission matrix (copied by role name, so the matrix
   * the app ships is what the journey tests). Everything a journey makes
   * from here belongs to this organisation and no other journey can see it.
   */
  static async createOrganisation(opts: { timezone?: string; taxRateBps?: number } = {}): Promise<TestData> {
    const env = testEnv();
    const run = randomBytes(4).toString("hex");
    const tag = `E2E-${run}`;
    const timezone = opts.timezone ?? "America/New_York";
    const seeded = await must(env.db.from("organizations").select("id").order("created_at").limit(1).single(), "seeded organisation");
    const org = await must(env.db.from("organizations").insert({ name: `${tag} Club`, timezone }).select("id").single(), "organisation");
    const orgId = org.id as string;
    const location = await must(
      env.db.from("locations").insert({ organization_id: orgId, name: `${tag} Main`, timezone, tax_rate_bps: opts.taxRateBps ?? 800 }).select("id").single(),
      "location",
    );
    const seededRoles = await must(env.db.from("roles").select("id, name, is_system").eq("organization_id", seeded.id as string), "seeded roles");
    for (const r of seededRoles as { id: string; name: string; is_system: boolean }[]) {
      const made = await must(env.db.from("roles").insert({ organization_id: orgId, name: r.name, is_system: r.is_system }).select("id").single(), `role ${r.name}`);
      const keys = await must(env.db.from("role_permissions").select("permission_key").eq("role_id", r.id), `permissions of ${r.name}`);
      if ((keys as { permission_key: string }[]).length) {
        const { error } = await env.db.from("role_permissions").insert((keys as { permission_key: string }[]).map((k) => ({ role_id: made.id, permission_key: k.permission_key })));
        if (error) throw new Error(`role_permissions ${r.name}: ${error.message}`);
      }
    }
    return new TestData(env, orgId, run, { locationId: location.id as string, timezone });
  }

  /** The run's own location (createOrganisation only). */
  get location(): { id: string; timezone: string } {
    if (!this.owned) throw new Error("location: this run uses the seeded organisation; call locationInZone() instead");
    return { id: this.owned.locationId, timezone: this.owned.timezone };
  }

  /** A role made for the run with exactly these permission keys (for a case no seeded role expresses). */
  async role(name: string, keys: string[]): Promise<{ id: string; name: string }> {
    const row = await must(this.env.db.from("roles").insert({ organization_id: this.orgId, name: `${this.tag} ${name}`, is_system: false }).select("id").single(), `role ${name}`);
    this.roles.push(row.id as string);
    if (keys.length) {
      const { error } = await this.env.db.from("role_permissions").insert(keys.map((k) => ({ role_id: row.id, permission_key: k })));
      if (error) throw new Error(`role_permissions ${name}: ${error.message}`);
    }
    return { id: row.id as string, name: `${this.tag} ${name}` };
  }

  /** A staff member with a password and the named seeded role, or a role made for the run (`{ roleId }`). */
  async staffMember(label: string, role: RoleName | { roleId: string }): Promise<TestStaff> {
    const email = `e2e-${label}-${this.run}@reserve.test`;
    const password = `e2e-${randomBytes(12).toString("hex")}`;
    const displayName = `${this.tag} ${label}`;
    const { data: made, error } = await this.env.db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !made.user) throw new Error(`The test user was not created: ${error?.message ?? "no user"}`);
    this.users.push(made.user.id);
    const row = await must(
      this.env.db
        .from("staff")
        .insert({ organization_id: this.orgId, user_id: made.user.id, display_name: displayName, email, bookable: role === "provider", active: true })
        .select("id")
        .single(),
      `staff ${label}`,
    );
    this.staff.push(row.id as string);
    const roleId =
      typeof role === "string"
        ? ((await must(this.env.db.from("roles").select("id").eq("organization_id", this.orgId).eq("name", role).single(), `role ${role}`)).id as string)
        : role.roleId;
    // An insert without select() returns no row; only the error matters.
    const { error: roleError } = await this.env.db.from("staff_roles").insert({ staff_id: row.id, role_id: roleId });
    if (roleError) throw new Error(`staff_roles ${label}: ${roleError.message}`);
    this.roleRows.push({ staff_id: row.id as string, role_id: roleId });
    return { id: row.id as string, userId: made.user.id, email, password, displayName };
  }

  /** A client in the seeded organisation, tagged. */
  async client(
    firstName: string,
    lastName = this.tag,
    extra: { active?: boolean; email?: string; phone?: string; date_of_birth?: string; stripe_customer_id?: string; late_cancellation_waiver_used?: boolean } = {},
  ): Promise<{ id: string; firstName: string; lastName: string }> {
    const row = await must(
      this.env.db
        .from("clients")
        .insert({ organization_id: this.orgId, first_name: firstName, last_name: lastName, ...extra })
        .select("id")
        .single(),
      `client ${firstName}`,
    );
    this.clients.push(row.id as string);
    return { id: row.id as string, firstName, lastName };
  }

  /** Track a client the journey made through the UI, so cleanup takes it. */
  trackClient(id: string): void {
    this.clients.push(id);
  }

  /**
   * Many clients at once, tagged through referral_source so cleanup takes
   * them with one filtered delete (that many ids in a URL would fail
   * silently). Last names `${prefix}-${tag}-00001` … sort together, so a
   * client named after them sorts past the first thousand — the case the
   * old load-everything pickers could not reach.
   */
  async clientsBulk(count: number, prefix = "Aa"): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
      organization_id: this.orgId,
      first_name: "Filler",
      last_name: `${prefix}-${this.tag}-${String(i + 1).padStart(5, "0")}`,
      referral_source: this.tag,
    }));
    for (let at = 0; at < rows.length; at += 1000) {
      const { error } = await this.env.db.from("clients").insert(rows.slice(at, at + 1000));
      if (error) throw new Error(`clientsBulk: ${error.message}`);
    }
    this.bulkClients = true;
  }

  /** A retail product in the seeded organisation, named with the tag (names are unique per organisation). */
  async product(
    name: string,
    extra: { sku?: string; price_cents?: number; cost_cents?: number; stock_quantity?: number; active?: boolean; taxable?: boolean } = {},
  ): Promise<{ id: string; name: string }> {
    const fullName = `${this.tag} ${name}`;
    const row = await must(
      this.env.db
        .from("products")
        .insert({ organization_id: this.orgId, name: fullName, price_cents: 1_000, ...extra })
        .select("id")
        .single(),
      `product ${name}`,
    );
    this.products.push(row.id as string);
    return { id: row.id as string, name: fullName };
  }

  /** A gift card with a balance, the way a sale leaves one (a code the front desk can type). */
  async giftCard(amountCents: number, extra: { code?: string; recipientName?: string } = {}): Promise<{ id: string; code: string }> {
    const code = extra.code ?? `E2E${this.run.slice(0, 1).toUpperCase()}-${this.run.slice(1, 5).toUpperCase()}-${this.run.slice(5, 8).toUpperCase()}X-TEST`;
    const row = await must(
      this.env.db
        .from("gift_cards")
        .insert({ organization_id: this.orgId, code, initial_balance_cents: amountCents, balance_cents: amountCents, recipient_name: extra.recipientName ?? null })
        .select("id")
        .single(),
      "gift card",
    );
    this.giftCards.push(row.id as string);
    return { id: row.id as string, code };
  }

  /**
   * The seeded location, placed in the given timezone for this run and put
   * back at cleanup. The slots and booking routes read the organisation's
   * first location (`.limit(1)`), so a second location made for the run
   * would not reliably be the one they use; the seeded one is moved
   * instead. One worker, so nothing else is reading it meanwhile.
   *
   * The point is the zone: the browser runs in America/Los_Angeles
   * (playwright.config.ts) and the location must NOT, so a time the page
   * shows equal to the location's cannot be the browser's by luck.
   */
  async locationInZone(timezone: string): Promise<{ id: string; timezone: string }> {
    const loc = await must(
      this.env.db.from("locations").select("id, timezone").eq("organization_id", this.orgId).order("created_at").limit(1).single(),
      "seeded location",
    );
    if (!this.locationTimezone) this.locationTimezone = { id: loc.id as string, timezone: loc.timezone as string };
    const { error } = await this.env.db.from("locations").update({ timezone }).eq("id", loc.id);
    if (error) throw new Error(`location timezone: ${error.message}`);
    return { id: loc.id as string, timezone };
  }

  /**
   * A bookable service the given provider is qualified for: no intake
   * required (the seeded example service needs a completed consent form
   * first) and no room requirement, so the booking depends on nothing but
   * the provider's hours.
   */
  async service(name: string, staffId: string, durationMinutes = 60): Promise<{ id: string; name: string }> {
    const fullName = `${this.tag} ${name}`;
    const row = await must(
      this.env.db
        .from("services")
        .insert({
          organization_id: this.orgId,
          name: fullName,
          duration_minutes: durationMinutes,
          buffer_before_min: 0,
          buffer_after_min: 0,
          price_cents: 10_000,
          requires_intake: false,
        })
        .select("id")
        .single(),
      `service ${name}`,
    );
    this.services.push(row.id as string);
    const { error } = await this.env.db.from("service_staff").insert({ service_id: row.id, staff_id: staffId });
    if (error) throw new Error(`service_staff ${name}: ${error.message}`);
    return { id: row.id as string, name: fullName };
  }

  /**
   * An appointment written directly, the way the booking route leaves one
   * (blocked window = service window, a service line with a name
   * snapshot), at an INSTANT the journey chooses — so a journey can put
   * one at 12:30 AM in the location's zone without going through the
   * slots route. Removed with its client (appointments cascade their
   * lines). With `withCancelToken`, also the cancellation token the
   * booking route mints beside it (the link in the confirmation email,
   * which a test reads from the database: the app mails through Resend's
   * HTTP API, so no local mail catcher ever sees it), expiring after the
   * appointment, as the route sets it.
   */
  async appointment(args: {
    clientId: string;
    staffId: string;
    locationId: string;
    serviceId: string;
    serviceName: string;
    startsAt: Date;
    durationMinutes?: number;
    withCancelToken?: boolean;
  }): Promise<{ id: string; tokenId: string | null }> {
    const duration = args.durationMinutes ?? 60;
    const endsAt = new Date(args.startsAt.getTime() + duration * 60_000);
    const row = await must(
      this.env.db
        .from("appointments")
        .insert({
          organization_id: this.orgId,
          location_id: args.locationId,
          client_id: args.clientId,
          staff_id: args.staffId,
          blocked_from: args.startsAt.toISOString(),
          blocked_until: endsAt.toISOString(),
          starts_at: args.startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          booked_by: args.staffId,
        })
        .select("id")
        .single(),
      "appointment",
    );
    const { error } = await this.env.db
      .from("appointment_services")
      .insert({ appointment_id: row.id, service_id: args.serviceId, name_snapshot: args.serviceName, price_cents: 10_000, duration_min: duration });
    if (error) throw new Error(`appointment_services: ${error.message}`);
    let tokenId: string | null = null;
    if (args.withCancelToken) {
      const token = await must(
        this.env.db
          .from("cancellation_tokens")
          .insert({ organization_id: this.orgId, appointment_id: row.id, expires_at: new Date(endsAt.getTime() + 86_400_000).toISOString() })
          .select("id")
          .single(),
        "cancellation token",
      );
      tokenId = token.id as string;
    }
    return { id: row.id as string, tokenId };
  }

  /**
   * Weekly hours for a provider at a location, the same window every day
   * of the week, so the journey can book on whatever day "today" is. Times
   * are LOCAL to the location, as availability_rules stores them.
   */
  async hours(staffId: string, locationId: string, start: string, end: string): Promise<void> {
    const validFrom = new Date(Date.now() - 2 * 86_400_000).toLocaleDateString("en-CA");
    const rows = Array.from({ length: 7 }, (_, day) => ({
      staff_id: staffId,
      location_id: locationId,
      day_of_week: day,
      start_time: start,
      end_time: end,
      valid_from: validFrom,
    }));
    const { error } = await this.env.db.from("availability_rules").insert(rows);
    if (error) throw new Error(`availability_rules: ${error.message}`);
    // Rules cascade with the staff row; nothing to track.
  }

  /**
   * Dependents first. Notifications cascade with their staff row;
   * appointment line items and cancel tokens with their appointment.
   * Every step runs even if an earlier one fails, and a failure is
   * thrown at the end: a row that cannot be removed must fail the run,
   * not accumulate quietly. (A super_admin fixture did exactly that — the
   * last-super-admin trigger refused the delete, nothing reported it, and
   * the row then counted as "another super admin" for every later run.)
   */
  async cleanup(): Promise<void> {
    const failures: string[] = [];
    const step = async (what: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await run();
      if (error) failures.push(`${what}: ${error.message}`);
    };
    if (this.owned) {
      // The run's own organisation, whole: every row carrying its id and
      // every child reached through a foreign key, in one replica-mode
      // transaction on the direct connection, then the catalog-driven
      // checks (scripts/_cleanup.mjs). Auth users are not in Postgres' public
      // schema and go through the admin API.
      try {
        await removeTestOrganisation(get("DATABASE_URL") as string, this.orgId);
      } catch (e) {
        failures.push(`organisation: ${(e as Error).message}`);
      }
      for (const id of this.users) await step("auth user", () => this.env.db.auth.admin.deleteUser(id));
      if (failures.length) throw new Error(`Test organisation was not fully removed (${this.tag}):\n  ${failures.join("\n  ")}`);
      return;
    }
    if (this.clients.length) {
      await step("communications_sent", () => this.env.db.from("communications_sent").delete().in("client_id", this.clients));
      await step("appointments", () => this.env.db.from("appointments").delete().in("client_id", this.clients));
      await step("clients", () => this.env.db.from("clients").delete().in("id", this.clients));
    }
    if (this.bulkClients) await step("bulk clients", () => this.env.db.from("clients").delete().eq("referral_source", this.tag));
    if (this.services.length) await step("services", () => this.env.db.from("services").delete().in("id", this.services));
    if (this.products.length) await step("products", () => this.env.db.from("products").delete().in("id", this.products));
    if (this.giftCards.length) await step("gift cards", () => this.env.db.from("gift_cards").delete().in("id", this.giftCards));
    for (const r of this.roleRows) {
      await step("staff_roles", () => this.env.db.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id));
    }
    if (this.staff.length) {
      // What a test staff member DID is referenced by audit_log.actor_staff_id
      // with no cascade (a booking writes one), and the staff_roles trigger
      // wrote rows ABOUT them. audit_log is append-only for every role, so
      // the run's rows go through the direct postgres connection in replica
      // mode, roles revoked silently first, local only (scripts/_cleanup.mjs).
      await step("audit_log", () =>
        scrubTestStaff(get("DATABASE_URL") as string, this.staff).then(
          () => ({ error: null }),
          (e: Error) => ({ error: { message: e.message } }),
        ));
      await step("staff", () => this.env.db.from("staff").delete().in("id", this.staff));
    }
    for (const id of this.users) await step("auth user", () => this.env.db.auth.admin.deleteUser(id));
    for (const id of this.roles) {
      await step("role permissions", () => this.env.db.from("role_permissions").delete().eq("role_id", id));
      await step("role", () => this.env.db.from("roles").delete().eq("id", id));
    }
    if (this.locationTimezone) {
      const { id, timezone } = this.locationTimezone;
      await step("location timezone", () => this.env.db.from("locations").update({ timezone }).eq("id", id));
    }
    if (failures.length) throw new Error(`Test data was not fully removed (${this.tag}):\n  ${failures.join("\n  ")}`);
  }
}
