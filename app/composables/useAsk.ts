/**
 * useAsk — the app-wide "ask a question" channel.
 *
 * ask() dispatches a window CustomEvent rather than calling the dock
 * directly. That indirection is the whole point: any component anywhere can
 * become ask-aware without importing the dock, knowing where it lives, or
 * being wired to it — an AskChip on a client page just calls
 * askText("When did they last visit?"). AskDock is the single listener.
 * (Ported from the reference app's askVetra() dispatcher.)
 *
 * Two keyboard surfaces, two different contracts:
 *   ⌘K = deterministic, instant, navigational (AppCommandPalette)
 *   ⌘I = generative, seconds-latency, informational (AskModal)
 *
 * Entry points multiply; the results surface does not. The header trigger,
 * ⌘I, and any future chip all dispatch the same event, and AskDock is the
 * only listener — so there is exactly one place an answer can appear.
 */

export interface AskRequest {
  /** Free text — goes through the LLM → SQL path. */
  question?: string;
  /** Preset id — runs known-good server-side SQL, no LLM. */
  presetId?: string;
  /** The route the question was asked from (for LLM context). */
  route?: string;
  /** Human label to show in the dock while it runs. */
  label: string;
}

export interface AskResult {
  source: "preset" | "llm";
  /**
   * The question with thread references spelled out, when the model had to
   * resolve any. Shown as "interpreting as: …" so a misreading is visible.
   */
  resolvedQuestion: string | null;
  /** Null for presets — the SQL affordance is for generated queries. */
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  /**
   * Deterministic caption built server-side from the result shape
   * (row count, or the single value). NOT model-written: result rows are
   * never sent to the API, so no prose summary exists to show.
   */
  answer: string | null;
  /** True when the row cap trimmed the result. */
  truncated: boolean;
}

const ASK_EVENT = "reserve:ask";

export function useAsk() {
  const dockOpen = useState("ask-dock-open", () => false);

  /**
   * The current conversation thread. Sent with every ask so the route can
   * reconstruct prior turns from ask_queries and resolve follow-ups
   * ("and who used it?") against them.
   *
   * Only the ID travels. The client never sends its own history — the
   * server reads the thread back out of the log, so context cannot be
   * forged and the audit trail is the source of truth for what a refined
   * question was refining.
   */
  const threadId = useState<string>("ask-thread-id", () => crypto.randomUUID());

  /** Start a fresh conversation. "New thread" means this, not just a wipe. */
  function resetThread() {
    threadId.value = crypto.randomUUID();
  }

  /** The ⌘I prompt modal (AskModal). Its asks surface in the dock. */
  const modalOpen = useState("ask-modal-open", () => false);

  /** Fire a question from anywhere. The dock picks it up and opens. */
  function ask(request: AskRequest) {
    window.dispatchEvent(new CustomEvent<AskRequest>(ASK_EVENT, { detail: request }));
  }

  /** Convenience for chips and buttons: ask free text, label it with itself. */
  function askText(question: string, route?: string) {
    ask({ question, route, label: question });
  }

  /** Subscribe to asks. Used by AskDock; auto-cleans on unmount. */
  function onAsk(handler: (request: AskRequest) => void) {
    useEventListener(window, ASK_EVENT, (event) => {
      handler((event as CustomEvent<AskRequest>).detail);
    });
  }

  const openDock = () => {
    dockOpen.value = true;
  };
  const closeDock = () => {
    dockOpen.value = false;
  };
  const toggleDock = () => {
    dockOpen.value = !dockOpen.value;
  };
  const openModal = () => {
    modalOpen.value = true;
  };

  return {
    ask,
    askText,
    onAsk,
    threadId,
    resetThread,
    dockOpen,
    openDock,
    closeDock,
    toggleDock,
    modalOpen,
    openModal,
  };
}
