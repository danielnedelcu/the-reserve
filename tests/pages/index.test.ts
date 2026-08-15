// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import { createTestingPinia } from "@pinia/testing";
import IndexPage from "~/pages/index.vue";

// ---- Mocks -----------------------------------------------------------------

// usePermissions: controllable per-test permission set
const canMock = vi.fn((key: string) => false);
const loadMock = vi.fn(async () => {});
mockNuxtImport("usePermissions", () => () => ({
  can: canMock,
  canAny: (...keys: string[]) => keys.some(canMock),
  load: loadMock,
  reset: vi.fn(),
  ready: computed(() => true),
  permissions: readonly(ref<string[]>([])),
}));

// useAuth: spyable signOut
const signOutMock = vi.fn(async () => {});
mockNuxtImport("useAuth", () => () => ({
  signOut: signOutMock,
}));

// ---- Helpers ---------------------------------------------------------------

async function mountPage() {
  return await mountSuspended(IndexPage, {
    global: {
      plugins: [
        createTestingPinia({
          initialState: {
            // key must match your store id in stores/appStore.ts
            app: { appName: "The Reserve" },
          },
          stubActions: false,
          createSpy: vi.fn,
        }),
      ],
    },
  });
}

// ---- Tests -----------------------------------------------------------------

describe("index page (dashboard)", () => {
  beforeEach(() => {
    canMock.mockReset().mockReturnValue(false);
    loadMock.mockClear();
    signOutMock.mockClear();
  });

  it("renders the app name from the store", async () => {
    const wrapper = await mountPage();
    expect(wrapper.get("h1").text()).toBe("The Reserve");
  });

  it("loads permissions on setup", async () => {
    await mountPage();
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("shows the super admin confirmation only with roles.manage", async () => {
    canMock.mockImplementation((key: string) => key === "roles.manage");
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("You're a super admin");
  });

  it("hides the super admin confirmation without roles.manage", async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).not.toContain("You're a super admin");
  });

  it("renders a logout button and calls signOut on click", async () => {
    const wrapper = await mountPage();
    const button = wrapper.get("button");
    expect(button.text()).toContain("Log out");

    await button.trigger("click");
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
