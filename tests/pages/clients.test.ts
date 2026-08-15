// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import ClientsPage from "~/pages/clients/index.vue";

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

const clientRows = [
  {
    id: "cl1",
    first_name: "Maria",
    last_name: "Alvarez",
    email: "maria@example.com",
    phone: "555-0101",
    no_show_count: 0,
    flags: {},
    active: true,
  },
  {
    id: "cl2",
    first_name: "Ben",
    last_name: "Ng",
    email: null,
    phone: null,
    no_show_count: 2,
    flags: { requires_card_on_file: true },
    active: true,
  },
  {
    id: "cl3",
    first_name: "Old",
    last_name: "Timer",
    email: null,
    phone: null,
    no_show_count: 0,
    flags: {},
    active: false,
  },
];

function queryStub(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    order: self,
    eq: self,
    neq: self,
    is: self,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: result, error: null }),
  });
  return chain;
}

mockNuxtImport("useSupabaseClient", () => () => ({
  from: (table: string) =>
    table === "clients" ? queryStub(clientRows) : queryStub([]),
  rpc: vi.fn(async () => ({ data: "x", error: null })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
mockNuxtImport("useToast", () => () => toastMock);

// ---- Tests -----------------------------------------------------------------

describe("clients list page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSet.value = new Set(["clients.view"]);
  });

  it("lists active clients", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("Alvarez, Maria");
    expect(wrapper.text()).toContain("Ng, Ben");
  });

  it("hides inactive clients by default", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).not.toContain("Timer, Old");
  });

  it("shows the card-on-file flag", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("Card on file required");
  });

  it("highlights no-show counts", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("2");
  });

  it("hides create/edit without permissions (provider view)", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).not.toContain("New client");
    expect(wrapper.text()).not.toContain("Edit");
  });

  it("shows create/edit for front desk and up", async () => {
    permissionSet.value = new Set([
      "clients.view",
      "clients.create",
      "clients.edit",
    ]);
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("New client");
    expect(wrapper.text()).toContain("Edit");
  });
});
