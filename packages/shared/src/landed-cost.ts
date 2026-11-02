import { d, Num, round2, sum, Decimal } from "./money";

export type AllocationMethod = "BY_VALUE" | "BY_QUANTITY" | "BY_WEIGHT";

export interface ReceiptLine {
  quantity: number;
  unitPriceAed: Num;
  unitWeightGrams?: number;
}

export interface LandedCostInput {
  amountAed: Num;
  method: AllocationMethod;
}

/**
 * Spread freight / duty / clearing / insurance over received lines.
 * Returns the landed cost per unit for each line. Rounding differences go to the
 * largest line, so the totals always match the amounts paid.
 */
export function allocateLandedCosts(lines: ReceiptLine[], costs: LandedCostInput[]): Decimal[] {
  const extraPerLine = lines.map(() => d(0));

  for (const cost of costs) {
    const weights = lines.map((l) => {
      if (cost.method === "BY_QUANTITY") return d(l.quantity);
      if (cost.method === "BY_WEIGHT") return d(l.quantity).times(l.unitWeightGrams ?? 0);
      return d(l.quantity).times(l.unitPriceAed);
    });
    const totalWeight = sum(weights);
    if (totalWeight.isZero()) throw new Error(`Cannot allocate ${cost.method}: total weight is zero`);

    const shares = weights.map((w) => round2(d(cost.amountAed).times(w).dividedBy(totalWeight)));
    const diff = d(cost.amountAed).minus(sum(shares));
    if (!diff.isZero()) {
      const largest = weights.reduce((best, w, i) => (w.greaterThan(weights[best]) ? i : best), 0);
      shares[largest] = shares[largest].plus(diff);
    }
    shares.forEach((s, i) => (extraPerLine[i] = extraPerLine[i].plus(s)));
  }

  return lines.map((l, i) =>
    l.quantity > 0 ? round2(d(l.unitPriceAed).plus(extraPerLine[i].dividedBy(l.quantity))) : d(l.unitPriceAed),
  );
}
