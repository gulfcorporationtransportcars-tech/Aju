import { Injectable } from "@nestjs/common";
import { Customer } from "@luxora/db";
import { calcDocument, Decimal, isBelowMinimum, resolveUnitPrice, UAE_VAT_STANDARD_RATE } from "@luxora/shared";
import { Tx } from "../common/prisma/prisma.service";

export interface LineRequest {
  variantId: string;
  quantity: number;
  unitPrice?: string; // omit to use the customer's price
  discountPct?: number;
}

export interface PricedLine {
  variantId: string;
  quantity: number;
  unitPrice: string;
  discountPct: string;
  vatRate: string;
  lineTotal: string; // net (excl. VAT)
  belowMinPrice: boolean;
  brandId: string;
  label: string;
}

/** Customers outside the UAE get zero-rated (export) prices. */
export const isExportCustomer = (c: Pick<Customer, "countryCode">) => (c.countryCode ?? "AE") !== "AE";

@Injectable()
export class PricingService {
  /**
   * Price order / quotation lines for a customer:
   * - their approved price list (with volume breaks), else their tier price (A/B/C);
   * - VAT 5% in the UAE, 0% for export customers;
   * - flags lines below the minimum selling price (needs the Manager's approval).
   */
  async priceLines(tx: Tx, customer: Customer, lines: LineRequest[], extraCharges: Decimal.Value = 0) {
    const variants = await tx.productVariant.findMany({
      where: { id: { in: lines.map((l) => l.variantId) } },
      include: { product: { select: { nameEn: true, brandId: true, brand: { select: { name: true } } } } },
    });
    const priceList =
      customer.priceListId != null
        ? await tx.priceList.findFirst({ where: { id: customer.priceListId, isApproved: true, isActive: true }, include: { items: true } })
        : null;
    const vatRate = isExportCustomer(customer) ? 0 : UAE_VAT_STANDARD_RATE;

    const priced = lines.map((l) => {
      const v = variants.find((x) => x.id === l.variantId);
      if (!v) throw new Error(`Unknown product variant ${l.variantId}`);
      const breaks = priceList?.items.filter((i) => i.variantId === v.id).map((i) => ({ minQty: i.minQty, price: i.price.toString() })) ?? [];
      const tier = customer.priceTier === "EXPORT" ? "C" : customer.priceTier;
      const unitPrice = l.unitPrice ?? resolveUnitPrice(
        { wholesaleAAed: v.wholesaleAAed.toString(), wholesaleBAed: v.wholesaleBAed.toString(), wholesaleCAed: v.wholesaleCAed.toString(), retailPriceAed: v.retailPriceAed.toString(), minSellingPriceAed: v.minSellingPriceAed.toString() },
        tier,
        l.quantity,
        breaks,
      ).toString();
      const discountPct = String(l.discountPct ?? 0);
      return {
        variantId: v.id,
        quantity: l.quantity,
        unitPrice,
        discountPct,
        vatRate: String(vatRate),
        belowMinPrice: isBelowMinimum(unitPrice, discountPct, v.minSellingPriceAed.toString()),
        brandId: v.product.brandId,
        label: `${v.product.brand.name} ${v.product.nameEn}${v.sizeMl ? ` ${v.sizeMl}ml` : ""}${v.packType === "TESTER" ? " (Tester)" : ""}`,
      };
    });

    const totals = calcDocument(priced, extraCharges);
    const pricedLines: PricedLine[] = priced.map((p, i) => ({ ...p, lineTotal: totals.lines[i].net.toString() }));
    return { lines: pricedLines, totals, vatRate };
  }
}
