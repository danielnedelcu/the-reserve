/**
 * Campaign analytics as pure functions over campaign_recipients rows
 * (marketing campaigns, phase 2). The detail page renders these; nothing
 * here touches the database.
 */

export interface RecipientEngagement {
  opened_at: string | null;
  clicked_at: string | null;
  unsubscribed_at: string | null;
}

export type RecipientStatus = "unsubscribed" | "clicked" | "opened" | "sent";

/** Highest-signal state wins: an unsubscribe outranks a click outranks an open. */
export function recipientStatus(r: RecipientEngagement): RecipientStatus {
  if (r.unsubscribed_at) return "unsubscribed";
  if (r.clicked_at) return "clicked";
  if (r.opened_at) return "opened";
  return "sent";
}

const STATUS_ORDER: Record<RecipientStatus, number> = {
  unsubscribed: 0,
  clicked: 1,
  opened: 2,
  sent: 3,
};

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  unsubscribed: "Unsubscribed",
  clicked: "Clicked",
  opened: "Opened",
  sent: "Sent",
};

/** Status priority first (unsubscribed at the top), then name within a group. */
export function sortRecipients<T extends RecipientEngagement & { name: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[recipientStatus(a)] - STATUS_ORDER[recipientStatus(b)] ||
      a.name.localeCompare(b.name),
  );
}

export interface CampaignStats {
  recipients: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  /** 0–1, or null when there were no recipients to divide by. */
  openRate: number | null;
  clickRate: number | null;
  /** True when no row carries any timestamp yet. */
  noEngagement: boolean;
}

/**
 * Rates are over the campaign's recipient_count (what was sent), not
 * over the rows present, so a recipient row that failed to write still
 * counts in the denominator.
 */
export function campaignStats(
  rows: readonly RecipientEngagement[],
  recipientCount: number,
): CampaignStats {
  const opened = rows.filter((r) => r.opened_at).length;
  const clicked = rows.filter((r) => r.clicked_at).length;
  const unsubscribed = rows.filter((r) => r.unsubscribed_at).length;
  const denom = recipientCount > 0 ? recipientCount : null;
  return {
    recipients: recipientCount,
    opened,
    clicked,
    unsubscribed,
    openRate: denom ? opened / denom : null,
    clickRate: denom ? clicked / denom : null,
    noEngagement: rows.every((r) => !r.opened_at && !r.clicked_at && !r.unsubscribed_at),
  };
}
