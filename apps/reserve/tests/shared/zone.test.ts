// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import {
  localToUtc,
  dayOfWeek,
  zonedParts,
  localDateKey,
  minutesIntoDay,
  timeLabel,
  shortTime,
} from "../../shared/time/zone";

// The one timezone module both the slots route and the schedule grid use.
// Every zone here is chosen to DIFFER from wherever the tests run (a Los
// Angeles laptop, a UTC runner): New York, Kolkata (a half-hour offset, no
// DST), Auckland (the far side of the date line), Tokyo. A case that passed
// only because the runner happened to share the zone would prove nothing.

// 10:00 on Wednesday 2026-10-07 in New York (EDT, UTC−4).
const NY_TEN = "2026-10-07T14:00:00.000Z";

describe("localToUtc — a local wall time in a zone to the instant", () => {
  it("New York, in daylight time", () => {
    expect(localToUtc("2026-10-07", "10:00", "America/New_York").toISOString()).toBe(NY_TEN);
  });
  it("Los Angeles, the same wall time, three hours later as an instant", () => {
    expect(localToUtc("2026-10-07", "10:00", "America/Los_Angeles").toISOString()).toBe("2026-10-07T17:00:00.000Z");
  });
  it("Kolkata — a half-hour offset, no DST", () => {
    expect(localToUtc("2026-10-07", "10:00", "Asia/Kolkata").toISOString()).toBe("2026-10-07T04:30:00.000Z");
  });
  it("Auckland — 10:00 local is still the previous UTC day", () => {
    expect(localToUtc("2026-10-07", "10:00", "Pacific/Auckland").toISOString()).toBe("2026-10-06T21:00:00.000Z");
  });
  it("across the spring-forward edge in New York: the day before and the day of", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT. 03:00 the day before is EST (UTC−5).
    expect(localToUtc("2026-03-07", "03:00", "America/New_York").toISOString()).toBe("2026-03-07T08:00:00.000Z");
    // 03:00 on the day is EDT (UTC−4).
    expect(localToUtc("2026-03-08", "03:00", "America/New_York").toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });
  it("midnight, the day boundary the schedule's fetch range is built from", () => {
    expect(localToUtc("2026-10-07", "00:00", "America/New_York").toISOString()).toBe("2026-10-07T04:00:00.000Z");
  });
});

describe("dayOfWeek — of a key, zone-free", () => {
  it("2026-10-07 is a Wednesday wherever it is read", () => {
    expect(dayOfWeek("2026-10-07")).toBe(3);
  });
  it("2026-10-04 is a Sunday (0)", () => {
    expect(dayOfWeek("2026-10-04")).toBe(0);
  });
});

describe("zonedParts / localDateKey / minutesIntoDay — an instant read in a zone", () => {
  it("New York: 10:00 on the 7th, a Wednesday", () => {
    expect(zonedParts(NY_TEN, "America/New_York")).toEqual({ year: 2026, month: 10, day: 7, hour: 10, minute: 0, weekday: 3 });
    expect(localDateKey(NY_TEN, "America/New_York")).toBe("2026-10-07");
    expect(minutesIntoDay(NY_TEN, "America/New_York")).toBe(600);
  });
  it("Los Angeles: the same instant is 7:00 — the seam, as a number", () => {
    expect(minutesIntoDay(NY_TEN, "America/Los_Angeles")).toBe(420);
  });
  it("Tokyo: 23:00 the same day", () => {
    expect(zonedParts(NY_TEN, "Asia/Tokyo")).toMatchObject({ day: 7, hour: 23, minute: 0 });
    expect(minutesIntoDay(NY_TEN, "Asia/Tokyo")).toBe(1380);
  });
  it("Auckland: 03:00 on the NEXT day — the day key moves, the instant does not", () => {
    expect(zonedParts(NY_TEN, "Pacific/Auckland")).toMatchObject({ day: 8, hour: 3, minute: 0, weekday: 4 });
    expect(localDateKey(NY_TEN, "Pacific/Auckland")).toBe("2026-10-08");
  });
  it("Kolkata: 19:30, the half hour survives", () => {
    expect(minutesIntoDay(NY_TEN, "Asia/Kolkata")).toBe(19 * 60 + 30);
  });
  it("local midnight reads as hour 0, never 24", () => {
    expect(zonedParts("2026-10-07T04:00:00.000Z", "America/New_York")).toMatchObject({ day: 7, hour: 0, minute: 0 });
    expect(minutesIntoDay("2026-10-07T04:00:00.000Z", "America/New_York")).toBe(0);
  });
  it("accepts a Date as well as an ISO string", () => {
    expect(localDateKey(new Date(NY_TEN), "America/New_York")).toBe("2026-10-07");
  });
});

describe("timeLabel / shortTime — the strings a card and a slot button show", () => {
  it("New York: 10:00 AM / 10a", () => {
    expect(timeLabel(NY_TEN, "America/New_York")).toBe("10:00 AM");
    expect(shortTime(NY_TEN, "America/New_York")).toBe("10a");
  });
  it("Los Angeles: 7:00 AM / 7a — what the seam showed", () => {
    expect(timeLabel(NY_TEN, "America/Los_Angeles")).toBe("7:00 AM");
    expect(shortTime(NY_TEN, "America/Los_Angeles")).toBe("7a");
  });
  it("Kolkata: 7:30 PM / 7:30p", () => {
    expect(timeLabel(NY_TEN, "Asia/Kolkata")).toBe("7:30 PM");
    expect(shortTime(NY_TEN, "Asia/Kolkata")).toBe("7:30p");
  });
  it("noon and midnight are 12p and 12a, not 0", () => {
    expect(shortTime("2026-10-07T16:00:00.000Z", "America/New_York")).toBe("12p");
    expect(shortTime("2026-10-07T04:00:00.000Z", "America/New_York")).toBe("12a");
    expect(timeLabel("2026-10-07T04:00:00.000Z", "America/New_York")).toBe("12:00 AM");
  });
});

describe("the two directions agree — the route's conversion and the grid's", () => {
  // The slots route turns a rule's local time into an instant (localToUtc);
  // the grid turns that instant back into a day key and minutes
  // (localDateKey, minutesIntoDay). Round-tripping through both in every
  // zone is the check that they cannot disagree — the shape of the bug
  // the seam was.
  const zones = ["America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Auckland", "Asia/Tokyo", "UTC"];
  const walls: [string, string][] = [
    ["2026-10-07", "10:00"],
    ["2026-10-07", "00:00"],
    ["2026-10-07", "23:45"],
    ["2026-03-08", "03:00"], // the hour after New York springs forward
    ["2026-11-01", "03:00"], // the hour after New York falls back
    ["2026-12-31", "23:30"],
  ];
  for (const zone of zones) {
    for (const [day, time] of walls) {
      it(`${day} ${time} in ${zone}`, () => {
        const instant = localToUtc(day, time, zone);
        expect(localDateKey(instant, zone)).toBe(day);
        const [h, m] = time.split(":").map(Number) as [number, number];
        expect(minutesIntoDay(instant, zone)).toBe(h * 60 + m);
      });
    }
  }
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
      // Node re-reads TZ for new Date work; a sanity check that it did.
      expect(new Date(NY_TEN).getTimezoneOffset()).not.toBe(240);
      expect(timeLabel(NY_TEN, "America/New_York")).toBe("10:00 AM");
      expect(minutesIntoDay(NY_TEN, "America/New_York")).toBe(600);
      expect(localDateKey(NY_TEN, "Pacific/Auckland")).toBe("2026-10-08");
      expect(localToUtc("2026-10-07", "10:00", "America/New_York").toISOString()).toBe(NY_TEN);
    }
  });
});
