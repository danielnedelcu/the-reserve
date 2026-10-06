// @vitest-environment node
import { describe, it, expect } from "vitest";
import { LOW_STOCK_THRESHOLD, stockLevel } from "../../shared/products/stock";

// The one definition of "low stock": the badge and products_page's filter
// (whose SQL literal is a copy, held to this number by verify:tables).
describe("stockLevel", () => {
  it("zero is out", () => {
    expect(stockLevel(0)).toBe("out");
    expect(stockLevel(-1)).toBe("out");
  });
  it("one up to the threshold is low — the threshold itself included", () => {
    expect(stockLevel(1)).toBe("low");
    expect(stockLevel(LOW_STOCK_THRESHOLD)).toBe("low");
  });
  it("one above the threshold is ok", () => {
    expect(stockLevel(LOW_STOCK_THRESHOLD + 1)).toBe("ok");
    expect(stockLevel(500)).toBe("ok");
  });
});
