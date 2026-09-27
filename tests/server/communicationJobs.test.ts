// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  isJobKind,
  isTransactional,
  blockedByOptIn,
  deliveryChannel,
  localDateKey,
  shiftDateKey,
  localDayWindow,
  localYearStart,
  isBirthday,
  alreadySentForAppointment,
  alreadySentThisYear,
  lateCancellationCutoff,
  type SentRow,
} from "../../server/utils/communicationJobs";

/**
 * The pure logic behind the four scheduled communications. Every case is
 * an edge where a rewrite could disagree with the invariant while every
 * ordinary night still looked right: DST days, the year boundary, the
 * opt-in gate on the wrong kind, a dedup row for the wrong appointment.
 */
const TZ = "America/New_York";

describe("job kinds and the opt-in gate", () => {
  it("accepts exactly the four kinds", () => {
    expect(isJobKind("day_before_reminder")).toBe(true);
    expect(isJobKind("birthday")).toBe(true);
    expect(isJobKind("confirmation")).toBe(false); // phase 2's kind, not a job
    expect(isJobKind(undefined)).toBe(false);
  });

  it("transactional kinds ignore opt-out; non-transactional kinds honour it", () => {
    expect(isTransactional("day_before_reminder")).toBe(true);
    expect(isTransactional("intake_reminder")).toBe(true);
    expect(isTransactional("post_visit_followup")).toBe(false);
    expect(isTransactional("birthday")).toBe(false);

    expect(blockedByOptIn("day_before_reminder", false)).toBe(false);
    expect(blockedByOptIn("intake_reminder", false)).toBe(false);
    expect(blockedByOptIn("post_visit_followup", false)).toBe(true);
    expect(blockedByOptIn("birthday", false)).toBe(true);
    expect(blockedByOptIn("birthday", true)).toBe(false);
  });

  it("every channel preference delivers as email until SMS lands", () => {
    expect(deliveryChannel("email")).toBe("email");
    expect(deliveryChannel("sms")).toBe("email");
    expect(deliveryChannel("both")).toBe("email");
  });
});

describe("local calendar arithmetic", () => {
  it("keys an instant by the LOCATION's calendar, not UTC's", () => {
    // 03:30 UTC on the 27th is still the evening of the 26th in New York.
    expect(localDateKey(new Date("2026-09-27T03:30:00Z"), TZ)).toBe(
      "2026-09-26",
    );
    expect(localDateKey(new Date("2026-09-27T03:30:00Z"), "UTC")).toBe(
      "2026-09-27",
    );
  });

  it("shifts date keys across month and year ends", () => {
    expect(shiftDateKey("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("'tomorrow' at the 04:00 UTC tick is the next LOCAL day, bounded by local midnights", () => {
    // The cron tick: 04:00 UTC on Sep 27 = midnight Sep 27 in New York.
    const tick = new Date("2026-09-27T04:00:00Z");
    const w = localDayWindow(tick, TZ, 1);
    expect(w.dateKey).toBe("2026-09-28");
    expect(w.from.toISOString()).toBe("2026-09-28T04:00:00.000Z"); // 00:00 EDT
    expect(w.to.toISOString()).toBe("2026-09-29T04:00:00.000Z");
  });

  it("a DST day is not 24 hours long — the window ends at the NEXT local midnight", () => {
    // US DST ends Sunday 2026-11-01: that local day is 25 hours.
    const tick = new Date("2026-10-31T04:00:00Z"); // midnight Oct 31 EDT
    const w = localDayWindow(tick, TZ, 1);
    expect(w.dateKey).toBe("2026-11-01");
    expect(w.from.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // 00:00 EDT
    expect(w.to.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // 00:00 EST
    expect((w.to.getTime() - w.from.getTime()) / 3_600_000).toBe(25);
  });

  it("'yesterday' for the follow-up is the previous local day", () => {
    const tick = new Date("2026-09-27T04:10:00Z");
    const w = localDayWindow(tick, TZ, -1);
    expect(w.dateKey).toBe("2026-09-26");
  });

  it("the birthday year starts at local New Year, not UTC's", () => {
    const tick = new Date("2026-01-01T03:00:00Z"); // still Dec 31 in New York
    expect(localYearStart(tick, TZ).toISOString()).toBe(
      "2025-01-01T05:00:00.000Z",
    );
    expect(
      localYearStart(new Date("2026-06-15T12:00:00Z"), TZ).toISOString(),
    ).toBe("2026-01-01T05:00:00.000Z");
  });

  it("matches a birthday on month and day only", () => {
    expect(isBirthday("1990-09-27", "2026-09-27")).toBe(true);
    expect(isBirthday("1990-09-27", "2026-09-28")).toBe(false);
    expect(isBirthday(null, "2026-09-27")).toBe(false);
  });

  it("the fee cutoff is exactly 24 hours before the start", () => {
    expect(lateCancellationCutoff("2026-09-29T13:15:00Z").toISOString()).toBe(
      "2026-09-28T13:15:00.000Z",
    );
  });
});

describe("the dedup guards", () => {
  const rows: SentRow[] = [
    {
      client_id: "c1",
      appointment_id: "a1",
      kind: "day_before_reminder",
      sent_at: "2026-09-27T04:00:10Z",
    },
    {
      client_id: "c1",
      appointment_id: "a1",
      kind: "confirmation",
      sent_at: "2026-09-20T10:00:00Z",
    },
    {
      client_id: "c2",
      appointment_id: null,
      kind: "birthday",
      sent_at: "2025-09-27T04:15:10Z",
    },
    {
      client_id: "c3",
      appointment_id: null,
      kind: "birthday",
      sent_at: "2026-09-27T04:15:10Z",
    },
  ];

  it("appointment guard is scoped to BOTH the appointment and the kind", () => {
    expect(alreadySentForAppointment(rows, "a1", "day_before_reminder")).toBe(
      true,
    );
    expect(alreadySentForAppointment(rows, "a1", "post_visit_followup")).toBe(
      false,
    );
    expect(alreadySentForAppointment(rows, "a2", "day_before_reminder")).toBe(
      false,
    );
  });

  it("birthday guard is scoped to the client AND the current year", () => {
    const yearStart = new Date("2026-01-01T05:00:00Z");
    expect(alreadySentThisYear(rows, "c3", "birthday", yearStart)).toBe(true);
    expect(alreadySentThisYear(rows, "c2", "birthday", yearStart)).toBe(false); // last year's
    expect(alreadySentThisYear(rows, "c1", "birthday", yearStart)).toBe(false);
  });
});
