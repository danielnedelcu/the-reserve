// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookingConfirmationEmail,
  cancellationNoticeEmail,
  dayBeforeReminderEmail,
  intakeReminderEmail,
} from "../../server/utils/emailTemplates";

// The production server runs in UTC. A template that formatted an
// appointment time on the process clock would be right on a laptop in
// Eastern time and wrong in production — so every template is rendered
// here WITH the process in UTC and the location in New York, and the
// New York time must appear. 14:00Z on 2026-10-07 is 10:00 AM in New
// York and 2:00 PM on the process clock; "2:00 PM" anywhere is the bug.
//
// The booking route, the resend route, the cancel route and the
// communications job all pass `location.timezone` from the row they
// load (read 2026-10-07); these templates are what they render.

const START = "2026-10-07T14:00:00.000Z";
const NY = "America/New_York";
const location = { name: "The Reserve", phone: "555-0100", city: "New York", state: "NY", postalCode: "10001" };

describe("email templates format the appointment time in the location's zone, not the server's", () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  const expectNewYork = (content: { subject: string; html: string }) => {
    const text = `${content.subject}\n${content.html}`;
    expect(text).toContain("10:00 AM");
    expect(text).not.toContain("2:00 PM");
    expect(text).toContain("October 7");
  };

  it("the booking confirmation", () => {
    expectNewYork(
      bookingConfirmationEmail({
        clientFirstName: "Noor",
        serviceName: "Massage",
        staffName: "Sam",
        startsAtIso: START,
        timezone: NY,
        location,
        cancelUrl: "https://example.test/cancel/abc",
      }),
    );
  });

  it("the day-before reminder, fee cutoff included", () => {
    const content = dayBeforeReminderEmail({
      clientFirstName: "Noor",
      serviceName: "Massage",
      staffName: "Sam",
      startsAtIso: START,
      timezone: NY,
      location,
      cancelUrl: "https://example.test/cancel/abc",
      feeCutoffIso: "2026-10-06T14:00:00.000Z", // 24 hours before: Tuesday 10:00 AM in New York
    });
    expectNewYork(content);
    expect(content.html).toContain("Tuesday");
  });

  it("the intake reminder", () => {
    expectNewYork(
      intakeReminderEmail({
        clientFirstName: "Noor",
        serviceName: "Massage",
        startsAtIso: START,
        timezone: NY,
        formUrl: "https://example.test/join/abc",
        formName: "Treatment consent",
      }),
    );
  });

  it("the cancellation notice, every outcome", () => {
    for (const outcome of ["outside_window", "waived", "charge", "uncollected"] as const) {
      expectNewYork(
        cancellationNoticeEmail({
          clientFirstName: "Noor",
          serviceName: "Massage",
          staffName: "Sam",
          startsAtIso: START,
          timezone: NY,
          locationName: "The Reserve",
          outcome,
          feeCents: 5_000,
          cardLast4: outcome === "charge" ? "4242" : null,
        }),
      );
    }
  });

  it("a different zone moves the time, so the zone is what is being read", () => {
    const la = bookingConfirmationEmail({
      clientFirstName: "Noor",
      serviceName: "Massage",
      staffName: "Sam",
      startsAtIso: START,
      timezone: "America/Los_Angeles",
      location,
      cancelUrl: "https://example.test/cancel/abc",
    });
    expect(la.subject).toContain("7:00 AM");
  });
});
