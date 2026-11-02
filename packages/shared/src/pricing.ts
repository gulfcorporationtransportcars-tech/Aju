import { d, Num, round2, Decimal } from "./money";

export type PriceTier = "A" | "B" | "C" | "EXPORT" | "RETAIL" | "CUSTOM";

export interface VariantPrices {
  wholesaleAAed: Num;
  wholesaleBAed: Num;
  wholesaleCAed: Num;
  retailPriceAed: Num;
  minSellingPriceAed: Num;
}

export interface PriceBreak {
  minQty: number;
  price: Num;
}

/**
 * Price for a customer:
 * 1. their price list (best matching volume break), else
 * 2. the variant's tier price.
 */
export function resolveUnitPrice(
  variant: VariantPrices,
  tier: PriceTier,
  quantity: number,
  priceListBreaks: PriceBreak[] = [],
): Decimal {
  const applicable = priceListBreaks
    .filter((b) => quantity >= b.minQty)
    .sort((a, b) => b.minQty - a.minQty)[0];
  if (applicable) return d(applicable.price);
  switch (tier) {
    case "A":
      return d(variant.wholesaleAAed);
    case "B":
      return d(variant.wholesaleBAed);
    case "RETAIL":
      return d(variant.retailPriceAed);
    default:
      return d(variant.wholesaleCAed);
  }
}

/** Effective unit price after a line discount. */
export const effectiveUnitPrice = (unitPrice: Num, discountPct: Num = 0): Decimal =>
  round2(d(unitPrice).times(d(100).minus(discountPct)).dividedBy(100));

/** True when the sale needs DISCOUNT_BELOW_MIN approval from the Manager. */
export const isBelowMinimum = (unitPrice: Num, discountPct: Num, minSellingPrice: Num): boolean =>
  d(minSellingPrice).greaterThan(0) && effectiveUnitPrice(unitPrice, discountPct).lessThan(minSellingPrice);

/** Gross margin % on a sale. */
export function marginPct(sellNet: Num, cost: Num): Decimal {
  const sell = d(sellNet);
  if (sell.isZero()) return d(0);
  return round2(sell.minus(cost).dividedBy(sell).times(100));
}

/** New weighted-average cost after receiving stock. */
export function weightedAverageCost(onHandQty: number, currentCost: Num, receivedQty: number, receivedCost: Num): Decimal {
  const totalQty = onHandQty + receivedQty;
  if (totalQty <= 0) return round2(receivedCost);
  return round2(d(currentCost).times(onHandQty).plus(d(receivedCost).times(receivedQty)).dividedBy(totalQty));
}
