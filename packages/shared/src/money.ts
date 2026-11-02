import Decimal from "decimal.js";

// Money maths uses decimal.js: never JavaScript floats.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Num = Decimal.Value;

export const d = (v: Num): Decimal => new Decimal(v);

/** Round to 2 decimals (fils), half-up. */
export const round2 = (v: Num): Decimal => d(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const sum = (values: Num[]): Decimal => values.reduce<Decimal>((acc, v) => acc.plus(v), d(0));

/** Convert a document-currency amount to AED with the document's exchange rate. */
export const toAed = (amount: Num, rateToAed: Num): Decimal => round2(d(amount).times(rateToAed));

export { Decimal };
