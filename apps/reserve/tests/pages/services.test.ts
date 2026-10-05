// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import ServicesPage from "~/pages/services.vue";

// ---- Mocks -----------------------------------------------------------------

const permissionSet = vi.hoisted(() => ({ value: new Set<string>() }));
mockNuxtImport("usePermissions", () => () => ({
  can: (key: string) => permissionSet.value.has(key),
  canAny: (...keys: string[]) => keys.some((k) => permissionSet.value.has(k)),
  load: vi.fn(async () => {}),
  reset: vi.fn(),
  ready: computed(() => true),
  permissions: readonly(ref<string[]>([])),
}));

const categories = [{ id: "c1", name: "Massage", sort_order: 0 }];
const servicesRows = [
  {
    id: "sv1",
    category_id: "c1",
    name: "Swedish Massage",
    description: "Classic full-body relaxation massage.",
    duration_minutes: 60,
    buffer_before_min: 0,
    buffer_after_min: 15,
    price_cents: 12000,
    requires_intake: true,
    active: true,
    service_resource_requirements: [{ resource_type_id: "rt1" }],
    service_staff: [],
  },
  {
    id: "sv2",
    category_id: "c1",
    name: "Retired Treatment",
    description: null,
    duration_minutes: 30,
    buffer_before_min: 0,
    buffer_after_min: 10,
    price_cents: 5000,
    requires_intake: false,
    active: false,
    service_resource_requirements: [],
    service_staff: [],
  },
];
const resourceTypes = [{ id: "rt1", name: "Massage Room" }];

function queryStub(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    order: self,
    eq: self,
    is: self,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: result, error: null }),
  });
  return chain;
}

mockNuxtImport("useSupabaseClient", () => () => ({
  from: (table: string) => {
    if (table === "service_categories") return queryStub(categories);
    if (table === "services") return queryStub(servicesRows);
    if (table === "resource_types") return queryStub(resourceTypes);
    if (table === "staff") return queryStub([]);
    return queryStub([]);
  },
  rpc: vi.fn(async () => ({ data: "org-1", error: null })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
mockNuxtImport("useToast", () => () => toastMock);

// ---- Tests -----------------------------------------------------------------

describe("services page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSet.value = new Set(["services.view"]);
  });

  it("renders services grouped under their category", async () => {
    const wrapper = await mountSuspended(ServicesPage);
    expect(wrapper.text()).toContain("Massage");
    expect(wrapper.text()).toContain("Swedish Massage");
  });

  it("shows price formatted as currency and blocked time", async () => {
    const wrapper = await mountSuspended(ServicesPage);
    expect(wrapper.text()).toContain("$120.00");
    expect(wrapper.text()).toContain("75 min blocked"); // 0 + 60 + 15
  });

  it("hides inactive services by default", async () => {
    const wrapper = await mountSuspended(ServicesPage);
    expect(wrapper.text()).not.toContain("Retired Treatment");
  });

  it("hides management actions without services.manage", async () => {
    const wrapper = await mountSuspended(ServicesPage);
    expect(wrapper.text()).not.toContain("New service");
    expect(wrapper.text()).not.toContain("Edit");
  });

  it("shows management actions with services.manage", async () => {
    permissionSet.value = new Set(["services.view", "services.manage"]);
    const wrapper = await mountSuspended(ServicesPage);
    expect(wrapper.text()).toContain("New service");
    expect(wrapper.text()).toContain("Edit");
  });

  it("marks intake-required services", async () => {
    const wrapper = await mountSuspended(ServicesPage);
    expect(wrapper.text()).toContain("Requires intake form");
  });
});
