// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { periodDays, periodRange, previousPeriod, comparablePrevious, shiftPeriod, shiftDays, rollingDays, todayKey, periodFromQuery, keyLabel, monthLabel, weekdayLabel, dayOfMonth, daysInMonth, monthStartOf, shiftMonths } from "../../shared/time/period";

// The one derivation of a reporting window: keys for the calendar,
// instants in the LOCATION's zone for the edges. The zones here differ
// from the runner's on purpose (a Los Angeles laptop, a UTC runner): New
// York, Kolkata (half-hour offset, no DST), Auckland (far side of the
// date line, southern DST), Tokyo. Weeks start on Sunday.

const ZONES = ["America/New_York", "Asia/Kolkata", "Pacific/Auckland"];

describe("periodDays — the calendar, zone-free", () => {
  it("a day is itself", () => {
    expect(periodDays({ period: "day", anchor: "2026-10-06" })).toEqual({ fromKey: "2026-10-06", toKey: "2026-10-06", label: "Tuesday, October 6, 2026" });
  });
  it("a week starts on SUNDAY and holds seven days", () => {
    // 2026-10-06 is a Tuesday; the week is Sun 4 – Sat 10.
    expect(periodDays({ period: "week", anchor: "2026-10-06" })).toMatchObject({ fromKey: "2026-10-04", toKey: "2026-10-10", label: "Oct 4 – Oct 10" });
    // A Sunday anchors its own week; a Saturday is the last day of its.
    expect(periodDays({ period: "week", anchor: "2026-10-04" }).fromKey).toBe("2026-10-04");
    expect(periodDays({ period: "week", anchor: "2026-10-10" }).toKey).toBe("2026-10-10");
  });
  it("a month runs first to last, including a leap February and a year end", () => {
    expect(periodDays({ period: "month", anchor: "2026-10-06" })).toMatchObject({ fromKey: "2026-10-01", toKey: "2026-10-31", label: "October 2026" });
    expect(periodDays({ period: "month", anchor: "2028-02-15" }).toKey).toBe("2028-02-29");
    expect(periodDays({ period: "month", anchor: "2026-12-31" })).toMatchObject({ fromKey: "2026-12-01", toKey: "2026-12-31" });
  });
  it("a year", () => {
    expect(periodDays({ period: "year", anchor: "2026-10-06" })).toEqual({ fromKey: "2026-01-01", toKey: "2026-12-31", label: "2026" });
  });
  it("a custom range is inclusive of its end day, and tolerates a reversed pair", () => {
    expect(periodDays({ from: "2026-10-01", to: "2026-10-15" })).toMatchObject({ fromKey: "2026-10-01", toKey: "2026-10-15", label: "Oct 1 – Oct 15" });
    expect(periodDays({ from: "2026-10-15", to: "2026-10-01" })).toMatchObject({ fromKey: "2026-10-01", toKey: "2026-10-15" });
    expect(periodDays({ from: "2026-10-06", to: "2026-10-06" }).label).toBe("Tuesday, October 6, 2026");
  });
});

describe("periodRange — the location's midnights, half-open", () => {
  it("New York: a day in daylight time is [04:00Z, 04:00Z next day)", () => {
    const r = periodRange({ period: "day", anchor: "2026-10-06" }, "America/New_York");
    expect(r.from.toISOString()).toBe("2026-10-06T04:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-07T04:00:00.000Z");
  });
  it("Kolkata: a half-hour offset, no DST", () => {
    const r = periodRange({ period: "day", anchor: "2026-10-06" }, "Asia/Kolkata");
    expect(r.from.toISOString()).toBe("2026-10-05T18:30:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-06T18:30:00.000Z");
  });
  it("Auckland: the day begins on the previous UTC day", () => {
    const r = periodRange({ period: "day", anchor: "2026-10-06" }, "Pacific/Auckland");
    expect(r.from.toISOString()).toBe("2026-10-05T11:00:00.000Z");
  });
  it("the custom range's exclusive end is the midnight AFTER its last day", () => {
    const r = periodRange({ from: "2026-10-01", to: "2026-10-15" }, "America/New_York");
    expect(r.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-16T04:00:00.000Z");
  });
  it("New York spring forward: the day is 23 hours", () => {
    const r = periodRange({ period: "day", anchor: "2026-03-08" }, "America/New_York");
    expect((r.to.getTime() - r.from.getTime()) / 3_600_000).toBe(23);
    expect(r.from.toISOString()).toBe("2026-03-08T05:00:00.000Z"); // EST before
    expect(r.to.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // EDT after
  });
  it("New York fall back: the day is 25 hours", () => {
    const r = periodRange({ period: "day", anchor: "2026-11-01" }, "America/New_York");
    expect((r.to.getTime() - r.from.getTime()) / 3_600_000).toBe(25);
  });
  it("Auckland's own DST change (2026-09-27, forward): a 23-hour day in the south", () => {
    const r = periodRange({ period: "day", anchor: "2026-09-27" }, "Pacific/Auckland");
    expect((r.to.getTime() - r.from.getTime()) / 3_600_000).toBe(23);
  });
  it("a week across a DST change is 167 or 169 hours, not 168", () => {
    const spring = periodRange({ period: "week", anchor: "2026-03-10" }, "America/New_York");
    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(167);
    const fall = periodRange({ period: "week", anchor: "2026-11-03" }, "America/New_York");
    expect((fall.to.getTime() - fall.from.getTime()) / 3_600_000).toBe(169);
  });
  it("windows tile: this period's end is the next period's start, in every zone", () => {
    for (const zone of ZONES) {
      for (const period of ["day", "week", "month", "year"] as const) {
        const a = periodRange({ period, anchor: "2026-10-06" }, zone);
        const b = periodRange({ period, anchor: shiftPeriod(period, "2026-10-06", 1) }, zone);
        expect(a.to.toISOString()).toBe(b.from.toISOString());
      }
    }
  });
});

describe("shiftPeriod / previousPeriod — prev and next", () => {
  it("steps a day, a week, a month (to the 1st) and a year (to Jan 1)", () => {
    expect(shiftPeriod("day", "2026-10-06", -1)).toBe("2026-10-05");
    expect(shiftPeriod("week", "2026-10-06", 1)).toBe("2026-10-13");
    expect(shiftPeriod("month", "2026-10-06", 1)).toBe("2026-11-01");
    expect(shiftPeriod("month", "2026-01-15", -1)).toBe("2025-12-01");
    expect(shiftPeriod("year", "2026-10-06", -1)).toBe("2025-01-01");
  });
  it("the previous custom range is the same length, ending the day before", () => {
    expect(previousPeriod({ from: "2026-10-08", to: "2026-10-14" })).toEqual({ from: "2026-10-01", to: "2026-10-07" });
  });
  it("shiftDays crosses a month and a year end", () => {
    expect(shiftDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("comparablePrevious — the same elapsed span of the previous period", () => {
  const NY = "America/New_York";
  const iso = (d: Date) => d.toISOString();

  it("month-to-date is compared with the same days of last month, to the same time of day", () => {
    // October 8 at 10:30 in New York (EDT, 14:30Z): September 1 00:00 → September 8 10:30.
    const c = comparablePrevious({ period: "month", anchor: "2026-10-08" }, NY, new Date("2026-10-08T14:30:00Z"));
    expect(iso(c.from)).toBe("2026-09-01T04:00:00.000Z");
    expect(iso(c.to)).toBe("2026-09-08T14:30:00.000Z");
    expect(c.partial).toBe(true);
  });

  it("a complete period is compared with the whole previous one", () => {
    const c = comparablePrevious({ period: "month", anchor: "2026-09-15" }, NY, new Date("2026-10-08T14:30:00Z"));
    expect(iso(c.from)).toBe("2026-08-01T04:00:00.000Z");
    expect(iso(c.to)).toBe("2026-09-01T04:00:00.000Z");
    expect(c.partial).toBe(false);
  });

  it("a short previous month is taken whole: March 30 against all of February", () => {
    // March 30 at noon (EDT, 16:00Z): 29 elapsed days; February 2026 has 28.
    const c = comparablePrevious({ period: "month", anchor: "2026-03-30" }, NY, new Date("2026-03-30T16:00:00Z"));
    expect(iso(c.from)).toBe("2026-02-01T05:00:00.000Z");
    expect(iso(c.to)).toBe("2026-03-01T05:00:00.000Z");
    expect(c.partial).toBe(true);
  });

  it("a week across a month boundary: Thursday October 1 against Thursday September 24", () => {
    // Week Sun Sep 27 – Sat Oct 3, at Oct 1 09:00 (13:00Z): previous week from Sep 20, to Sep 24 09:00.
    const c = comparablePrevious({ period: "week", anchor: "2026-10-01" }, NY, new Date("2026-10-01T13:00:00Z"));
    expect(iso(c.from)).toBe("2026-09-20T04:00:00.000Z");
    expect(iso(c.to)).toBe("2026-09-24T13:00:00.000Z");
  });

  it("the first day of a month against the last day of the previous one", () => {
    const c = comparablePrevious({ period: "day", anchor: "2026-10-01" }, NY, new Date("2026-10-01T13:00:00Z"));
    expect(iso(c.from)).toBe("2026-09-30T04:00:00.000Z");
    expect(iso(c.to)).toBe("2026-09-30T13:00:00.000Z");
  });

  it("year-to-date across a leap year: March 1, 2025 against February 29, 2024", () => {
    // 59 days into 2025 at 08:00 (13:00Z); 59 days into 2024 is February 29.
    const c = comparablePrevious({ period: "year", anchor: "2025-03-01" }, NY, new Date("2025-03-01T13:00:00Z"));
    expect(iso(c.from)).toBe("2024-01-01T05:00:00.000Z");
    expect(iso(c.to)).toBe("2024-02-29T13:00:00.000Z");
  });

  it("keeps the wall-clock time across a DST change: November 10 at 10:00 EST against October 10 at 10:00 EDT", () => {
    const c = comparablePrevious({ period: "month", anchor: "2026-11-10" }, NY, new Date("2026-11-10T15:00:00Z"));
    expect(iso(c.to)).toBe("2026-10-10T14:00:00.000Z");
  });

  it("a period that has not begun has an empty window, so no arrow is drawn", () => {
    const c = comparablePrevious({ period: "month", anchor: "2026-11-15" }, NY, new Date("2026-10-08T14:30:00Z"));
    expect(c.from.getTime()).toBe(c.to.getTime());
    expect(c.partial).toBe(true);
  });

  it("a custom range still running is compared with the same elapsed span of the range before it", () => {
    // Oct 1–14 at Oct 5 09:00: the 14 days before are Sep 17–30; the window is Sep 17 → Sep 21 09:00.
    const c = comparablePrevious({ from: "2026-10-01", to: "2026-10-14" }, NY, new Date("2026-10-05T13:00:00Z"));
    expect(iso(c.from)).toBe("2026-09-17T04:00:00.000Z");
    expect(iso(c.to)).toBe("2026-09-21T13:00:00.000Z");
  });
});

describe("todayKey / rollingDays — what the dashboard asks for", () => {
  const now = new Date("2026-10-06T02:30:00.000Z"); // 22:30 on the 5th in New York, 11:30 on the 6th in Auckland
  it("today is the location's day, not UTC's", () => {
    expect(todayKey("America/New_York", now)).toBe("2026-10-05");
    expect(todayKey("Pacific/Auckland", now)).toBe("2026-10-06");
  });
  it("7 rolling days end now and start at the location's midnight six days before today", () => {
    const r = rollingDays(7, "America/New_York", now);
    expect(r.to).toBe(now);
    expect(r.from.toISOString()).toBe("2026-09-29T04:00:00.000Z");
  });
});

describe("periodFromQuery — the URL, checked", () => {
  const now = new Date("2026-10-06T02:30:00.000Z");
  it("nothing in the URL is the default month around today in the zone", () => {
    expect(periodFromQuery({}, "America/New_York", now)).toEqual({ period: "month", anchor: "2026-10-05" });
    expect(periodFromQuery({}, "Pacific/Auckland", now)).toEqual({ period: "month", anchor: "2026-10-06" });
  });
  it("a preset with an anchor; an unknown period is the default; a bad anchor is today", () => {
    expect(periodFromQuery({ period: "week", anchor: "2026-10-06" }, "UTC", now)).toEqual({ period: "week", anchor: "2026-10-06" });
    expect(periodFromQuery({ period: "fortnight", anchor: "2026-10-06" }, "UTC", now)).toEqual({ period: "month", anchor: "2026-10-06" });
    expect(periodFromQuery({ period: "day", anchor: "2026-02-30" }, "UTC", now)).toEqual({ period: "day", anchor: "2026-10-06" });
  });
  it("a custom range wins when both keys are real days; a broken one falls back", () => {
    expect(periodFromQuery({ from: "2026-10-01", to: "2026-10-15", period: "week" }, "UTC", now)).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(periodFromQuery({ from: "2026-10-01", to: "nope" }, "UTC", now)).toEqual({ period: "month", anchor: "2026-10-06" });
  });
  it("repeated keys take the first", () => {
    expect(periodFromQuery({ period: ["day", "year"], anchor: ["2026-10-06"] }, "UTC", now)).toEqual({ period: "day", anchor: "2026-10-06" });
  });
});

describe("none of it depends on the process's own zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  it("the same answers with TZ set to Tokyo, then to Honolulu", () => {
    for (const runnerZone of ["Asia/Tokyo", "Pacific/Honolulu"]) {
      process.env.TZ = runnerZone;
      expect(periodRange({ period: "day", anchor: "2026-10-06" }, "America/New_York").from.toISOString()).toBe("2026-10-06T04:00:00.000Z");
      expect(periodDays({ period: "week", anchor: "2026-10-06" }).fromKey).toBe("2026-10-04");
      expect(todayKey("Pacific/Auckland", new Date("2026-10-06T02:30:00.000Z"))).toBe("2026-10-06");
    }
  });
});

describe("key labels — words from a key alone, no Date, no zone", () => {
  it("keyLabel shapes", () => {
    expect(keyLabel("2026-10-07")).toBe("Oct 7");
    expect(keyLabel("2026-10-07", { year: true })).toBe("Oct 7, 2026");
    expect(keyLabel("2026-10-07", { weekday: "long", month: "long" })).toBe("Wednesday, October 7");
    expect(keyLabel("2026-10-07", { month: "long", day: false, year: true })).toBe("October 2026");
    expect(keyLabel("1990-05-03", { month: "long", year: true })).toBe("May 3, 1990"); // a date of birth, as stored
  });
  it("a date of birth never shifts a day, whatever the process zone", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        expect(keyLabel("1990-05-03", { month: "long", year: true })).toBe("May 3, 1990");
      }
    } finally {
      process.env.TZ = original;
    }
  });
  it("monthLabel, weekdayLabel, dayOfMonth, daysInMonth, monthStartOf, shiftMonths", () => {
    expect(monthLabel("2026-02-14")).toBe("February");
    expect(weekdayLabel("2026-10-07")).toBe("Wed");
    expect(weekdayLabel("2026-10-07", "long")).toBe("Wednesday");
    expect(dayOfMonth("2026-10-07")).toBe(7);
    expect(daysInMonth("2028-02-10")).toBe(29);
    expect(daysInMonth("2026-02-10")).toBe(28);
    expect(daysInMonth("2026-12-31")).toBe(31);
    expect(monthStartOf("2026-10-07")).toBe("2026-10-01");
    expect(shiftMonths("2026-10-07", 1)).toBe("2026-11-01");
    expect(shiftMonths("2026-01-31", -1)).toBe("2025-12-01");
  });
});
