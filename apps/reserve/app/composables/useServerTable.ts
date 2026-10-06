import {
  parseTableQuery,
  tableQueryToUrl,
  type FilterShape,
  type TableQuery,
  type TableQuerySpec,
} from "~~/shared/tables/url";

/**
 * One pattern for the server-side tables (docs/design/server-tables-design.md;
 * the shape is Lokl's, docs/server-tables-reference.md §2). The filters,
 * page and sort live in the URL, so Back, reload and bookmarks work; the
 * page asks the database for one page of rows plus the total.
 *
 * - Values in the URL are checked (shared/tables/url.ts); anything that
 *   doesn't make sense is a default, not trusted.
 * - Changing a filter, the sort or the page adds a history entry; typing
 *   in the search box replaces the current one (Back doesn't replay
 *   keystrokes). Anything but the page itself goes back to page 1.
 * - The search text itself is in the URL only when the table says so
 *   (`search: "url"`). The default, `"session"`, keeps it in page state
 *   and in sessionStorage for this tab: it survives a reload, never
 *   enters history or a request log, and is not shareable (decision 5:
 *   client names are sensitive).
 * - The first load happens through useAsyncData, so a server-rendered
 *   page arrives with its rows; later loads cancel the previous one and
 *   a late answer never overwrites a newer one.
 */

export interface ServerPage<Row> {
  rows: Row[];
  total: number;
  /** False once a table switches to an estimated total ("About 12,400"). */
  total_exact: boolean;
}

export interface ServerTableOptions<F extends FilterShape, S extends readonly [string, ...string[]], Row>
  extends TableQuerySpec<F, S> {
  /** A key for useAsyncData; one per page. */
  key: string;
  /** Where the search text lives. Default "session". */
  search?: "url" | "session";
  load: (query: TableQuery<F, S>, signal: AbortSignal) => Promise<ServerPage<Row>>;
}

/** What a setter may change. A null filter value removes that filter. */
interface Changes<S extends readonly [string, ...string[]]> {
  q?: string;
  page?: number;
  sort?: S[number];
  desc?: boolean;
  filters?: Record<string, string | null | undefined>;
}

/** A database page function's answer as a ServerPage, or throw its error. */
export function asServerPage<Row>(data: unknown, error: { message: string } | null): ServerPage<Row> {
  if (error) throw error;
  const page = data as Partial<ServerPage<Row>> | null;
  return { rows: page?.rows ?? [], total: page?.total ?? 0, total_exact: page?.total_exact ?? true };
}

const EMPTY = { rows: [], total: 0, total_exact: true };

export async function useServerTable<F extends FilterShape, S extends readonly [string, ...string[]], Row>(
  opts: ServerTableOptions<F, S, Row>,
) {
  const route = useRoute();
  const router = useRouter();
  const searchMode = opts.search ?? "session";
  const maxSearch = opts.maxSearch ?? 200;
  const storageKey = `table-search:${route.path}`;

  // The search text when it is NOT in the URL. Read back from this tab's
  // sessionStorage once the app is READY on the client — not in onMounted,
  // which fires while Nuxt is still hydrating: a watch-triggered refresh
  // during hydration is answered from the server payload (Nuxt's default
  // getCachedData), so the restored search would show in the box and never
  // reach the rows. Empty on the server.
  const sessionSearch = ref("");
  if (searchMode === "session") {
    onNuxtReady(() => {
      try {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) sessionSearch.value = saved.slice(0, maxSearch);
      } catch {
        // storage unavailable: the search just starts empty
      }
    });
  }

  // The URL, checked.
  const query = computed<TableQuery<F, S>>(() => {
    const parsed = parseTableQuery(opts, route.query as Record<string, unknown>);
    return searchMode === "url" ? parsed : { ...parsed, q: sessionSearch.value };
  });

  function go(changes: Changes<S>, history: "push" | "replace" = "push") {
    const current = query.value;
    const next = tableQueryToUrl(
      opts,
      {
        q: changes.q ?? current.q,
        page: changes.page ?? current.page,
        sort: changes.sort ?? current.sort,
        desc: changes.desc ?? current.desc,
        filters: { ...(current.filters as Record<string, string | undefined>), ...(changes.filters ?? {}) },
      },
      route.query as Record<string, unknown>,
      { includeSearch: searchMode === "url" },
    );
    return history === "push" ? router.push({ query: next }) : router.replace({ query: next });
  }

  const setFilter = (name: keyof F & string, value: string | null | undefined) =>
    go({ filters: { [name]: value ?? null }, page: 1 });
  const setFilters = (values: Partial<Record<keyof F & string, string | null>>) =>
    go({ filters: values as Record<string, string | null>, page: 1 });
  const setPage = (page: number) => go({ page });
  /** A sort key the table declared; anything else is the default. */
  const setSort = (sort: string, desc: boolean) =>
    go({ sort: ((opts.sorts as readonly string[]).includes(sort) ? sort : opts.sorts[0]) as S[number], desc, page: 1 });
  const clear = () => {
    if (searchMode === "session") setSessionSearch("");
    return router.push({ query: {} });
  };
  function setSessionSearch(q: string) {
    sessionSearch.value = q;
    try {
      if (q) sessionStorage.setItem(storageKey, q);
      else sessionStorage.removeItem(storageKey);
    } catch {
      // storage unavailable: the search still applies for this page view
    }
  }
  const setSearch = (q: string) => {
    const text = q.trim().slice(0, maxSearch);
    if (searchMode === "url") return go({ q: text, page: 1 }, "replace");
    setSessionSearch(text);
    // Any change but the page itself goes back to page 1.
    if (query.value.page !== 1) return go({ page: 1 }, "replace");
    return Promise.resolve();
  };

  // Loading: the newest request wins. useAsyncData gives the first page to
  // the server render; the watch re-runs it on every change of the checked
  // query, and the controller cancels the request before it. A cancelled
  // request resolves to the last page shown, so nothing flickers.
  let controller: AbortController | null = null;
  let last: ServerPage<Row> = EMPTY;
  const queryKey = computed(() => JSON.stringify(query.value));
  const { data, pending, error, refresh } = await useAsyncData<ServerPage<Row>>(
    opts.key,
    async (): Promise<ServerPage<Row>> => {
      controller?.abort();
      const mine = (controller = new AbortController());
      try {
        last = await opts.load(query.value, mine.signal);
        return last;
      } catch (e) {
        if (mine.signal.aborted) return last;
        throw e;
      }
    },
    { watch: [queryKey], default: () => EMPTY as ServerPage<Row>, dedupe: "cancel" },
  );
  onBeforeUnmount(() => controller?.abort());

  const rows = computed(() => data.value?.rows ?? []);
  const total = computed(() => data.value?.total ?? 0);
  const totalExact = computed(() => data.value?.total_exact ?? true);
  const filtering = computed(() => !!(query.value.q || Object.keys(query.value.filters).length));

  return { query, rows, total, totalExact, pending, error, setFilter, setFilters, setSearch, setPage, setSort, clear, refresh, filtering };
}
