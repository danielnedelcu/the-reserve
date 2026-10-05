// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMMUNICATION_KINDS,
  communicationKindLabel,
  communicationChannelLabel,
  isResendable,
  appointmentReference,
} from "../../shared/communications/kinds";

describe("communication kinds", () => {
  it("labels every value the check constraint allows, and nothing is blank", () => {
    // The constraint is the authority: read it from the migration that
    // created it, so a swap that adds a kind without a label fails here.
    const sql = readFileSync(
      new URL(
        "../../../../supabase/migrations/20260926160705_client_communications_phase1.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const constraint = sql.match(
      /kind\s+text not null\s+check \(kind in \(([^)]+)\)\)/,
    )?.[1];
    expect(constraint).toBeTruthy();
    const dbKinds = [...constraint!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...dbKinds].sort()).toEqual([...COMMUNICATION_KINDS].sort());
    for (const kind of dbKinds) {
      expect(communicationKindLabel(kind!)).not.toBe(kind);
      expect(communicationKindLabel(kind!).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw value for an unknown kind or channel", () => {
    expect(communicationKindLabel("something_new")).toBe("something_new");
    expect(communicationChannelLabel("email")).toBe("Email");
    expect(communicationChannelLabel("carrier_pigeon")).toBe("carrier_pigeon");
  });

  it("only the confirmation is resendable", () => {
    for (const kind of COMMUNICATION_KINDS) {
      expect(isResendable(kind)).toBe(kind === "confirmation");
    }
  });
});

describe("appointmentReference reads the snapshot, tolerating gaps", () => {
  it("formats service and time in the given timezone", () => {
    expect(
      appointmentReference(
        { service_name: "Herbal Body Wrap", starts_at: "2026-09-27T14:00:00Z" },
        "America/New_York",
      ),
    ).toBe("Herbal Body Wrap · Sun, Sep 27, 10:00 AM");
  });

  it("copes with a missing half, bad dates, and no appointment at all", () => {
    expect(appointmentReference({ service_name: "Facial" }, "UTC")).toBe(
      "Facial",
    );
    expect(
      appointmentReference({ starts_at: "not a date", service_name: "X" }, "UTC"),
    ).toBe("X");
    expect(appointmentReference({ local_date: "2026-09-27" }, "UTC")).toBeNull();
    expect(appointmentReference(null, "UTC")).toBeNull();
    expect(appointmentReference("garbage", "UTC")).toBeNull();
  });
});
