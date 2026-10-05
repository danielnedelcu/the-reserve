import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { useStartConversation } from "~/composables/useStartConversation";

// The ONE definition of "start a chat from a staff selection", shared by
// the new-message dialog and the rail directory. What matters is which RPC
// gets which arguments, and what happens to the selection afterwards.
const rpcMock = vi.fn();
const toastError = vi.fn();
mockNuxtImport("useSupabaseClient", () => () => ({ rpc: rpcMock }));
mockNuxtImport("useToast", () => () => ({
  error: toastError,
  success: vi.fn(),
}));

describe("useStartConversation", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    toastError.mockReset();
  });

  it("one selected id → find_or_create_dm with that id", async () => {
    rpcMock.mockResolvedValue({ data: "conv-1", error: null });
    const onStarted = vi.fn();
    const s = useStartConversation({ onStarted });
    s.picked.toggle("staff-a");
    await s.start();
    expect(rpcMock).toHaveBeenCalledWith("find_or_create_dm", {
      p_other_staff_id: "staff-a",
    });
    expect(onStarted).toHaveBeenCalledWith("conv-1");
  });

  it("several ids → create_group_conversation with the name and all ids", async () => {
    rpcMock.mockResolvedValue({ data: "conv-g", error: null });
    const s = useStartConversation({ onStarted: vi.fn() });
    s.picked.toggle("staff-a");
    s.picked.toggle("staff-b");
    s.groupName.value = "Front desk";
    await s.start();
    expect(rpcMock).toHaveBeenCalledWith("create_group_conversation", {
      p_name: "Front desk",
      p_staff_ids: ["staff-a", "staff-b"],
    });
  });

  it("success clears the selection and the group name", async () => {
    rpcMock.mockResolvedValue({ data: "conv-g", error: null });
    const s = useStartConversation({ onStarted: vi.fn() });
    s.picked.toggle("staff-a");
    s.picked.toggle("staff-b");
    s.groupName.value = "x";
    await s.start();
    expect(s.picked.set.value.size).toBe(0);
    expect(s.groupName.value).toBe("");
    expect(s.creating.value).toBe(false);
  });

  it("an RPC error toasts, keeps the selection, and does not call onStarted", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "nope" } });
    const onStarted = vi.fn();
    const s = useStartConversation({ onStarted });
    s.picked.toggle("staff-a");
    await s.start();
    expect(toastError).toHaveBeenCalledWith(
      "Could not start conversation",
      "nope",
    );
    expect(onStarted).not.toHaveBeenCalled();
    expect(s.picked.has("staff-a")).toBe(true);
    expect(s.creating.value).toBe(false);
  });

  it("explicit ids bypass the selection — 'Chat with' is a DM by construction", async () => {
    rpcMock.mockResolvedValue({ data: "conv-2", error: null });
    const s = useStartConversation({ onStarted: vi.fn() });
    s.picked.toggle("staff-a");
    s.picked.toggle("staff-b"); // a pending multi-select must not leak in
    await s.start(["staff-c"]);
    expect(rpcMock).toHaveBeenCalledWith("find_or_create_dm", {
      p_other_staff_id: "staff-c",
    });
  });

  it("does nothing with an empty selection, and ignores a second call while one is in flight", async () => {
    let resolve!: (v: unknown) => void;
    rpcMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const s = useStartConversation({ onStarted: vi.fn() });
    await s.start();
    expect(rpcMock).not.toHaveBeenCalled();
    s.picked.toggle("staff-a");
    const first = s.start();
    expect(s.creating.value).toBe(true);
    await s.start(); // the double click
    expect(rpcMock).toHaveBeenCalledTimes(1);
    resolve({ data: "conv-1", error: null });
    await first;
    expect(s.creating.value).toBe(false);
  });
});
