// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import StaffProfile from "~/pages/staff/[id].vue";

// ---- Mocks -----------------------------------------------------------------

const permissionSet = vi.hoisted(() => ({ value: new Set<string>() }));
const MY_STAFF_ID = "me-1";

mockNuxtImport("usePermissions", () => () => ({
  can: (key: string) => permissionSet.value.has(key),
  canAny: (...keys: string[]) => keys.some((k) => permissionSet.value.has(k)),
  load: vi.fn(async () => {}),
  reset: vi.fn(),
  ready: computed(() => true),
  permissions: readonly(ref<string[]>([])),
}));

// Route param: viewing staff member "s2" (not me, by default)
mockNuxtImport("useRoute", () => () => ({
  params: { id: "s2" },
  path: "/staff/s2",
  fullPath: "/staff/s2",
  query: {},
  meta: {},
}));

const memberRow = {
  id: "s2",
  display_name: "Maria",
  email: "maria@thereserve.com",
  title: "Massage Therapist",
  bookable: true,
  active: true,
  staff_roles: [{ roles: { name: "provider" } }],
};
const rules = [
  { id: "r1", day_of_week: 2, start_time: "09:00:00", end_time: "17:00:00" },
];
const exceptions = [
  {
    id: "e1",
    starts_at: new Date(Date.now() + 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    kind: "time_off",
    status: "requested",
    note: "Family trip",
  },
];

function queryStub(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    order: self,
    eq: self,
    gte: self,
    limit: self,
    maybeSingle: async () => ({
      data: Array.isArray(result) ? (result[0] ?? null) : result,
      error: null,
    }),
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      resolve({ data: result, error: null }),
  });
  return chain;
}

mockNuxtImport("useSupabaseClient", () => () => ({
  from: (table: string) => {
    if (table === "staff") return queryStub(memberRow);
    if (table === "availability_rules") return queryStub(rules);
    if (table === "availability_exceptions") return queryStub(exceptions);
    if (table === "locations")
      return queryStub({ id: "loc1", name: "Main Location" });
    return queryStub([]);
  },
  rpc: vi.fn(async () => ({ data: MY_STAFF_ID, error: null })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
mockNuxtImport("useToast", () => () => toastMock);

// ---- Tests -----------------------------------------------------------------

describe("staff profile page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSet.value = new Set(["staff.view"]);
  });

  it("renders the member and their weekly hours", async () => {
    const wrapper = await mountSuspended(StaffProfile);
    expect(wrapper.text()).toContain("Maria");
    expect(wrapper.text()).toContain("Tuesday");
    expect(wrapper.text()).toContain("09:00–17:00");
    expect(wrapper.text()).toContain("Not working"); // days without rules
  });

  it("hides hour editing without availability permissions", async () => {
    const wrapper = await mountSuspended(StaffProfile);
    expect(wrapper.text()).not.toContain("Add hours");
  });

  it("shows hour editing with availability.edit.any", async () => {
    permissionSet.value = new Set(["staff.view", "availability.edit.any"]);
    const wrapper = await mountSuspended(StaffProfile);
    expect(wrapper.text()).toContain("Add hours");
  });

  it("lists time-off with status badge", async () => {
    const wrapper = await mountSuspended(StaffProfile);
    expect(wrapper.text()).toContain("Time off");
    expect(wrapper.text()).toContain("requested");
    expect(wrapper.text()).toContain("Family trip");
  });

  it("shows approve/deny only to approvers", async () => {
    const wrapper = await mountSuspended(StaffProfile);
    expect(wrapper.text()).not.toContain("Approve");

    permissionSet.value = new Set(["staff.view", "timeoff.approve"]);
    const wrapper2 = await mountSuspended(StaffProfile);
    expect(wrapper2.text()).toContain("Approve");
    expect(wrapper2.text()).toContain("Deny");
  });

  it("hides the request form for other people's profiles without edit.any", async () => {
    // Viewing s2 while being me-1, with only own-scope permissions
    permissionSet.value = new Set([
      "staff.view",
      "timeoff.request",
      "availability.edit.own",
    ]);
    const wrapper = await mountSuspended(StaffProfile);
    expect(wrapper.text()).not.toContain("Request time off");
    expect(wrapper.text()).not.toContain("Add hours");
  });
});
