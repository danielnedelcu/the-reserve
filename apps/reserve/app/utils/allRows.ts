/**
 * Every row of a PostgREST query, read page by page.
 *
 * PostgREST answers at most `max_rows` rows (1,000 here) and says NOTHING
 * when it has cut a result short: no error, no header the client reads,
 * the first thousand rows and a 200. A query a page expects to return "the
 * period's appointments" is correct on a quiet spa and silently wrong on a
 * busy one — the demo seed (a year at ~20 bookings a day, 2026-10-08) was
 * the first database big enough to show it: the year's utilisation table
 * put every provider at ~12%, and the dashboard's bookings chart drew
 * October 26% below September when it was 11% above, because both months
 * share one request and October is the part that fell off the end.
 *
 * `page(from, to)` runs the query for one inclusive row range (the
 * builder's `.range(from, to)`); the query MUST carry a total order
 * (`.order(...)` on a key, with a tiebreaker) or pages can overlap or skip
 * under concurrent writes. Reading stops at the first short page, so one
 * request still costs one request on a small result.
 */
export async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  size = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < size) return rows;
  }
}
