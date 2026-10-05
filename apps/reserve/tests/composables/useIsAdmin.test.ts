// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";

const rpcMock = vi.fn();
mockNuxtImport("useSupabaseClient", () => () => ({ rpc: rpcMock }));
mockNuxtImport("useSupabaseUser", () => () => ref({ id: "user-1" }));

describe("useIsAdmin", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    clearNuxtState("is-admin");
  });

  it("asks is_admin once and answers", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    const { isAdmin, load, ready } = useIsAdmin();
    expect(ready.value).toBe(false);
    expect(isAdmin.value).toBe(false); // denies until loaded
    await load();
    await load();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("is_admin");
    expect(ready.value).toBe(true);
    expect(isAdmin.value).toBe(true);
  });

  it("a false answer is cached as ready-and-denied", async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });
    const { isAdmin, load, ready } = useIsAdmin();
    await load();
    expect(ready.value).toBe(true);
    expect(isAdmin.value).toBe(false);
  });

  it("does not cache a failed load, and denies meanwhile", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { isAdmin, load, ready } = useIsAdmin();
    await load();
    expect(ready.value).toBe(false);
    expect(isAdmin.value).toBe(false);
    rpcMock.mockResolvedValue({ data: true, error: null });
    await load();
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(isAdmin.value).toBe(true);
  });
});
