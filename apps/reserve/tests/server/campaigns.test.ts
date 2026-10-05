// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  AUDIENCE_MONTHS,
  parseAudienceFilter,
  recencyCutoff,
  buildAudience,
  isValidTokenId,
  campaignBodies,
  type AudienceClient,
  type AudienceAppointment,
} from "../../server/utils/campaigns";

const NOW = new Date("2026-09-27T12:00:00Z");

const client = (
  id: string,
  last: string,
  first: string,
  opted = true,
  email: string | null = `${first}@x.test`,
): AudienceClient => ({
  id,
  first_name: first,
  last_name: last,
  email,
  communication_opted_in: opted,
});

describe("parseAudienceFilter", () => {
  it("null, undefined and an empty object all mean everyone opted in", () => {
    expect(parseAudienceFilter(null)).toBeNull();
    expect(parseAudienceFilter(undefined)).toBeNull();
    expect(parseAudienceFilter({})).toBeNull();
    expect(parseAudienceFilter({ last_visit_months: null })).toBeNull();
  });

  it("accepts exactly the offered month values", () => {
    for (const n of AUDIENCE_MONTHS) {
      expect(parseAudienceFilter({ last_visit_months: n })).toEqual({
        last_visit_months: n,
      });
    }
  });

  it("rejects anything else rather than falling back to everyone", () => {
    expect(parseAudienceFilter({ last_visit_months: 2 })).toBeUndefined();
    expect(parseAudienceFilter({ last_visit_months: "3" })).toBeUndefined();
    expect(parseAudienceFilter("all")).toBeUndefined();
    expect(parseAudienceFilter([3])).toBeUndefined();
  });
});

describe("buildAudience", () => {
  const clients = [
    client("a", "Zed", "Amy"),
    client("b", "Adams", "Bo"),
    client("c", "Adams", "Al"),
    client("d", "Out", "Opted", false),
    client("e", "Mail", "No", true, null),
  ];

  it("with no filter: every opted-in client with an email, sorted by name", () => {
    const out = buildAudience({ clients, appointments: [], filter: null, now: NOW });
    expect(out.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("never includes an opted-out client, whatever their visits", () => {
    const appts: AudienceAppointment[] = [
      { client_id: "d", status: "completed", starts_at: "2026-09-20T10:00:00Z" },
    ];
    for (const filter of [null, { last_visit_months: 1 }]) {
      const out = buildAudience({ clients, appointments: appts, filter, now: NOW });
      expect(out.some((c) => c.id === "d")).toBe(false);
    }
  });

  it("recency filter keeps only clients with a COMPLETED visit inside the window", () => {
    const appts: AudienceAppointment[] = [
      { client_id: "a", status: "completed", starts_at: "2026-09-01T10:00:00Z" }, // 26 days ago
      { client_id: "b", status: "completed", starts_at: "2026-04-01T10:00:00Z" }, // ~6 months ago
      { client_id: "c", status: "cancelled", starts_at: "2026-09-25T10:00:00Z" }, // recent but not completed
      { client_id: "c", status: "no_show", starts_at: "2026-09-26T10:00:00Z" },
    ];
    const ids = (n: number) =>
      buildAudience({
        clients,
        appointments: appts,
        filter: { last_visit_months: n },
        now: NOW,
      }).map((c) => c.id);
    expect(ids(1)).toEqual(["a"]);
    expect(ids(3)).toEqual(["a"]);
    expect(ids(6)).toEqual(["b", "a"]); // April 1 is inside a 6-month window from Sep 27
    expect(ids(12)).toEqual(["b", "a"]);
  });

  it("a client with no visits at all is out under any recency filter, in with none", () => {
    const out1 = buildAudience({
      clients: [client("z", "Quiet", "Q")],
      appointments: [],
      filter: { last_visit_months: 12 },
      now: NOW,
    });
    expect(out1).toEqual([]);
    const out2 = buildAudience({
      clients: [client("z", "Quiet", "Q")],
      appointments: [],
      filter: null,
      now: NOW,
    });
    expect(out2.map((c) => c.id)).toEqual(["z"]);
  });

  it("the window boundary is inclusive and the cutoff is calendar months", () => {
    const cutoff = recencyCutoff(3, NOW);
    expect(cutoff.toISOString()).toBe("2026-06-27T12:00:00.000Z");
    const appts: AudienceAppointment[] = [
      { client_id: "a", status: "completed", starts_at: cutoff.toISOString() },
      { client_id: "b", status: "completed", starts_at: new Date(cutoff.getTime() - 1).toISOString() },
    ];
    const out = buildAudience({
      clients,
      appointments: appts,
      filter: { last_visit_months: 3 },
      now: NOW,
    });
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("isValidTokenId", () => {
  it("accepts a uuid and nothing else", () => {
    expect(isValidTokenId("5bea8a43-993f-4248-a905-f8c05c02517a")).toBe(true);
    expect(isValidTokenId("not-a-token")).toBe(false);
    expect(isValidTokenId("")).toBe(false);
    expect(isValidTokenId(undefined)).toBe(false);
    expect(isValidTokenId("5bea8a43-993f-4248-a905-f8c05c02517a'; drop")).toBe(false);
  });
});

describe("campaignBodies", () => {
  const url = "https://reserve.test/unsubscribe/abc";

  it("puts the unsubscribe link in BOTH bodies and says transactional mail is unaffected", () => {
    const { html, text } = campaignBodies({ bodyPlain: "Hello there", unsubscribeUrl: url });
    expect(html).toContain(`href="${url}"`);
    expect(text).toContain(url);
    expect(html).toContain("Appointment confirmations and reminders are not affected");
    expect(text).toContain("Appointment confirmations and reminders are not affected");
  });

  it("turns blank lines into paragraphs and single newlines into breaks", () => {
    const { html } = campaignBodies({
      bodyPlain: "Line one\nLine two\n\nSecond paragraph",
      unsubscribeUrl: url,
    });
    expect(html).toContain("<p style=\"margin:0 0 16px;\">Line one<br />Line two</p>");
    expect(html).toContain("<p style=\"margin:0 0 16px;\">Second paragraph</p>");
  });

  it("escapes HTML in the composition and keeps the text verbatim", () => {
    const { html, text } = campaignBodies({
      bodyPlain: "Save 20% on <b>facials</b> & wraps",
      unsubscribeUrl: url,
    });
    expect(html).toContain("&lt;b&gt;facials&lt;/b&gt; &amp; wraps");
    expect(html).not.toContain("<b>facials</b>");
    expect(text.startsWith("Save 20% on <b>facials</b> & wraps")).toBe(true);
  });
});
