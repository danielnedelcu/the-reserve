// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  asNumber,
  asDate,
  planColumns,
  columnLabel,
  formatCell,
  cellHref,
  cellValue,
  cellLink,
} from "../../app/utils/askFormat";
import { coerceRows } from "../../server/utils/askConnection";

/**
 * The bug these lock down: `sum(x_cents)` is widened to int8 by Postgres and
 * handed back as a STRING by node-postgres, so a money column arrived as
 * "35641" and rendered as raw cents under a header reading "Spend" — a wrong
 * figure that looks like a right one.
 *
 * Two independent defences are asserted here: the driver-level coercion that
 * makes the value a number, and the display layer accepting numeric strings
 * anyway so a future type slip cannot silently reintroduce raw cents.
 */

const INT8 = 20;
const INT4 = 23;
const NUMERIC = 1700;
const TEXT = 25;

describe("coerceRows", () => {
  it("coerces int8 columns to numbers", () => {
    const rows = coerceRows(
      [{ name: "spend_cents", dataTypeID: INT8 }],
      [{ spend_cents: "35641" }],
    );
    expect(rows[0]!.spend_cents).toBe(35641);
    expect(typeof rows[0]!.spend_cents).toBe("number");
  });

  it("leaves numeric (OID 1700) as a string — it can carry real decimals", () => {
    const rows = coerceRows(
      [{ name: "rate", dataTypeID: NUMERIC }],
      [{ rate: "1.005" }],
    );
    expect(rows[0]!.rate).toBe("1.005");
  });

  it("leaves int4 alone — the driver already returns it as a number", () => {
    const rows = coerceRows(
      [{ name: "price_cents", dataTypeID: INT4 }],
      [{ price_cents: 1200 }],
    );
    expect(rows[0]!.price_cents).toBe(1200);
  });

  it("leaves values past MAX_SAFE_INTEGER as strings rather than lose precision", () => {
    const huge = "9007199254740993"; // 2^53 + 1
    const rows = coerceRows(
      [{ name: "big_cents", dataTypeID: INT8 }],
      [{ big_cents: huge }],
    );
    expect(rows[0]!.big_cents).toBe(huge);
  });

  it("reduces a `date` column to its calendar day, avoiding a timezone drift", () => {
    // The driver hands back local midnight; keeping the timestamp would show
    // "12:00 AM" and slide to the previous day for viewers further west.
    const localMidnight = new Date(2026, 7, 11, 0, 0, 0);
    const rows = coerceRows(
      [{ name: "joined_at", dataTypeID: 1082 }],
      [{ joined_at: localMidnight }],
    );
    expect(rows[0]!.joined_at).toBe("2026-08-11");
  });

  it("does not touch text columns that happen to hold digits", () => {
    const rows = coerceRows(
      [{ name: "postal_code", dataTypeID: TEXT }],
      [{ postal_code: "02134" }],
    );
    expect(rows[0]!.postal_code).toBe("02134");
  });
});

describe("asNumber", () => {
  it("accepts numbers and numeric strings", () => {
    expect(asNumber(35641)).toBe(35641);
    expect(asNumber("35641")).toBe(35641);
    expect(asNumber(" 35641 ")).toBe(35641);
  });

  it("rejects non-numeric, empty, and non-finite values", () => {
    expect(asNumber("abc")).toBeNull();
    expect(asNumber("")).toBeNull();
    expect(asNumber(null)).toBeNull();
    expect(asNumber(Number.NaN)).toBeNull();
  });
});

describe("currency rendering", () => {
  const rows = [{ spend_cents: 35641, visits: 7 }];
  const cur = planColumns(["spend_cents", "visits"], rows);

  it("formats a _cents column as dollars", () => {
    expect(formatCell("spend_cents", 35641, cur)).toBe("$356.41");
  });

  it("formats a numeric STRING too, so a type slip still reads correctly", () => {
    const stringRows = [{ spend_cents: "35641" }];
    const c = planColumns(["spend_cents"], stringRows);
    expect(formatCell("spend_cents", "35641", c)).toBe("$356.41");
  });

  it("strips _cents from the header when the column really is money", () => {
    expect(columnLabel("spend_cents", cur)).toBe("Spend");
  });

  it("leaves non-money columns alone", () => {
    expect(formatCell("visits", 7, cur)).toBe("7");
    expect(columnLabel("visits", cur)).toBe("Visits");
  });

  it("renders null as an em dash", () => {
    expect(formatCell("spend_cents", null, cur)).toBe("—");
  });
});

describe("honest fallback when a _cents column cannot be formatted", () => {
  // The case that matters: if the value is not numeric, the column is not
  // treated as money ANYWHERE. Keeping the suffix means the reader still
  // sees the units. "Spend: 35641" would be a wrong number that looks right.
  const rows = [{ spend_cents: "n/a" }];
  const cur = planColumns(["spend_cents"], rows);

  it("does not classify the column as currency", () => {
    expect(cur.kinds.get("spend_cents")).toBe("text");
  });

  it("keeps _cents in the header", () => {
    expect(columnLabel("spend_cents", cur)).toBe("Spend cents");
  });

  it("shows the raw value rather than pretending it is dollars", () => {
    expect(formatCell("spend_cents", "n/a", cur)).toBe("n/a");
  });

  it("never produces the misleading 'Spend: 35641' pairing", () => {
    const mixed = [{ spend_cents: 35641 }, { spend_cents: "n/a" }];
    const c = planColumns(["spend_cents"], mixed);
    expect(columnLabel("spend_cents", c)).toBe("Spend cents");
    expect(formatCell("spend_cents", 35641, c)).toBe("35641");
  });
});

describe("date rendering (_at)", () => {
  it("formats a timestamp with its time of day", () => {
    const rows = [{ last_transaction_at: "2026-08-23T15:58:43.920Z" }];
    const plan = planColumns(["last_transaction_at"], rows);
    expect(plan.kinds.get("last_transaction_at")).toBe("date");
    expect(formatCell("last_transaction_at", rows[0]!.last_transaction_at, plan)).toMatch(
      /Aug 23, 2026/,
    );
  });

  it("renders a ::date cast (midnight UTC) as the day itself, not the day before", () => {
    // The classic off-by-one: midnight UTC formatted in a western local zone
    // lands on the previous date. Day-only values are formatted in UTC.
    const rows = [{ joined_at: "2026-08-23T00:00:00.000Z" }];
    const plan = planColumns(["joined_at"], rows);
    expect(formatCell("joined_at", rows[0]!.joined_at, plan)).toBe("Aug 23, 2026");
  });

  it("strips _at from the header when the column really is a date", () => {
    const plan = planColumns(["joined_at"], [{ joined_at: "2026-08-23T00:00:00.000Z" }]);
    expect(columnLabel("joined_at", plan)).toBe("Joined");
  });

  it("keeps _at in the header when the values are not dates", () => {
    const plan = planColumns(["joined_at"], [{ joined_at: "sometime" }]);
    expect(plan.kinds.get("joined_at")).toBe("text");
    expect(columnLabel("joined_at", plan)).toBe("Joined at");
    expect(formatCell("joined_at", "sometime", plan)).toBe("sometime");
  });

  it("does not treat a bare number as an epoch", () => {
    expect(asDate(7)).toBeNull();
    const plan = planColumns(["visits_at"], [{ visits_at: 7 }]);
    expect(plan.kinds.get("visits_at")).toBe("text");
  });

  it("never leaves a raw ISO string on screen for a well-named column", () => {
    const rows = [{ starts_at: "2026-08-23T15:58:43.920Z" }];
    const plan = planColumns(["starts_at"], rows);
    expect(formatCell("starts_at", rows[0]!.starts_at, plan)).not.toContain("T");
    expect(formatCell("starts_at", rows[0]!.starts_at, plan)).not.toContain("Z");
  });
});

describe("entity columns (_id) — stopgap", () => {
  const rows = [{ client_id: "7d2cf310-3b49-4b14-ad53-d5ece14d96ef", first_name: "Sam" }];
  const plan = planColumns(["client_id", "first_name"], rows);

  it("classifies _id as an entity column", () => {
    expect(plan.kinds.get("client_id")).toBe("entity");
  });

  it("hides it from display so a raw UUID never reaches the table", () => {
    expect(plan.visible).toEqual(["first_name"]);
    expect(plan.hidden).toEqual(["client_id"]);
  });

  it("keeps it in the data, ready for the chip renderer", () => {
    // The value is untouched — only the display omits it.
    expect(rows[0]!.client_id).toBe("7d2cf310-3b49-4b14-ad53-d5ece14d96ef");
  });
});

describe("right-alignment (numeric columns)", () => {
  it("right-aligns currency", () => {
    const plan = planColumns(["spend_cents"], [{ spend_cents: 35641 }]);
    expect(plan.numeric.has("spend_cents")).toBe(true);
  });

  it("right-aligns plain counts", () => {
    const plan = planColumns(["visits"], [{ visits: 7 }]);
    expect(plan.numeric.has("visits")).toBe(true);
  });

  it("does NOT right-align text that merely looks numeric", () => {
    // A postal code is text; pulling it right would misrepresent it as a
    // quantity, and "02134" would lose its leading zero to any numeric read.
    const plan = planColumns(["postal_code"], [{ postal_code: "02134" }]);
    expect(plan.numeric.has("postal_code")).toBe(false);
  });

  it("leaves names and dates left-aligned", () => {
    const plan = planColumns(
      ["first_name", "joined_at"],
      [{ first_name: "Sam", joined_at: "2026-08-23" }],
    );
    expect(plan.numeric.has("first_name")).toBe(false);
    expect(plan.numeric.has("joined_at")).toBe(false);
  });

  it("does not right-align a mixed column", () => {
    const plan = planColumns(["amount"], [{ amount: 5 }, { amount: "n/a" }]);
    expect(plan.numeric.has("amount")).toBe(false);
  });

  it("still right-aligns currency that arrived as numeric strings", () => {
    // The type-slip hardening path: kind is currency, so alignment follows.
    const plan = planColumns(["spend_cents"], [{ spend_cents: "35641" }]);
    expect(plan.numeric.has("spend_cents")).toBe(true);
  });
});

describe("entity links (_id consumed, not shown)", () => {
  const columns = ["client_id", "first_name", "last_name", "spend_cents"];
  const row = {
    client_id: "7d2cf310-3b49-4b14-ad53-d5ece14d96ef",
    first_name: "Samuel",
    last_name: "Adeyemi",
    spend_cents: 35641,
  };
  const plan = planColumns(columns, [row]);

  it("still hides the id column", () => {
    expect(plan.visible).toEqual(["first_name", "last_name", "spend_cents"]);
    expect(plan.hidden).toEqual(["client_id"]);
  });

  it("links the name cells that follow the id", () => {
    expect(cellHref("first_name", row, plan)).toBe(
      "/clients/7d2cf310-3b49-4b14-ad53-d5ece14d96ef",
    );
    expect(cellHref("last_name", row, plan)).toBe(
      "/clients/7d2cf310-3b49-4b14-ad53-d5ece14d96ef",
    );
  });

  it("ends the run at the first non-label column", () => {
    expect(cellHref("spend_cents", row, plan)).toBeNull();
  });

  it("routes staff_id to the staff page", () => {
    const r = { staff_id: "abc", provider: "Dana" };
    const p = planColumns(["staff_id", "provider"], [r]);
    expect(cellHref("provider", r, p)).toBe("/staff/abc");
  });

  it("keeps two entities in the same row apart", () => {
    const r = { client_id: "c1", first_name: "Sam", staff_id: "s1", provider: "Dana" };
    const p = planColumns(["client_id", "first_name", "staff_id", "provider"], [r]);
    expect(cellHref("first_name", r, p)).toBe("/clients/c1");
    expect(cellHref("provider", r, p)).toBe("/staff/s1");
  });

  it("does not link an id with no page of its own", () => {
    // appointment_id is hidden like any other id, but guessing /appointments
    // would produce a confident 404.
    const r = { appointment_id: "a1", notes: "back pain" };
    const p = planColumns(["appointment_id", "notes"], [r]);
    expect(p.hidden).toEqual(["appointment_id"]);
    expect(cellHref("notes", r, p)).toBeNull();
  });

  it("produces no link when the id is null (an unmatched outer join)", () => {
    const r = { client_id: null, first_name: "Walk-in" };
    const p = planColumns(["client_id", "first_name"], [r]);
    expect(cellHref("first_name", r, p)).toBeNull();
  });

  it("does not link a trailing status column to the person", () => {
    // "every following text column" would have made `status` a link to the
    // client, which is visibly wrong.
    const r = { client_id: "c1", first_name: "Sam", last_name: "Lee", status: "completed" };
    const p = planColumns(["client_id", "first_name", "last_name", "status"], [r]);
    expect(cellHref("first_name", r, p)).toBe("/clients/c1");
    expect(cellHref("last_name", r, p)).toBe("/clients/c1");
    expect(cellHref("status", r, p)).toBeNull();
  });

  it("links a single non-name label directly after the id", () => {
    const r = { staff_id: "s1", provider: "Dana", kind: "time_off" };
    const p = planColumns(["staff_id", "provider", "kind"], [r]);
    expect(cellHref("provider", r, p)).toBe("/staff/s1");
    expect(cellHref("kind", r, p)).toBeNull();
  });

  it("does not link a name column that has no id before it", () => {
    const r = { first_name: "Sam", spend_cents: 100 };
    const p = planColumns(["first_name", "spend_cents"], [r]);
    expect(cellHref("first_name", r, p)).toBeNull();
  });
});

describe("merged Name column", () => {
  const columns = ["client_id", "first_name", "last_name", "spend_cents"];
  const row = {
    client_id: "c1",
    first_name: "Samuel",
    last_name: "Adeyemi",
    spend_cents: 35641,
  };
  const plan = planColumns(columns, [row]);
  const byLabel = (l: string) => plan.display.find((c) => c.label === l)!;

  it("renders one Name column instead of First name / Last name", () => {
    expect(plan.display.map((c) => c.label)).toEqual(["Name", "Spend"]);
  });

  it("joins the parts into a single value", () => {
    expect(cellValue(byLabel("Name"), row, plan)).toBe("Samuel Adeyemi");
  });

  it("carries ONE link for the whole name", () => {
    expect(cellLink(byLabel("Name"), row)).toBe("/clients/c1");
  });

  it("leaves the money column alone", () => {
    expect(cellValue(byLabel("Spend"), row, plan)).toBe("$356.41");
    expect(cellLink(byLabel("Spend"), row)).toBeNull();
    expect(byLabel("Spend").numeric).toBe(true);
  });

  it("does not merge a lone label into a generic 'Name'", () => {
    // `display_name as provider` is already a whole name; renaming its
    // heading to "Name" would lose which person it refers to.
    const r = { staff_id: "s1", provider: "Dana" };
    const p = planColumns(["staff_id", "provider"], [r]);
    expect(p.display.map((c) => c.label)).toEqual(["Provider"]);
    expect(cellLink(p.display[0]!, r)).toBe("/staff/s1");
  });

  it("keeps two people in one row separate", () => {
    const r = {
      client_id: "c1",
      first_name: "Sam",
      last_name: "Lee",
      staff_id: "s1",
      provider: "Dana",
    };
    const p = planColumns(
      ["client_id", "first_name", "last_name", "staff_id", "provider"],
      [r],
    );
    expect(p.display.map((c) => c.label)).toEqual(["Name", "Provider"]);
    expect(cellLink(p.display[0]!, r)).toBe("/clients/c1");
    expect(cellLink(p.display[1]!, r)).toBe("/staff/s1");
  });

  it("merges names even with no id to link to", () => {
    const r = { first_name: "Sam", last_name: "Lee" };
    const p = planColumns(["first_name", "last_name"], [r]);
    expect(p.display.map((c) => c.label)).toEqual(["Name"]);
    expect(cellValue(p.display[0]!, r, p)).toBe("Sam Lee");
    expect(cellLink(p.display[0]!, r)).toBeNull();
  });

  it("survives a missing name part", () => {
    const r = { client_id: "c1", first_name: "Cher", last_name: null };
    const p = planColumns(["client_id", "first_name", "last_name"], [r]);
    expect(cellValue(p.display[0]!, r, p)).toBe("Cher");
  });
});
