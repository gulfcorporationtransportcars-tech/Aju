import { d, Num, round2, sum, Decimal } from "./money";

/** UAE standard VAT rate (%). */
export const UAE_VAT_STANDARD_RATE = 5;

export type VatCategory = "STANDARD" | "ZERO_RATED" | "EXEMPT" | "OUT_OF_SCOPE";

export const vatRateFor = (category: VatCategory): number =>
  category === "STANDARD" ? UAE_VAT_STANDARD_RATE : 0;

export interface LineInput {
  quantity: Num;
  unitPrice: Num; // excluding VAT
  discountPct?: Num;
  vatRate?: Num; // % (default 5)
}

export interface LineResult {
  gross: Decimal; // qty × price, before discount
  discount: Decimal;
  net: Decimal; // taxable amount
  vat: Decimal;
  total: Decimal; // net + vat
}

/** One document line. VAT is rounded per line, as shown on the invoice. */
export function calcLine(line: LineInput): LineResult {
  const gross = round2(d(line.quantity).times(line.unitPrice));
  const discount = round2(gross.times(d(line.discountPct ?? 0)).dividedBy(100));
  const net = gross.minus(discount);
  const vat = round2(net.times(d(line.vatRate ?? UAE_VAT_STANDARD_RATE)).dividedBy(100));
  return { gross, discount, net, vat, total: net.plus(vat) };
}

export interface DocumentTotals {
  subtotal: Decimal; // sum of gross
  discount: Decimal; // line discounts
  net: Decimal;
  vat: Decimal;
  total: Decimal;
  lines: LineResult[];
}

/** Totals for a quotation / order / invoice. */
export function calcDocument(lines: LineInput[], extraNetCharges: Num = 0): DocumentTotals {
  const results = lines.map(calcLine);
  // Charges such as delivery fees are standard-rated in the UAE.
  const charge = round2(extraNetCharges);
  const chargeVat = round2(charge.times(UAE_VAT_STANDARD_RATE).dividedBy(100));
  const subtotal = sum(results.map((r) => r.gross));
  const discount = sum(results.map((r) => r.discount));
  const net = sum(results.map((r) => r.net)).plus(charge);
  const vat = sum(results.map((r) => r.vat)).plus(chargeVat);
  return { subtotal, discount, net, vat, total: net.plus(vat), lines: results };
}

/** Split a VAT-inclusive retail price into net + VAT. */
export function splitInclusive(grossInclusive: Num, vatRate: Num = UAE_VAT_STANDARD_RATE) {
  const gross = d(grossInclusive);
  const net = round2(gross.times(100).dividedBy(d(100).plus(vatRate)));
  return { net, vat: gross.minus(net), gross };
}

/** A UAE TRN is 15 digits and starts with 100. */
export const isValidTrn = (trn: string): boolean => /^100\d{12}$/.test(trn.replace(/\s|-/g, ""));
