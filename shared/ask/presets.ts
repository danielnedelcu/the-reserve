/**
 * Ask The Reserve — preset questions, keyed by route.
 *
 * Presets are the fast path: the id travels to /api/ask, which runs a
 * KNOWN-GOOD hardcoded query for it (see server/utils/askPresets.ts).
 * No LLM, no tokens, no wrongness risk. Only free-text questions go
 * through the SQL-generation path.
 *
 * The SQL deliberately lives server-side; this file is client-safe
 * metadata only. Ids must match the server map — that pairing is what
 * keeps a preset from silently falling through to the LLM.
 */

export interface AskPreset {
  id: string;
  /** Shown as a chip in the modal. Keep it phrased as a real question. */
  label: string;
}

export interface AskRoutePresets {
  /** Matched as a path prefix, longest first. */
  prefix: string;
  presets: AskPreset[];
}

/**
 * Route-keyed presets. Longest prefix wins, so "/clients/" entries take
 * precedence over "/clients". Unknown routes fall back to ORG_PRESETS.
 */
export const ROUTE_PRESETS: AskRoutePresets[] = [
  {
    prefix: "/clients",
    presets: [
      { id: "clients.lapsed_90", label: "Who hasn't visited in 90 days?" },
      { id: "clients.top_spenders_quarter", label: "Top spenders this quarter" },
      { id: "clients.new_this_month", label: "New clients this month" },
    ],
  },
  {
    prefix: "/schedule",
    presets: [
      { id: "schedule.today", label: "What's on the books today?" },
      { id: "schedule.tomorrow_gaps", label: "Where are tomorrow's gaps?" },
      { id: "schedule.no_shows_30", label: "No-shows in the last 30 days" },
    ],
  },
  {
    prefix: "/transactions",
    presets: [
      { id: "financials.revenue_this_month", label: "Revenue this month" },
      {
        id: "financials.gift_cards_outstanding",
        label: "Gift cards sold but never redeemed",
      },
      { id: "financials.top_services_quarter", label: "Top services this quarter" },
    ],
  },
  {
    prefix: "/products",
    presets: [
      { id: "products.low_stock", label: "What's running low on stock?" },
      { id: "products.best_sellers_quarter", label: "Best sellers this quarter" },
      { id: "products.never_sold", label: "Products that have never sold" },
    ],
  },
  {
    prefix: "/staff",
    presets: [
      { id: "staff.revenue_by_provider_month", label: "Revenue by provider this month" },
      { id: "staff.busiest_this_week", label: "Who's busiest this week?" },
      { id: "staff.pending_time_off", label: "Pending time-off requests" },
    ],
  },
];

/** Fallback for routes with no trio of their own. */
export const ORG_PRESETS: AskPreset[] = [
  { id: "financials.revenue_this_month", label: "Revenue this month" },
  { id: "clients.lapsed_90", label: "Who hasn't visited in 90 days?" },
  { id: "schedule.today", label: "What's on the books today?" },
];

/** Placeholder examples that cycle in the free-text input. */
export const EXAMPLE_QUESTIONS = [
  "Which clients booked twice last month?",
  "How many gift cards were sold in July?",
  "Which room is used least on weekends?",
  "Who has the most repeat clients?",
];

/**
 * Presets for a path. Longest matching prefix wins so detail pages can
 * differ from their list page later without reordering the array.
 */
export function presetsForRoute(path: string): AskPreset[] {
  const match = ROUTE_PRESETS.filter((entry) => path.startsWith(entry.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  return match?.presets ?? ORG_PRESETS;
}

/**
 * The human label for a preset id, for anywhere the id alone is unhelpful.
 *
 * Follow-up context is one such place: ask_queries stores question = null
 * for presets, so replaying "clients.top_spenders_quarter" as a prior turn
 * would tell the model nothing. The label is what the admin actually saw.
 */
export function presetLabel(id: string): string | null {
  for (const entry of ROUTE_PRESETS) {
    const found = entry.presets.find((p) => p.id === id);
    if (found) return found.label;
  }
  return ORG_PRESETS.find((p) => p.id === id)?.label ?? null;
}
