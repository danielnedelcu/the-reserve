// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFUND_PREFIX } from "../../shared/ledger/refund";

// The refund route names a mirror line `${REFUND_PREFIX}<original>` and
// Ask's "top services" preset strips that prefix to net a refund against
// its service. Both must use the ONE constant: a literal on either side
// is how they would drift, so the literal is what this test forbids.

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("the refund-name prefix is one shared constant", () => {
  it("is what the ledger already holds", () => {
    expect(REFUND_PREFIX).toBe("Refund — "); // append-only: stored names are never renamed
  });
  it("the refund route writes the constant, never a literal", () => {
    const route = read("server/api/transactions/[id]/refund.post.ts");
    expect(route).toContain("${REFUND_PREFIX}${item.name_snapshot}");
    expect(route).not.toContain("Refund — ");
  });
  it("the top-services preset strips the constant, never a literal", async () => {
    const source = read("server/utils/askPresets.ts");
    expect(source).toContain("'^${REFUND_PREFIX}'");
    expect(source.replace(/\/\/.*$/gm, "")).not.toContain("Refund — "); // comments aside, no literal
    const { PRESET_SQL } = await import("../../server/utils/askPresets");
    expect(PRESET_SQL["financials.top_services_quarter"]).toContain(`'^${REFUND_PREFIX}'`);
  });
});
