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

  async cleanup(): Promise<void> {
    // Dependents first. Notifications cascade with their staff row.
    if (this.clients.length) await this.env.db.from("clients").delete().in("id", this.clients);
    for (const r of this.roleRows) await this.env.db.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id);
    if (this.staff.length) await this.env.db.from("staff").delete().in("id", this.staff);
    for (const id of this.users) await this.env.db.auth.admin.deleteUser(id);
  }
}
