import { describe, it, expect } from "vitest";
import { useToggleSet } from "~/composables/useToggleSet";

// Fifteen lines, but it is the selection state behind the new-message
// dialog and the rail directory. The one property that matters is the
// last one: every change must be a NEW Set, or the shallow ref never
// notices and the UI silently stops following the selection.
describe("useToggleSet", () => {
  it("starts empty", () => {
    const s = useToggleSet();
    expect(s.set.value.size).toBe(0);
    expect(s.has("a")).toBe(false);
  });

  it("toggle adds, then removes, the same id", () => {
    const s = useToggleSet();
    s.toggle("a");
    expect(s.has("a")).toBe(true);
    s.toggle("a");
    expect(s.has("a")).toBe(false);
  });

  it("clear empties a multi-item selection", () => {
    const s = useToggleSet();
    s.toggle("a");
    s.toggle("b");
    expect(s.set.value.size).toBe(2);
    s.clear();
    expect(s.set.value.size).toBe(0);
  });

  it("every change replaces the Set instance (what makes the shallow ref reactive)", () => {
    const s = useToggleSet();
    const before = s.set.value;
    s.toggle("a");
    expect(s.set.value).not.toBe(before);
    const mid = s.set.value;
    s.clear();
    expect(s.set.value).not.toBe(mid);
  });
});
