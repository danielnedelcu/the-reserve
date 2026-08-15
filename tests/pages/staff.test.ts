// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import StaffPage from "~/pages/staff.vue";

// ---- Mocks -----------------------------------------------------------------

// Controllable permission set per test
const permissionSet = vi.hoisted(() => ({ value: new Set<string>() }));
mockNuxtImport("usePermissions", () => () => ({
  can: (key: string) => permissionSet.value.has(key),
  canAny: (...keys: string[]) => keys.some((k) => permissionSet.value.has(k)),
  load: vi.fn(async () => {}),
  reset: vi.fn(),
  ready: computed(() => true),
  permissions: readonly(ref<string[]>([])),
}));

// Supabase: canned query results keyed by table
const staffRows = [
  {
    id: "s1",
    display_name: "Daniel",
    email: "daniel@thereserve.com",
    title: null,
    bookable: false,
    active: true,
    staff_roles: [{ roles: { id: "r1", name: "super_admin" } }],
  },
  {
    id: "s2",
    display_name: "Maria",
    email: "maria@thereserve.com",
    title: "Massage Therapist",
    bookable: true,
    active: false,
    staff_roles: [{ roles: { id: "r2", name: "provider" } }],
  },
];

function queryStub(result: unknown[]) {
  // Chainable stub covering .select/.order/.is/.eq/.update used by the page;
  // resolves like a Supabase response at await time.
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    order: self,
    is: self,
    eq: self,
    update: self,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: result, error: null }),
  });
  return chain;
}

mockNuxtImport("useSupabaseClient", () => () => ({
  from: (table: string) => {
    if (table === "staff") return queryStub(staffRows);
    if (table === "roles")
      return queryStub([
        { id: "r1", name: "super_admin" },
        { id: "r2", name: "provider" },
      ]);
    if (table === "staff_invites") return queryStub([]);
    return queryStub([]);
  },
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
mockNuxtImport("useToast", () => () => toastMock);

// ---- Tests -----------------------------------------------------------------

describe("staff page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSet.value = new Set(["staff.view"]);
  });

  it("renders the directory with active staff only by default", async () => {
    const wrapper = await mountSuspended(StaffPage);
    expect(wrapper.text()).toContain("Daniel");
    expect(wrapper.text()).not.toContain("Maria"); // inactive, hidden by default
  });

  it("hides the invite form without staff.invite", async () => {
    const wrapper = await mountSuspended(StaffPage);
    expect(wrapper.text()).not.toContain("Invite an employee");
  });

  it("shows the invite form with staff.invite", async () => {
    permissionSet.value = new Set(["staff.view", "staff.invite"]);
    const wrapper = await mountSuspended(StaffPage);
    expect(wrapper.text()).toContain("Invite an employee");
  });

  it("hides deactivate actions without staff.deactivate", async () => {
    const wrapper = await mountSuspended(StaffPage);
    expect(wrapper.text()).not.toContain("Deactivate");
  });

  it("shows role badges from the joined data", async () => {
    const wrapper = await mountSuspended(StaffPage);
    expect(wrapper.text()).toContain("Super Admin");
  });
});
