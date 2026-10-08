// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLatestSearch } from "../../app/utils/latestSearch";

// The rule the picker lives by: the newest search wins. A slow answer for
// an older term must never land after a newer term's, and typing must not
// fire a request per keystroke.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLatestSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the delay after the last keystroke and searches once", async () => {
    const search = vi.fn(async (term: string) => [term]);
    const results: string[][] = [];
    const s = createLatestSearch(search, { result: (_t, v) => results.push(v) }, 300);
    s.request("m");
    s.request("ma");
    s.request("mar");
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe("mar");
    expect(results).toEqual([["mar"]]);
  });

  it("a slow answer for an older term is dropped when a newer term was asked", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const signals: AbortSignal[] = [];
    const search = vi.fn((term: string, signal: AbortSignal) => {
      signals.push(signal);
      return term === "ma" ? first.promise : second.promise;
    });
    const results: string[][] = [];
    const busy: boolean[] = [];
    const s = createLatestSearch(search, { result: (_t, v) => results.push(v), busy: (b) => busy.push(b) }, 0);
    void s.now("ma");
    void s.now("mar"); // typed on before the first answered
    expect(signals[0]!.aborted).toBe(true); // the older request was aborted
    expect(signals[1]!.aborted).toBe(false);
    second.resolve(["mar"]);
    await vi.advanceTimersByTimeAsync(0);
    first.resolve(["ma"]); // late
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([["mar"]]);
    expect(busy[busy.length - 1]).toBe(false);
  });

  it("an error from an aborted request is ignored; an error from the newest is reported", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const search = vi.fn((term: string) => (term === "a" ? first.promise : second.promise));
    const errors: string[] = [];
    const s = createLatestSearch(search, { result: () => {}, error: (t) => errors.push(t) }, 0);
    void s.now("a");
    void s.now("b");
    first.reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    second.reject(new Error("real failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(["b"]);
  });

  it("cancel drops a pending keystroke and an in-flight request, and clears busy", async () => {
    const pending = deferred<string[]>();
    const search = vi.fn(() => pending.promise);
    const results: string[][] = [];
    const busy: boolean[] = [];
    const s = createLatestSearch(search, { result: (_t, v) => results.push(v), busy: (b) => busy.push(b) }, 300);
    s.request("zz");
    s.cancel();
    await vi.advanceTimersByTimeAsync(300);
    expect(search).not.toHaveBeenCalled();
    void s.now("yy");
    s.cancel();
    pending.resolve(["yy"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
    expect(busy[busy.length - 1]).toBe(false);
  });
});
