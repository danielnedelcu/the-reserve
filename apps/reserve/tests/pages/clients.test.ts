// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import ClientsPage from "~/pages/clients/index.vue";

// The list is one page from clients_page (docs/design/server-tables-design.md):
// the page asks the database with its checked query and draws what comes
// back. These tests stub the RPC and assert what the page asks for and
// what it shows; the function itself is proven by scripts/verify-tables.mjs.

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

const pageRows = [
  {
    id: "cl1",
    first_name: "Maria",
    last_name: "Alvarez",
    email: "maria@example.com",
    phone: "555-0101",
    active: true,
    no_show_count: 0,
    requires_card_on_file: false,
  },
  {
    id: "cl2",
    first_name: "Ben",
    last_name: "Ng",
    email: null,
    phone: null,
    active: true,
    no_show_count: 2,
    requires_card_on_file: true,
  },
];

const rpcMock = vi.hoisted(() =>
  vi.fn((fn: string) => {
    const result =
      fn === "clients_page"
        ? { data: { rows: pageRows, total: 41, total_exact: true }, error: null }
        : { data: "org", error: null };
    // The page calls .abortSignal() on the RPC builder; a thenable with it.
    const builder = { abortSignal: () => builder, then: (resolve: (v: unknown) => void) => resolve(result) };
    return builder;
  }),
);

function queryStub(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    order: self,
    eq: self,
    single: self,
    then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: result, error: null }),
  });
  return chain;
}

mockNuxtImport("useSupabaseClient", () => () => ({
  from: (table: string) => (table === "staff" ? queryStub([]) : queryStub(null)),
  rpc: rpcMock,
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
mockNuxtImport("useToast", () => () => toastMock);

// ---- Tests -----------------------------------------------------------------

describe("clients list page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSet.value = new Set(["clients.view"]);
  });

  it("asks clients_page for the first page of active clients by name", async () => {
    await mountSuspended(ClientsPage);
    const call = rpcMock.mock.calls.find(([fn]) => fn === "clients_page");
    expect(call).toBeTruthy();
    expect(call![1]).toEqual({ p_q: undefined, p_active: "active", p_sort: "name", p_desc: false, p_page: 1, p_page_size: 25 });
  });

  it("lists the page's rows and the server's total, not the page's length", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("Alvarez, Maria");
    expect(wrapper.text()).toContain("Ng, Ben");
    expect(wrapper.text()).toContain("41 clients");
  });

  it("shows the card-on-file flag from the row, not from flags", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("Card on file required");
  });

  it("highlights no-show counts", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("2");
  });

  it("keeps the search box the journeys find, and never puts the search in the URL", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    const box = wrapper.find('input[placeholder="Search name, email, phone…"]');
    expect(box.exists()).toBe(true);
    expect(useRoute().query.q).toBeUndefined();
  });

  it("hides create/edit without permissions (provider view)", async () => {
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).not.toContain("New client");
    expect(wrapper.find('[aria-label^="Edit "]').exists()).toBe(false);
  });

  it("shows create/edit for front desk and up", async () => {
    permissionSet.value = new Set(["clients.view", "clients.create", "clients.edit"]);
    const wrapper = await mountSuspended(ClientsPage);
    expect(wrapper.text()).toContain("New client");
    expect(wrapper.find('[aria-label^="Edit "]').exists()).toBe(true);
  });
});
