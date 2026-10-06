import { randomBytes } from "node:crypto";
import { testEnv, type TestEnv } from "./env";

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
  readonly run = randomBytes(4).toString("hex");
  readonly tag = `E2E-${this.run}`;
  private users: string[] = [];
  private staff: string[] = [];
  private roleRows: { staff_id: string; role_id: string }[] = [];
  private clients: string[] = [];
  private services: string[] = [];
  private locationTimezone: { id: string; timezone: string } | null = null;

  private constructor(readonly env: TestEnv, readonly orgId: string) {}

  static async create(): Promise<TestData> {
    const env = testEnv();
    const org = await must(env.db.from("organizations").select("id").order("created_at").limit(1).single(), "seeded organisation");
    return new TestData(env, org.id as string);
  }

  /** A staff member with a password and the named seeded role. */
  async staffMember(label: string, role: RoleName): Promise<TestStaff> {
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
    const roleRow = await must(
      this.env.db.from("roles").select("id").eq("organization_id", this.orgId).eq("name", role).single(),
      `role ${role}`,
    );
    // An insert without select() returns no row; only the error matters.
    const { error: roleError } = await this.env.db.from("staff_roles").insert({ staff_id: row.id, role_id: roleRow.id });
    if (roleError) throw new Error(`staff_roles ${label}: ${roleError.message}`);
    this.roleRows.push({ staff_id: row.id as string, role_id: roleRow.id as string });
    return { id: row.id as string, userId: made.user.id, email, password, displayName };
  }

  /** A client in the seeded organisation, tagged. */
  async client(firstName: string, lastName = this.tag): Promise<{ id: string; firstName: string; lastName: string }> {
    const row = await must(
      this.env.db.from("clients").insert({ organization_id: this.orgId, first_name: firstName, last_name: lastName }).select("id").single(),
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
    if (this.clients.length) {
      await step("communications_sent", () => this.env.db.from("communications_sent").delete().in("client_id", this.clients));
      await step("appointments", () => this.env.db.from("appointments").delete().in("client_id", this.clients));
      await step("clients", () => this.env.db.from("clients").delete().in("id", this.clients));
    }
    if (this.services.length) await step("services", () => this.env.db.from("services").delete().in("id", this.services));
    for (const r of this.roleRows) {
      await step("staff_roles", () => this.env.db.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id));
    }
    if (this.staff.length) await step("staff", () => this.env.db.from("staff").delete().in("id", this.staff));
    for (const id of this.users) await step("auth user", () => this.env.db.auth.admin.deleteUser(id));
    if (this.locationTimezone) {
      const { id, timezone } = this.locationTimezone;
      await step("location timezone", () => this.env.db.from("locations").update({ timezone }).eq("id", id));
    }
    if (failures.length) throw new Error(`Test data was not fully removed (${this.tag}):\n  ${failures.join("\n  ")}`);
  }
}
