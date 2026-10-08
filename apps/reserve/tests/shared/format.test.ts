// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { dateLabel, dateTimeLabel, monthName, rangeLabel } from "../../shared/time/format";
import { pickedKey, pickerDate } from "../../shared/time/picker";
import { formatCount } from "../../shared/format/count";

// Every zone here differs from wherever the tests run (a Los Angeles
// laptop, a UTC runner): New York, Kolkata (half-hour offset, no DST),
// Auckland (over the date line). The last block changes the process's
// own zone and expects nothing to move.

// 10:00 on Wednesday 2026-10-07 in New York (EDT, UTC−4).
const NY_TEN = "2026-10-07T14:00:00.000Z";

describe("dateLabel — the day an instant falls on, in the zone", () => {
  it("New York", () => expect(dateLabel(NY_TEN, "America/New_York")).toBe("Oct 7, 2026"));
  it("Auckland is already the next day", () => expect(dateLabel(NY_TEN, "Pacific/Auckland")).toBe("Oct 8, 2026"));
  it("long month, no year", () => {
    expect(dateLabel(NY_TEN, "America/New_York", { month: "long" })).toBe("October 7, 2026");
    expect(dateLabel(NY_TEN, "America/New_York", { year: false })).toBe("Oct 7");
  });
  it("30 minutes past midnight in New York is still that day there, and the day before in Los Angeles", () => {
    const at = "2026-10-07T04:30:00.000Z";
    expect(dateLabel(at, "America/New_York", { year: false })).toBe("Oct 7");
    expect(dateLabel(at, "America/Los_Angeles", { year: false })).toBe("Oct 6");
  });
});

describe("dateTimeLabel and rangeLabel", () => {
  it("New York, Kolkata", () => {
    expect(dateTimeLabel(NY_TEN, "America/New_York")).toBe("Oct 7, 10:00 AM");
    expect(dateTimeLabel(NY_TEN, "Asia/Kolkata", { year: true })).toBe("Oct 7, 2026, 7:30 PM");
    expect(dateTimeLabel(NY_TEN, "America/New_York", { weekday: "short" })).toBe("Wed, Oct 7, 10:00 AM");
  });
  it("a range, both ends in the zone", () => {
    expect(rangeLabel(NY_TEN, "2026-10-08T21:00:00.000Z", "America/New_York", { weekday: "short" })).toBe("Wed, Oct 7, 10:00 AM → Thu, Oct 8, 5:00 PM");
  });
});

describe("monthName — the month an instant is in, in the zone", () => {
  it("an instant that is November in UTC is still October in Los Angeles", () => {
    const at = "2026-11-01T03:00:00.000Z";
    expect(monthName(at, "UTC")).toBe("November");
    expect(monthName(at, "America/Los_Angeles")).toBe("October");
  });
});

describe("picker bridge — a key to a picker Date and back", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });
  for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "UTC"]) {
    it(`round-trips in ${tz}, DST days included`, () => {
      process.env.TZ = tz;
      for (const key of ["2026-10-07", "2026-03-08", "2026-11-01", "2026-01-01", "2026-12-31"]) {
        expect(pickedKey(pickerDate(key))).toBe(key);
      }
    });
  }
});

describe("formatCount", () => {
  it("groups thousands and drops fractions", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
});

describe("nothing here depends on the process's own zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });
  it("the same labels under Auckland and Los Angeles", () => {
    const run = () => [
      dateLabel(NY_TEN, "America/New_York"),
      dateTimeLabel(NY_TEN, "Asia/Kolkata"),
      monthName("2026-11-01T03:00:00.000Z", "America/Los_Angeles"),
    ];
    process.env.TZ = "Pacific/Auckland";
    const a = run();
    process.env.TZ = "America/Los_Angeles";
    expect(run()).toEqual(a);
    expect(a).toEqual(["Oct 7, 2026", "Oct 7, 7:30 PM", "October"]);
  });
});
