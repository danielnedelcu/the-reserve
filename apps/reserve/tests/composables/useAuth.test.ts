// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";

// ---- Mocks -----------------------------------------------------------------

const signOutMock = vi.fn();
mockNuxtImport("useSupabaseClient", () => () => ({
  auth: { signOut: signOutMock },
}));

const resetMock = vi.fn();
mockNuxtImport("usePermissions", () => () => ({
  can: vi.fn(() => false),
  canAny: vi.fn(() => false),
  load: vi.fn(async () => {}),
  reset: resetMock,
  ready: computed(() => true),
  permissions: readonly(ref<string[]>([])),
}));

// Toasts — mock OUR wrapper composable, not vue-sonner's useSonner.
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
mockNuxtImport("useToast", () => () => toastMock);

// NEEDS vi.hoisted: factory returns the variable itself, dereferenced at hoist time.
const navigateToMock = vi.hoisted(() => vi.fn(async () => {}));
mockNuxtImport("navigateTo", () => navigateToMock);

// ---- Tests -----------------------------------------------------------------

describe("useAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("signOut", () => {
    it("signs out, resets permissions, and navigates to /login", async () => {
      signOutMock.mockResolvedValue({ error: null });

      const { signOut } = useAuth();
      await signOut();

      expect(signOutMock).toHaveBeenCalledTimes(1);
      expect(resetMock).toHaveBeenCalledTimes(1);
      expect(navigateToMock).toHaveBeenCalledWith("/login");
      expect(toastMock.error).not.toHaveBeenCalled();
    });

    it("resets permissions even when sign-out fails", async () => {
      signOutMock.mockResolvedValue({ error: { message: "Network error" } });

      const { signOut } = useAuth();
      await signOut();

      // The cached permission set must never survive a logout attempt
      expect(resetMock).toHaveBeenCalledTimes(1);
    });

    it("toasts the error and does not navigate when sign-out fails", async () => {
      signOutMock.mockResolvedValue({ error: { message: "Network error" } });

      const { signOut } = useAuth();
      await signOut();

      expect(toastMock.error).toHaveBeenCalledWith(
        "Could not log out",
        "Network error",
      );
      expect(navigateToMock).not.toHaveBeenCalled();
    });

    it("clears permissions before navigating away", async () => {
      // Order matters: if navigation happened first, a fast next login
      // could observe the previous user's cached permissions.
      const callOrder: string[] = [];
      resetMock.mockImplementation(() => callOrder.push("reset"));
      navigateToMock.mockImplementation(async () => {
        callOrder.push("navigate");
      });
      signOutMock.mockResolvedValue({ error: null });

      const { signOut } = useAuth();
      await signOut();

      expect(callOrder).toEqual(["reset", "navigate"]);
    });
  });
});
