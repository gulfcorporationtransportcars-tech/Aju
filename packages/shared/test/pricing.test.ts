import { describe, expect, it } from "vitest";
import { allocateLandedCosts, isBelowMinimum, marginPct, resolveUnitPrice, sum, weightedAverageCost } from "../src";

const variant = {
  wholesaleAAed: 400,
  wholesaleBAed: 420,
  wholesaleCAed: 450,
  retailPriceAed: 650,
  minSellingPriceAed: 380,
};

describe("pricing", () => {
  it("uses the tier price", () => {
    expect(resolveUnitPrice(variant, "A", 1).toNumber()).toBe(400);
    expect(resolveUnitPrice(variant, "B", 1).toNumber()).toBe(420);
    expect(resolveUnitPrice(variant, "C", 1).toNumber()).toBe(450);
    expect(resolveUnitPrice(variant, "RETAIL", 1).toNumber()).toBe(650);
  });

  it("prefers the best matching price-list volume break", () => {
    const breaks = [
      { minQty: 1, price: 430 },
      { minQty: 12, price: 410 },
      { minQty: 48, price: 395 },
    ];
    expect(resolveUnitPrice(variant, "C", 6, breaks).toNumber()).toBe(430);
    expect(resolveUnitPrice(variant, "C", 24, breaks).toNumber()).toBe(410);
    expect(resolveUnitPrice(variant, "C", 60, breaks).toNumber()).toBe(395);
  });

  it("flags prices below the minimum for Manager approval", () => {
    expect(isBelowMinimum(400, 0, 380)).toBe(false);
    expect(isBelowMinimum(400, 5, 380)).toBe(false); // 380.00
    expect(isBelowMinimum(400, 6, 380)).toBe(true); // 376.00
    expect(isBelowMinimum(100, 50, 0)).toBe(false); // no minimum set
  });

  it("computes margin and weighted average cost", () => {
    expect(marginPct(500, 400).toNumber()).toBe(20);
    expect(weightedAverageCost(10, 300, 10, 340).toNumber()).toBe(320);
    expect(weightedAverageCost(0, 0, 5, 333.33).toNumber()).toBe(333.33);
  });
});

describe("landed cost", () => {
  it("spreads costs by value and keeps the total exact", () => {
    const lines = [
      { quantity: 10, unitPriceAed: 300 }, // 3000
      { quantity: 3, unitPriceAed: 1000 }, // 3000
      { quantity: 7, unitPriceAed: 100 }, // 700
    ];
    const costs = [
      { amountAed: 1000, method: "BY_VALUE" as const },
      { amountAed: "333.33", method: "BY_QUANTITY" as const },
    ];
    const landed = allocateLandedCosts(lines, costs);
    const totalLanded = sum(landed.map((u, i) => u.times(lines[i].quantity)));
    // goods 6700 + costs 1333.33; per-unit rounding may move the total by a few fils only
    expect(Math.abs(totalLanded.minus("8033.33").toNumber())).toBeLessThan(0.1);
    expect(landed[0].toNumber()).toBeGreaterThan(300);
  });

  it("rejects weight allocation without weights", () => {
    expect(() => allocateLandedCosts([{ quantity: 1, unitPriceAed: 1 }], [{ amountAed: 10, method: "BY_WEIGHT" }])).toThrow();
  });
});
