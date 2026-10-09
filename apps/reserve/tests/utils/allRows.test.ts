import { describe, expect, it } from "vitest";
import { allRows } from "~/utils/allRows";

/** A fake PostgREST: `total` rows, answered by inclusive range, capped like max_rows. */
function server(total: number, cap = 1000) {
  const calls: [number, number][] = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, total, from + cap);
    const data = Array.from({ length: Math.max(0, end - from) }, (_, i) => from + i);
    return { data, error: null };
  };
  return { page, calls };
}

describe("allRows", () => {
  it("reads past the server's cap until a short page, every row once and in order", async () => {
    const { page, calls } = server(2_381);
    const rows = await allRows(page);
    expect(rows).toHaveLength(2_381);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(new Set(rows).size).toBe(2_381);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("costs one request when the result fits in a page", async () => {
    const { page, calls } = server(37);
    expect(await allRows(page)).toHaveLength(37);
    expect(calls).toHaveLength(1);
  });

  it("asks once more when the result is exactly a page, and stops on the empty page", async () => {
    const { page, calls } = server(1_000);
    expect(await allRows(page)).toHaveLength(1_000);
    expect(calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("returns an empty list for an empty result and tolerates a null data", async () => {
    expect(await allRows(async () => ({ data: null, error: null }))).toEqual([]);
  });

  it("throws the page's error", async () => {
    await expect(allRows(async () => ({ data: null, error: new Error("42501") }))).rejects.toThrow("42501");
  });

  it("honours a smaller page size", async () => {
    const { page, calls } = server(25, 10);
    expect(await allRows(page, 10)).toHaveLength(25);
    expect(calls).toEqual([[0, 9], [10, 19], [20, 29]]);
  });
});
