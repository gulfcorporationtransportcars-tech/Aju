import { describe, expect, it } from "vitest";
import { calcDocument, calcLine, isValidTrn, splitInclusive, toAed } from "../src";

describe("UAE VAT", () => {
  it("adds 5% VAT to a line", () => {
    const r = calcLine({ quantity: 12, unitPrice: "385.00" });
    expect(r.net.toFixed(2)).toBe("4620.00");
    expect(r.vat.toFixed(2)).toBe("231.00");
    expect(r.total.toFixed(2)).toBe("4851.00");
  });

  it("applies the discount before VAT", () => {
    const r = calcLine({ quantity: 3, unitPrice: "333.33", discountPct: 10 });
    expect(r.gross.toFixed(2)).toBe("999.99");
    expect(r.discount.toFixed(2)).toBe("100.00");
    expect(r.net.toFixed(2)).toBe("899.99");
    expect(r.vat.toFixed(2)).toBe("45.00");
  });

  it("zero-rates exports", () => {
    expect(calcLine({ quantity: 10, unitPrice: 100, vatRate: 0 }).vat.toFixed(2)).toBe("0.00");
  });

  it("totals a document including a delivery fee", () => {
    const t = calcDocument([{ quantity: 2, unitPrice: 100 }, { quantity: 1, unitPrice: "49.99" }], 25);
    expect(t.net.toFixed(2)).toBe("274.99");
    expect(t.vat.toFixed(2)).toBe("13.75"); // 10.00 + 2.50 + 1.25
    expect(t.total.toFixed(2)).toBe("288.74");
  });

  it("splits a VAT-inclusive retail price", () => {
    const s = splitInclusive("1050.00");
    expect(s.net.toFixed(2)).toBe("1000.00");
    expect(s.vat.toFixed(2)).toBe("50.00");
  });

  it("converts to AED", () => {
    expect(toAed("1000", "3.6725").toFixed(2)).toBe("3672.50");
  });

  it("validates TRN format", () => {
    expect(isValidTrn("100123456789012")).toBe(true);
    expect(isValidTrn("100-1234-5678-9012")).toBe(true);
    expect(isValidTrn("200123456789012")).toBe(false);
    expect(isValidTrn("10012345")).toBe(false);
  });
});
