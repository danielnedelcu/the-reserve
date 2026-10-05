// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  recipientStatus,
  sortRecipients,
  campaignStats,
} from "../../shared/campaigns/analytics";

const T = "2026-09-27T12:00:00Z";
const row = (name: string, o: string | null, c: string | null, u: string | null) => ({
  name,
  opened_at: o,
  clicked_at: c,
  unsubscribed_at: u,
});

describe("recipientStatus", () => {
  it("picks the highest-signal state", () => {
    expect(recipientStatus(row("a", null, null, null))).toBe("sent");
    expect(recipientStatus(row("a", T, null, null))).toBe("opened");
    expect(recipientStatus(row("a", T, T, null))).toBe("clicked");
    expect(recipientStatus(row("a", null, T, null))).toBe("clicked"); // click without a recorded open
    expect(recipientStatus(row("a", T, T, T))).toBe("unsubscribed");
  });
});

describe("sortRecipients", () => {
  it("orders unsubscribed, clicked, opened, sent, then by name", () => {
    const out = sortRecipients([
      row("Zed", null, null, null),
      row("Amy", T, null, null),
      row("Bob", null, null, T),
      row("Cal", T, T, null),
      row("Abe", null, null, null),
      row("Ann", null, null, T),
    ]);
    expect(out.map((r) => r.name)).toEqual(["Ann", "Bob", "Cal", "Amy", "Abe", "Zed"]);
  });
});

describe("campaignStats", () => {
  it("rates divide by recipient_count, not by rows present", () => {
    const s = campaignStats([row("a", T, T, null), row("b", T, null, null), row("c", null, null, T)], 4);
    expect(s).toEqual({
      recipients: 4,
      opened: 2,
      clicked: 1,
      unsubscribed: 1,
      openRate: 0.5,
      clickRate: 0.25,
      noEngagement: false,
    });
  });

  it("no recipients means null rates, and untouched rows mean no engagement", () => {
    expect(campaignStats([], 0).openRate).toBeNull();
    const s = campaignStats([row("a", null, null, null)], 1);
    expect(s.noEngagement).toBe(true);
    expect(s.openRate).toBe(0);
  });
});
