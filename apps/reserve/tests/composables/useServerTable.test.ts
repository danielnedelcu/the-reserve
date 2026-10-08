// @vitest-environment nuxt
import { describe, it, expect } from "vitest";
import { mountSuspended } from "@nuxt/test-utils/runtime";
import { defineComponent, h } from "vue";
import { oneOf } from "~~/shared/tables/url";
import { useServerTable } from "~/composables/useServerTable";

// Navigations never overwrite each other. A router.push resolves later
// than it is called; a change made while one is in flight — the search
// box's 300ms debounce landing just after a filter was picked — must
// carry the filter with it, not merge into the stale route and write it
// away (e2e/journeys/05-products.spec.ts on CI run 37716306154).
//
// The REAL router is used: two changes issued synchronously are exactly
// the race, with no timing to get lucky on. Vue Router cancels the first
// navigation when the second starts and lands the second, so what the
// second one carries is what the URL ends up saying.

type Table = Awaited<ReturnType<typeof useServerTable>>;
async function mountTable(): Promise<Table> {
  let table!: Table;
  const Host = defineComponent({
    async setup() {
      table = await useServerTable({
        key: `t-${Math.random()}`,
        search: "url",
        filters: { stock: oneOf("out", "low"), active: oneOf("active", "inactive", "all") },
        sorts: ["name", "price"] as const,
        load: async () => ({ rows: [], total: 0, total_exact: true }),
      });
      return () => h("div");
    },
  });
  await mountSuspended(Host);
  return table;
}
const settled = (...navs: Promise<unknown>[]) => Promise.allSettled(navs);
const current = () => useRouter().currentRoute.value.query as Record<string, string>;

describe("useServerTable — navigations merge into the intended query, never into the stale route", () => {
  it("a filter picked, then a search landing while the filter's navigation is in flight: both reach the URL", async () => {
    await useRouter().replace({ query: {} });
    const table = await mountTable();
    const filter = table.setFilter("stock", "out"); // the option click: in flight
    const search = table.setSearch("E2E-run"); // the debounce lands before it resolved
    await settled(filter, search);
    expect(current()).toMatchObject({ stock: "out", q: "E2E-run" });
    expect(table.query.value.filters.stock).toBe("out");
    expect(table.query.value.q).toBe("E2E-run");
  });

  it("the other order — a search in flight, then a filter picked — carries the search too", async () => {
    await useRouter().replace({ query: {} });
    const table = await mountTable();
    await settled(table.setSearch("E2E-run"), table.setFilter("stock", "low"));
    expect(current()).toMatchObject({ stock: "low", q: "E2E-run" });
  });

  it("three changes in flight at once all land", async () => {
    await useRouter().replace({ query: {} });
    const table = await mountTable();
    await settled(table.setFilter("active", "all"), table.setSearch("x"), table.setSort("price", true));
    expect(current()).toMatchObject({ active: "all", q: "x", sort: "price", dir: "desc" });
  });

  it("a filter cleared with null is removed, and any change goes back to page 1", async () => {
    await useRouter().replace({ query: {} });
    const table = await mountTable();
    await table.setFilter("stock", "out");
    await table.setPage(3);
    expect(current()).toMatchObject({ stock: "out", page: "3" });
    await table.setFilter("stock", null);
    expect(current().stock).toBeUndefined();
    expect(current().page).toBeUndefined();
  });

  it("a navigation that ends as a DUPLICATE of the current URL still releases the record: an external navigation after it is followed", async () => {
    await useRouter().replace({ query: { stock: "out" } });
    const table = await mountTable();
    // Choosing the value already in the URL: the router resolves this
    // (a duplicated navigation never throws), and the decrement runs in
    // the promise's finally whatever value it resolves with.
    await table.setFilter("stock", "out");
    expect(current()).toMatchObject({ stock: "out" });
    await useRouter().replace({ query: {} }); // Back
    await table.setSearch("x");
    expect(current().stock).toBeUndefined(); // the record followed Back, so the in-flight count had reached zero
    expect(current().q).toBe("x");
  });

  it("a navigation CANCELLED by a newer one still releases the record: an external navigation after both is followed", async () => {
    await useRouter().replace({ query: {} });
    const table = await mountTable();
    const first = table.setFilter("stock", "out"); // cancelled by the next
    const second = table.setFilter("active", "all");
    const [a, b] = await Promise.all([first, second]);
    expect(a && typeof a === "object" && "type" in a).toBe(true); // the cancelled one resolved with a failure
    expect(b).toBeUndefined(); // the newest landed
    expect(current()).toMatchObject({ stock: "out", active: "all" });
    await useRouter().replace({ query: {} }); // Back
    await table.setSearch("y");
    expect(current().stock).toBeUndefined();
    expect(current().active).toBeUndefined();
    expect(current().q).toBe("y");
  });

  it("an external navigation (Back, a link) resets the intended query once nothing of ours is in flight", async () => {
    await useRouter().replace({ query: {} });
    const table = await mountTable();
    await table.setFilter("stock", "out");
    await useRouter().replace({ query: {} }); // Back
    await table.setSearch("x");
    expect(current().stock).toBeUndefined(); // the stale filter did not come back
    expect(current().q).toBe("x");
  });
});
