// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSuspended, mockNuxtImport } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import LoginPage from "~/pages/login.vue";

// ---- Mocks -----------------------------------------------------------------

// Supabase client: controllable auth result per test.
const signInMock = vi.fn();
mockNuxtImport("useSupabaseClient", () => () => ({
  auth: { signInWithPassword: signInMock },
}));

// Router: spy on push, but keep enough real surface for @nuxt/test-utils —
// its own setup calls useRouter().afterEach().
const routerPushMock = vi.hoisted(() => vi.fn());
mockNuxtImport("useRouter", () => () => ({
  push: routerPushMock,
  replace: vi.fn(),
  back: vi.fn(),
  go: vi.fn(),
  afterEach: vi.fn(() => () => {}),
  beforeEach: vi.fn(() => () => {}),
  beforeResolve: vi.fn(() => () => {}),
  resolve: vi.fn(),
  currentRoute: ref({
    path: "/login",
    fullPath: "/login",
    query: {},
    params: {},
  }),
}));

// Permissions cache warm-up after login
const permissionsLoadMock = vi.fn(async () => {});
mockNuxtImport("usePermissions", () => () => ({
  can: vi.fn(() => false),
  canAny: vi.fn(() => false),
  load: permissionsLoadMock,
  reset: vi.fn(),
  ready: computed(() => true),
  permissions: readonly(ref<string[]>([])),
}));

// Toasts — mock OUR wrapper composable (a project auto-import, which
// mockNuxtImport intercepts reliably; vue-sonner's own useSonner does not).
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
mockNuxtImport("useToast", () => () => toastMock);

// ---- Helpers ---------------------------------------------------------------

async function mountPage() {
  const wrapper = await mountSuspended(LoginPage);
  const email = wrapper.get('input[name="email"]');
  const password = wrapper.get('input[name="password"]');
  const form = wrapper.get("form");
  return { wrapper, email, password, form };
}

async function fillAndSubmit(
  page: Awaited<ReturnType<typeof mountPage>>,
  email: string,
  password: string,
) {
  await page.email.setValue(email);
  await page.password.setValue(password);
  await page.form.trigger("submit");
  await flushPromises();
}

/** Poll until the wrapper's text contains the given string (or time out). */
async function expectText(
  wrapper: Awaited<ReturnType<typeof mountPage>>["wrapper"],
  text: string,
) {
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain(text);
  });
}

// ---- Tests -----------------------------------------------------------------

describe("login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the sign-in form", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.get("h1").text()).toBe("Log in");
    expect(wrapper.find('input[name="email"]').exists()).toBe(true);
    expect(wrapper.find('input[name="password"]').exists()).toBe(true);
  });

  it("does not attempt sign-in with an invalid email", async () => {
    const page = await mountPage();
    await fillAndSubmit(page, "not-an-email", "somepassword");

    await expectText(page.wrapper, "Email must be a valid email");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("does not attempt sign-in with an empty password", async () => {
    const page = await mountPage();
    await fillAndSubmit(page, "staff@thereserve.com", "");

    await expectText(page.wrapper, "Password is required");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("signs in and redirects to / on success", async () => {
    signInMock.mockResolvedValue({ error: null });
    const page = await mountPage();
    await fillAndSubmit(page, "staff@thereserve.com", "correct-password");

    await vi.waitFor(() => {
      expect(signInMock).toHaveBeenCalledWith({
        email: "staff@thereserve.com",
        password: "correct-password",
      });
    });
    await vi.waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/");
    });
    expect(permissionsLoadMock).toHaveBeenCalledWith(true);
    expect(toastMock.success).toHaveBeenCalledWith(
      "Logged in",
      "Welcome back.",
    );
  });

  it("shows a field error on invalid credentials and does not redirect", async () => {
    signInMock.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const page = await mountPage();
    await fillAndSubmit(page, "staff@thereserve.com", "wrong-password");

    await expectText(page.wrapper, "Email or password is incorrect.");
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(permissionsLoadMock).not.toHaveBeenCalled();
  });

  it("toasts unexpected auth errors and does not redirect", async () => {
    signInMock.mockResolvedValue({
      error: { message: "Email rate limit exceeded" },
    });
    const page = await mountPage();
    await fillAndSubmit(page, "staff@thereserve.com", "some-password");

    await vi.waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Could not log in",
        "Email rate limit exceeded",
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });
});
