/**
 * The newest search wins (docs/server-tables-reference.md §7, Lokl's
 * SearchSelect): typing waits `delay` ms after the last keystroke, each
 * request carries an AbortSignal that the next request aborts, and an
 * answer that arrives after a newer request was made is dropped — so the
 * list never shows results for a term the person has already moved past.
 *
 * Pure: no refs, no DOM. The picker component hands it the search and
 * three callbacks; tests/utils/latestSearch.test.ts drives it with fake
 * timers and a deliberately slow earlier search.
 */
export interface LatestSearchHandlers<T> {
  /** The answer for the newest term. Never called for a superseded term. */
  result: (term: string, value: T) => void;
  /** A failure of the newest term. Never called for an aborted one. */
  error?: (term: string, error: unknown) => void;
  /** True while a request is in flight; false once the newest one settles. */
  busy?: (busy: boolean) => void;
}

export interface LatestSearch {
  /** Search this term after the delay (typing). */
  request: (term: string) => void;
  /** Search this term now, no delay (a first open, a chosen value). */
  now: (term: string) => Promise<void>;
  /** Abort whatever is pending or in flight. */
  cancel: () => void;
}

export function createLatestSearch<T>(
  search: (term: string, signal: AbortSignal) => Promise<T>,
  handlers: LatestSearchHandlers<T>,
  delay = 300,
): LatestSearch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;

  async function run(term: string) {
    controller?.abort();
    const mine = (controller = new AbortController());
    handlers.busy?.(true);
    try {
      const value = await search(term, mine.signal);
      if (mine.signal.aborted) return;
      handlers.result(term, value);
    } catch (e) {
      if (mine.signal.aborted) return;
      handlers.error?.(term, e);
    } finally {
      if (!mine.signal.aborted) handlers.busy?.(false);
    }
  }

  return {
    request(term) {
      clearTimeout(timer);
      timer = setTimeout(() => void run(term), delay);
    },
    now(term) {
      clearTimeout(timer);
      return run(term);
    },
    cancel() {
      clearTimeout(timer);
      controller?.abort();
      controller = null;
      handlers.busy?.(false);
    },
  };
}
