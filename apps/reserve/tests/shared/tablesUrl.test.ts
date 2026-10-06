// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseTableQuery, tableQueryToUrl, firstValue, uuid, day, oneOf } from "../../shared/tables/url";

// The URL as a table's state, checked. Every case here is an edge a
// rewrite would get wrong while an ordinary address still worked: the
// invalid, the repeated, the missing, the too-long. Nothing may throw —
// a bad address bar is a default, not an error page.

const spec = {
  filters: { active: oneOf("active", "inactive", "all"), staff: uuid, since: day },
  sorts: ["name", "contact", "no_shows"] as const,
};
const ID = "6f0a4b1c-2d3e-4f50-9a6b-7c8d9e0f1a2b";

describe("parseTableQuery — defaults", () => {
  it("an empty query is page 1, the first sort, ascending, no filters, no search", () => {
    expect(parseTableQuery(spec, {})).toEqual({ q: "", page: 1, sort: "name", desc: false, filters: {} });
  });
  it("defaultDesc flips the default direction only", () => {
    expect(parseTableQuery({ ...spec, defaultDesc: true }, {}).desc).toBe(true);
    expect(parseTableQuery({ ...spec, defaultDesc: true }, { dir: "asc" }).desc).toBe(false);
  });
});

describe("parseTableQuery — page", () => {
  it.each([
    ["3", 3],
    ["0", 1],
    ["-2", 1],
    ["2.5", 1],
    ["abc", 1],
    ["", 1],
    [["4", "9"], 4],
  ])("page %j → %i", (raw, expected) => {
    expect(parseTableQuery(spec, { page: raw }).page).toBe(expected);
  });
});

describe("parseTableQuery — sort and direction", () => {
  it("keeps a known sort and drops an unknown one", () => {
    expect(parseTableQuery(spec, { sort: "no_shows" }).sort).toBe("no_shows");
    expect(parseTableQuery(spec, { sort: "id; drop table clients" }).sort).toBe("name");
  });
  it("dir is asc or desc; anything else is the default", () => {
    expect(parseTableQuery(spec, { dir: "desc" }).desc).toBe(true);
    expect(parseTableQuery(spec, { dir: "DESC" }).desc).toBe(false);
    expect(parseTableQuery(spec, { dir: "sideways" }).desc).toBe(false);
  });
});

describe("parseTableQuery — filters", () => {
  it("a value that passes its check is kept; one that fails is absent", () => {
    const q = parseTableQuery(spec, { active: "all", staff: "not-a-uuid", since: "2026-02-30" });
    expect(q.filters).toEqual({ active: "all" });
  });
  it("uuid, day and oneOf accept exactly their shapes", () => {
    const q = parseTableQuery(spec, { active: "inactive", staff: ID.toUpperCase(), since: "2026-10-06" });
    expect(q.filters).toEqual({ active: "inactive", staff: ID.toUpperCase(), since: "2026-10-06" });
    expect(parseTableQuery(spec, { since: "2026-13-01" }).filters).toEqual({});
    expect(parseTableQuery(spec, { since: "06/10/2026" }).filters).toEqual({});
  });
  it("blank and whitespace values are absent; repeated keys take the first", () => {
    expect(parseTableQuery(spec, { active: "  " }).filters).toEqual({});
    expect(parseTableQuery(spec, { active: ["inactive", "all"] }).filters).toEqual({ active: "inactive" });
  });
  it("keys the table does not declare are ignored, not errors", () => {
    expect(parseTableQuery(spec, { utm: "x", bogus: ["1"] }).filters).toEqual({});
  });
});

describe("parseTableQuery — search text", () => {
  it("is trimmed and cut to 200 characters", () => {
    expect(parseTableQuery(spec, { q: "  maria  " }).q).toBe("maria");
    expect(parseTableQuery(spec, { q: "x".repeat(500) }).q).toHaveLength(200);
    expect(parseTableQuery({ ...spec, maxSearch: 10 }, { q: "x".repeat(50) }).q).toHaveLength(10);
  });
  it("a repeated q takes the first", () => {
    expect(parseTableQuery(spec, { q: ["one", "two"] }).q).toBe("one");
  });
});

describe("firstValue", () => {
  it("string, first of an array, else empty", () => {
    expect(firstValue(" a ")).toBe("a");
    expect(firstValue(["b", "c"])).toBe("b");
    expect(firstValue(undefined)).toBe("");
    expect(firstValue(42)).toBe("");
    expect(firstValue([])).toBe("");
  });
});

describe("tableQueryToUrl — defaults stay out of the address", () => {
  const cur = {};
  it("page 1, the first sort, the default direction, empty filters and empty search are omitted", () => {
    expect(tableQueryToUrl(spec, { q: "", page: 1, sort: "name", desc: false, filters: {} }, cur, { includeSearch: true })).toEqual({});
  });
  it("non-defaults are written", () => {
    expect(tableQueryToUrl(spec, { page: 3, sort: "contact", desc: true, filters: { active: "all" } }, cur, { includeSearch: true }))
      .toEqual({ page: "3", sort: "contact", dir: "desc", active: "all" });
  });
  it("the search is written only when the table keeps it in the URL", () => {
    expect(tableQueryToUrl(spec, { q: "maria" }, cur, { includeSearch: true })).toEqual({ q: "maria" });
    expect(tableQueryToUrl(spec, { q: "maria" }, cur, { includeSearch: false })).toEqual({});
  });
  it("a null filter removes the key; keys the table does not own survive", () => {
    expect(tableQueryToUrl(spec, { filters: { active: null } }, { active: "all", ref: "email" }, { includeSearch: false })).toEqual({ ref: "email" });
  });
  it("the default direction depends on defaultDesc", () => {
    const d = { ...spec, defaultDesc: true };
    expect(tableQueryToUrl(d, { desc: true }, cur, { includeSearch: false })).toEqual({});
    expect(tableQueryToUrl(d, { desc: false }, cur, { includeSearch: false })).toEqual({ dir: "asc" });
  });
});

describe("the two directions agree", () => {
  // What tableQueryToUrl writes, parseTableQuery reads back unchanged.
  const states = [
    { q: "", page: 1, sort: "name" as const, desc: false, filters: {} },
    { q: "ben", page: 7, sort: "no_shows" as const, desc: true, filters: { active: "inactive" as const } },
    { q: "", page: 2, sort: "contact" as const, desc: false, filters: { active: "all" as const, staff: ID, since: "2026-01-31" } },
  ];
  for (const state of states) {
    it(JSON.stringify(state), () => {
      const url = tableQueryToUrl(spec, state, {}, { includeSearch: true });
      expect(parseTableQuery(spec, url)).toEqual(state);
    });
  }
});
