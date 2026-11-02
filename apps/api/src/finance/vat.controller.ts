import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { d, Decimal, PERMISSIONS, round2, toAed } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../common/auth/decorators";
import { zod } from "../common/http/zod.pipe";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditService } from "../core/audit/audit.service";

const EMIRATE_BOX: Record<string, string> = {
  "Abu Dhabi": "1a",
  Dubai: "1b",
  Sharjah: "1c",
  Ajman: "1d",
  "Umm Al Quwain": "1e",
  "Ras Al Khaimah": "1f",
  Fujairah: "1g",
};
const DEFAULT_EMIRATE = "Dubai"; // LUXORA's business address (Deira) when the customer's emirate is unknown

const Period = z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((p) => p.to >= p.from, { message: "'to' must be after 'from'" });
type Period = z.infer<typeof Period>;

interface Box {
  amount: Decimal;
  vat: Decimal;
}
const box = (): Box => ({ amount: d(0), vat: d(0) });
const out = (b: Box) => ({ amountAed: round2(b.amount).toFixed(2), vatAed: round2(b.vat).toFixed(2) });

/**
 * UAE VAT return (FTA form VAT201), calculated from issued invoices, credit notes,
 * goods imported, supplier bills and expenses. Always check against the FTA portal and
 * customs declarations before filing.
 */
@Controller("finance/vat")
@RequirePermissions(PERMISSIONS.VAT_MANAGE)
export class VatController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get("report")
  report(@Query(zod(Period)) p: Period) {
    return this.calculate(p);
  }

  @Get("returns")
  returns() {
    return this.prisma.vatReturn.findMany({ orderBy: { periodStart: "desc" } });
  }

  /** Save the calculated return for the period (locks the figures). */
  @Post("returns")
  async save(@CurrentUser() me: AuthUser, @Body(zod(Period)) p: Period) {
    const r = await this.calculate(p);
    const saved = await this.prisma.vatReturn.create({
      data: {
        periodStart: p.from,
        periodEnd: p.to,
        standardRatedSales: r.box8.amountAed,
        outputVat: r.box12_totalDueTaxAed,
        zeroRatedSales: r.boxes["4"].amountAed,
        exemptSales: r.boxes["5"].amountAed,
        standardRatedExpenses: r.boxes["9"].amountAed,
        inputVat: r.box13_totalRecoverableTaxAed,
        netVatDue: r.box14_payableTaxAed,
        breakdown: r as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({ userId: me.id, action: "CREATE", entityType: "VatReturn", entityId: saved.id, after: saved });
    return saved;
  }

  @Post("returns/:id/filed")
  @HttpCode(200)
  async filed(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(z.object({ ftaReference: z.string().min(3) }))) body: { ftaReference: string }) {
    const r = await this.prisma.vatReturn.findUniqueOrThrow({ where: { id } });
    if (r.status !== "DRAFT") throw new BadRequestException("Already filed");
    const updated = await this.prisma.vatReturn.update({ where: { id }, data: { status: "FILED", filedAt: new Date(), ftaReference: body.ftaReference } });
    await this.audit.log({ userId: me.id, action: "FILE", entityType: "VatReturn", entityId: id, after: updated });
    return updated;
  }

  async calculate(p: Period) {
    const to = new Date(p.to.getTime() + 86_400_000 - 1); // include the whole last day
    const boxes: Record<string, Box> = Object.fromEntries(["1a", "1b", "1c", "1d", "1e", "1f", "1g", "4", "5", "6", "9", "10"].map((k) => [k, box()]));
    const emirateBox = (snapshot: unknown) => {
      const emirate = (snapshot as { emirate?: string } | null)?.emirate ?? DEFAULT_EMIRATE;
      return EMIRATE_BOX[emirate] ?? EMIRATE_BOX[DEFAULT_EMIRATE];
    };

    // Sales (output VAT)
    const invoices = await this.prisma.invoice.findMany({ where: { status: { notIn: ["VOID", "DRAFT"] }, issueDate: { gte: p.from, lte: to } }, include: { lines: true } });
    for (const inv of invoices) {
      const rate = inv.exchangeRate.toString();
      for (const l of inv.lines) {
        const key = l.vatCategory === "STANDARD" ? emirateBox(inv.billToSnapshot) : l.vatCategory === "ZERO_RATED" ? "4" : l.vatCategory === "EXEMPT" ? "5" : null;
        if (!key) continue;
        boxes[key].amount = boxes[key].amount.plus(toAed(l.lineTotal.toString(), rate));
        boxes[key].vat = boxes[key].vat.plus(toAed(l.vatAmount.toString(), rate));
      }
    }
    // Credit notes reduce the box of the original supply
    const credits = await this.prisma.creditNote.findMany({ where: { status: { in: ["ISSUED", "APPLIED"] }, issueDate: { gte: p.from, lte: to } }, include: { invoice: true } });
    for (const cn of credits) {
      const rate = cn.invoice.exchangeRate.toString();
      const key = cn.invoice.type === "EXPORT_INVOICE" ? "4" : emirateBox(cn.invoice.billToSnapshot);
      boxes[key].amount = boxes[key].amount.minus(toAed(cn.subtotal.toString(), rate));
      boxes[key].vat = boxes[key].vat.minus(toAed(cn.vatAmount.toString(), rate));
    }

    // Goods imported into the UAE (reverse charge: output in box 6, recoverable in box 10).
    // Customs value = goods + freight + insurance + customs duty.
    const imports = await this.prisma.goodsReceipt.findMany({
      where: { receivedOn: { gte: p.from, lte: to }, supplier: { countryCode: { not: "AE" } } },
      include: { lines: true, landedCosts: true },
    });
    for (const g of imports) {
      const goods = g.lines.reduce((s, l) => s.plus(d(l.unitPriceAed.toString()).times(l.quantity)), d(0));
      const extra = g.landedCosts.filter((c) => ["FREIGHT", "INSURANCE", "CUSTOMS_DUTY"].includes(c.type)).reduce((s, c) => s.plus(c.amountAed.toString()), d(0));
      const value = goods.plus(extra);
      const vat = round2(value.times(5).dividedBy(100));
      for (const k of ["6", "10"]) {
        boxes[k].amount = boxes[k].amount.plus(value);
        boxes[k].vat = boxes[k].vat.plus(vat);
      }
    }

    // Purchases & expenses with UAE VAT (input VAT)
    const bills = await this.prisma.supplierBill.findMany({ where: { status: { not: "CANCELLED" }, billDate: { gte: p.from, lte: to }, vatAmount: { gt: 0 } } });
    for (const b of bills) {
      const rate = b.exchangeRate.toString();
      boxes["9"].amount = boxes["9"].amount.plus(toAed(b.subtotal.toString(), rate));
      boxes["9"].vat = boxes["9"].vat.plus(toAed(b.vatAmount.toString(), rate));
    }
    const expenses = await this.prisma.expense.findMany({ where: { date: { gte: p.from, lte: to }, vatAmount: { gt: 0 } } });
    for (const e of expenses) {
      boxes["9"].amount = boxes["9"].amount.plus(e.amount.toString());
      boxes["9"].vat = boxes["9"].vat.plus(e.vatAmount.toString());
    }

    const sumBoxes = (keys: string[]) => keys.reduce((acc, k) => ({ amount: acc.amount.plus(boxes[k].amount), vat: acc.vat.plus(boxes[k].vat) }), box());
    const box8 = sumBoxes(["1a", "1b", "1c", "1d", "1e", "1f", "1g", "4", "5", "6"]);
    const box11 = sumBoxes(["9", "10"]);
    const payable = round2(box8.vat.minus(box11.vat));
    return {
      period: { from: p.from.toISOString().slice(0, 10), to: p.to.toISOString().slice(0, 10) },
      boxes: Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, out(b)])),
      box8: out(box8),
      box11: out(box11),
      box12_totalDueTaxAed: round2(box8.vat).toFixed(2),
      box13_totalRecoverableTaxAed: round2(box11.vat).toFixed(2),
      box14_payableTaxAed: payable.toFixed(2),
      result: payable.isNegative() ? "REFUNDABLE" : "PAYABLE",
      counts: { invoices: invoices.length, creditNotes: credits.length, imports: imports.length, bills: bills.length, expenses: expenses.length },
      note: "Calculated from LUXORA Hub records. Check against the FTA portal and customs declarations before filing.",
    };
  }
}
