// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { timeLabel, shortTime, minutesIntoDay } from "../../app/utils/appointmentTime";

// What the appointment cards and the booking dialog print and where the
// day grid places a card — in the LOCATION's zone, which every caller
// passes. The zones differ from the runner's on purpose (a Los Angeles
// laptop, a UTC runner): a result that matched only because the runner
// shared the zone is the bug these exist to catch.

// 10:00 AM, Wednesday 2026-10-07, at a New York location.
const NY_TEN = "2026-10-07T14:00:00.000Z";

describe("timeLabel — the day card and the slot button", () => {
  it("prints the location's time, not the viewer's", () => {
    expect(timeLabel(NY_TEN, "America/New_York")).toBe("10:00 AM");
    expect(timeLabel(NY_TEN, "America/Los_Angeles")).toBe("7:00 AM"); // the seam, if the wrong zone were passed
    expect(timeLabel(NY_TEN, "Asia/Kolkata")).toBe("7:30 PM");
  });
});

describe("shortTime — the week and month chips", () => {
  it("drops :00, keeps :30, says a/p", () => {
    expect(shortTime(NY_TEN, "America/New_York")).toBe("10a");
    expect(shortTime("2026-10-07T18:30:00.000Z", "America/New_York")).toBe("2:30p");
    expect(shortTime(NY_TEN, "Asia/Kolkata")).toBe("7:30p");
  });
});

describe("minutesIntoDay — the card's vertical position", () => {
  it("is the location's minutes since its midnight", () => {
    expect(minutesIntoDay(NY_TEN, "America/New_York")).toBe(600);
    expect(minutesIntoDay(NY_TEN, "America/Los_Angeles")).toBe(420);
    expect(minutesIntoDay(NY_TEN, "Pacific/Auckland")).toBe(180); // 03:00 the next day
  });
});

describe("with the runner in another zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  it("nothing changes", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(timeLabel(NY_TEN, "America/New_York")).toBe("10:00 AM");
    expect(shortTime(NY_TEN, "America/New_York")).toBe("10a");
    expect(minutesIntoDay(NY_TEN, "America/New_York")).toBe(600);
  });
});
