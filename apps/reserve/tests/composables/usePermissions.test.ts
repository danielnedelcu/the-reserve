// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";

// Mock the Supabase composables the permission composable depends on
const rpcMock = vi.fn();
mockNuxtImport("useSupabaseClient", () => () => ({ rpc: rpcMock }));
mockNuxtImport("useSupabaseUser", () => () => ref({ id: "user-1" }));

describe("usePermissions", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    // clear the shared useState between tests
    clearNuxtState("permissions");
  });

  it("loads permissions once and answers can()", async () => {
    rpcMock.mockResolvedValue({
      data: ["appointments.create", "clients.view"],
      error: null,
    });

    const { can, load, ready } = usePermissions();
    expect(ready.value).toBe(false);

    await load();

    expect(rpcMock).toHaveBeenCalledWith("get_my_permissions");
    expect(ready.value).toBe(true);
    expect(can("appointments.create")).toBe(true);
    expect(can("roles.manage")).toBe(false);
  });

  it("does not refetch when already loaded", async () => {
    rpcMock.mockResolvedValue({ data: ["clients.view"], error: null });
    const { load } = usePermissions();
    await load();
    await load();
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("canAny matches when at least one key is held", async () => {
    rpcMock.mockResolvedValue({ data: ["analytics.view.own"], error: null });
    const { canAny, load } = usePermissions();
    await load();
    expect(canAny("analytics.view.org", "analytics.view.own")).toBe(true);
    expect(canAny("roles.manage", "audit_log.view")).toBe(false);
  });

  it("does not cache a failed load", async () => {
    // Regression test for the invite-acceptance race: a load() that fails
    // (e.g. session not yet settled) must NOT be cached as an empty
    // permission set — ready stays false so a later load() retries.
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { can, load, ready } = usePermissions();
    await load();

    expect(ready.value).toBe(false); // failure was not cached as "loaded"
    expect(can("clients.view")).toBe(false); // and can() stays safe (deny)

    // The next plain load() (no force) retries and succeeds
    rpcMock.mockResolvedValue({ data: ["clients.view"], error: null });
    await load();

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(ready.value).toBe(true);
    expect(can("clients.view")).toBe(true);
  });

  it("force-reloads even when already loaded", async () => {
    // login/role changes call load(true) to refresh a stale cache
    rpcMock.mockResolvedValue({ data: ["clients.view"], error: null });
    const { can, load } = usePermissions();
    await load();
    expect(can("staff.invite")).toBe(false);

    rpcMock.mockResolvedValue({
      data: ["clients.view", "staff.invite"],
      error: null,
    });
    await load(true);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(can("staff.invite")).toBe(true);
  });
});
