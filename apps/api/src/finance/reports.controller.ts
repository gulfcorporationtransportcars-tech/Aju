import { Controller, Get, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { d, Decimal, marginPct, PERMISSIONS, round2 } from "@luxora/shared";
import { z } from "zod";
import { RequirePermissions } from "../common/auth/decorators";
import { zod } from "../common/http/zod.pipe";
import { PrismaService } from "../common/prisma/prisma.service";
import { invoiceBalance } from "../sales/crm.controller";

const AsOf = z.object({ asOf: z.coerce.date().default(() => new Date()) });
const Range = z.object({ from: z.coerce.date(), to: z.coerce.date() });
const endOfDay = (x: Date) => new Date(x.getTime() + 86_400_000 - 1);

interface BalanceRow {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

const money = (v: Decimal.Value) => round2(v).toFixed(2);

@Controller("finance/reports")
@RequirePermissions(PERMISSIONS.REPORT_FINANCE)
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  private balances(from: Date | null, to: Date) {
    return this.prisma.$queryRaw<BalanceRow[]>`
      SELECT a.code, a.name, a.type::text AS type,
             COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
      FROM "Account" a
      JOIN "JournalLine" l ON l."accountId" = a.id
      JOIN "JournalEntry" e ON e.id = l."journalEntryId"
      WHERE e.date <= ${to} AND (${from}::timestamp IS NULL OR e.date >= ${from}::timestamp)
      GROUP BY a.code, a.name, a.type
      ORDER BY a.code`;
  }

  @Get("trial-balance")
  async trialBalance(@Query(zod(AsOf)) q: { asOf: Date }) {
    const rows = await this.balances(null, endOfDay(q.asOf));
    const lines = rows.map((r) => {
      const net = d(r.debit.toString()).minus(r.credit.toString());
      return { code: r.code, name: r.name, type: r.type, debit: money(net.greaterThan(0) ? net : 0), credit: money(net.lessThan(0) ? net.negated() : 0) };
    });
    const totalDebit = lines.reduce((s, l) => s.plus(l.debit), d(0));
    const totalCredit = lines.reduce((s, l) => s.plus(l.credit), d(0));
    return { asOf: q.asOf, lines, totalDebit: money(totalDebit), totalCredit: money(totalCredit), balanced: totalDebit.equals(totalCredit) };
  }

  @Get("profit-loss")
  async profitLoss(@Query(zod(Range)) q: { from: Date; to: Date }) {
    const rows = await this.balances(q.from, endOfDay(q.to));
    const income = rows.filter((r) => r.type === "INCOME").map((r) => ({ code: r.code, name: r.name, amount: d(r.credit.toString()).minus(r.debit.toString()) }));
    const expense = rows.filter((r) => r.type === "EXPENSE").map((r) => ({ code: r.code, name: r.name, amount: d(r.debit.toString()).minus(r.credit.toString()) }));
    const total = (xs: { amount: Decimal }[]) => xs.reduce((s, x) => s.plus(x.amount), d(0));
    const salesRevenue = total(income.filter((i) => i.code.startsWith("40") || i.code === "4900"));
    const cogs = total(expense.filter((e) => e.code.startsWith("5")));
    const totalIncome = total(income);
    const totalExpense = total(expense);
    const fmt = (xs: { code: string; name: string; amount: Decimal }[]) => xs.map((x) => ({ ...x, amount: money(x.amount) }));
    return {
      period: q,
      income: fmt(income),
      expenses: fmt(expense),
      totalIncome: money(totalIncome),
      costOfSales: money(cogs),
      grossProfitOnGoods: money(salesRevenue.minus(cogs)),
      totalExpenses: money(totalExpense),
      netProfit: money(totalIncome.minus(totalExpense)),
    };
  }

  @Get("balance-sheet")
  async balanceSheet(@Query(zod(AsOf)) q: { asOf: Date }) {
    const rows = await this.balances(null, endOfDay(q.asOf));
    const side = (type: BalanceRow["type"], sign: 1 | -1) =>
      rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: d(r.debit.toString()).minus(r.credit.toString()).times(sign) }));
    const assets = side("ASSET", 1);
    const liabilities = side("LIABILITY", -1);
    const equity = side("EQUITY", -1);
    const earnings = rows.reduce((s, r) => (r.type === "INCOME" ? s.plus(r.credit.toString()).minus(r.debit.toString()) : r.type === "EXPENSE" ? s.minus(r.debit.toString()).plus(r.credit.toString()) : s), d(0));
    const total = (xs: { amount: Decimal }[]) => xs.reduce((s, x) => s.plus(x.amount), d(0));
    const totalAssets = total(assets);
    const totalLiabEq = total(liabilities).plus(total(equity)).plus(earnings);
    const fmt = (xs: { code: string; name: string; amount: Decimal }[]) => xs.map((x) => ({ ...x, amount: money(x.amount) }));
    return {
      asOf: q.asOf,
      assets: fmt(assets),
      liabilities: fmt(liabilities),
      equity: [...fmt(equity), { code: "—", name: "Current earnings (not yet closed)", amount: money(earnings) }],
      totalAssets: money(totalAssets),
      totalLiabilitiesAndEquity: money(totalLiabEq),
      balanced: round2(totalAssets).equals(round2(totalLiabEq)),
    };
  }

  /** Who owes LUXORA, by how late: current, 1–30, 31–60, 61–90, 90+ days. */
  @Get("aged-receivables")
  async agedReceivables(@Query(zod(AsOf)) q: { asOf: Date }) {
    const open = await this.prisma.invoice.findMany({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] }, issueDate: { lte: endOfDay(q.asOf) } },
      include: { customer: { select: { id: true, code: true, companyName: true } }, adClient: { select: { id: true, code: true, companyName: true } } },
    });
    return this.age(
      open.map((i) => ({ party: i.customer ?? i.adClient, dueDate: i.dueDate ?? i.issueDate, balanceAed: invoiceBalance(i).times(i.exchangeRate.toString()), number: i.number })),
      q.asOf,
    );
  }

  @Get("aged-payables")
  async agedPayables(@Query(zod(AsOf)) q: { asOf: Date }) {
    const open = await this.prisma.supplierBill.findMany({ where: { status: { in: ["UNPAID", "PARTIALLY_PAID"] }, billDate: { lte: endOfDay(q.asOf) } }, include: { supplier: { select: { id: true, code: true, name: true } } } });
    return this.age(
      open.map((b) => ({ party: { id: b.supplier.id, code: b.supplier.code, companyName: b.supplier.name }, dueDate: b.dueDate ?? b.billDate, balanceAed: d(b.total.toString()).minus(b.amountPaid.toString()).times(b.exchangeRate.toString()), number: b.number })),
      q.asOf,
    );
  }

  private age(items: { party: { id: string; code: string; companyName: string } | null; dueDate: Date; balanceAed: Decimal; number: string }[], asOf: Date) {
    const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
    const bucketOf = (due: Date) => {
      const late = Math.floor((asOf.getTime() - due.getTime()) / 86_400_000);
      return late <= 0 ? "current" : late <= 30 ? "1-30" : late <= 60 ? "31-60" : late <= 90 ? "61-90" : "90+";
    };
    const byParty = new Map<string, { party: { id: string; code: string; companyName: string }; buckets: Record<string, Decimal>; documents: string[] }>();
    for (const it of items) {
      if (!it.party || it.balanceAed.lessThanOrEqualTo(0)) continue;
      const row = byParty.get(it.party.id) ?? { party: it.party, buckets: Object.fromEntries(buckets.map((b) => [b, d(0)])), documents: [] };
      const b = bucketOf(it.dueDate);
      row.buckets[b] = row.buckets[b].plus(it.balanceAed);
      row.documents.push(it.number);
      byParty.set(it.party.id, row);
    }
    const rows = [...byParty.values()].map((r) => {
      const total = Object.values(r.buckets).reduce((s, v) => s.plus(v), d(0));
      return { ...r.party, ...Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, money(v)])), total: money(total), documents: r.documents };
    });
    rows.sort((a, b) => Number(b.total) - Number(a.total));
    const totals = Object.fromEntries(buckets.map((b) => [b, money(rows.reduce((s, r) => s.plus((r as unknown as Record<string, string>)[b]), d(0)))]));
    return { asOf, rows, totals, grandTotal: money(rows.reduce((s, r) => s.plus(r.total), d(0))) };
  }

  /** Revenue, cost and margin by brand from invoiced orders. */
  @Get("profit-by-brand")
  async profitByBrand(@Query(zod(Range)) q: { from: Date; to: Date }) {
    const invoices = await this.prisma.invoice.findMany({
      where: { status: { notIn: ["VOID", "DRAFT"] }, issueDate: { gte: q.from, lte: endOfDay(q.to) }, salesOrderId: { not: null } },
      include: { salesOrder: { include: { lines: { include: { variant: { include: { product: { include: { brand: true } } } } } } } } },
    });
    const byBrand = new Map<string, { brand: string; units: number; revenue: Decimal; cost: Decimal }>();
    for (const inv of invoices) {
      const rate = inv.exchangeRate.toString();
      for (const l of inv.salesOrder!.lines) {
        const brand = l.variant.product.brand;
        const row = byBrand.get(brand.id) ?? { brand: brand.name, units: 0, revenue: d(0), cost: d(0) };
        row.units += l.quantity;
        row.revenue = row.revenue.plus(d(l.lineTotal.toString()).times(rate));
        row.cost = row.cost.plus(d(l.unitCostAed.toString()).times(l.quantity));
        byBrand.set(brand.id, row);
      }
    }
    const rows = [...byBrand.values()]
      .map((r) => ({ brand: r.brand, units: r.units, revenueAed: money(r.revenue), costAed: money(r.cost), grossProfitAed: money(r.revenue.minus(r.cost)), marginPct: marginPct(r.revenue, r.cost).toFixed(2) }))
      .sort((a, b) => Number(b.grossProfitAed) - Number(a.grossProfitAed));
    return { period: q, rows };
  }

  /** Sales by channel and by customer type. */
  @Get("sales-summary")
  async salesSummary(@Query(zod(Range)) q: { from: Date; to: Date }) {
    const invoices = await this.prisma.invoice.findMany({
      where: { status: { notIn: ["VOID", "DRAFT"] }, issueDate: { gte: q.from, lte: endOfDay(q.to) } },
      include: { customer: { select: { type: true, countryCode: true } }, salesOrder: { select: { channel: true } } },
    });
    const group = (key: (i: (typeof invoices)[number]) => string) => {
      const m = new Map<string, { count: number; netAed: Decimal; vatAed: Decimal }>();
      for (const i of invoices) {
        const k = key(i);
        const row = m.get(k) ?? { count: 0, netAed: d(0), vatAed: d(0) };
        row.count += 1;
        row.netAed = row.netAed.plus(d(i.totalAed.toString()).minus(i.vatAmountAed.toString()));
        row.vatAed = row.vatAed.plus(i.vatAmountAed.toString());
        m.set(k, row);
      }
      return [...m.entries()].map(([k, v]) => ({ key: k, count: v.count, netAed: money(v.netAed), vatAed: money(v.vatAed) }));
    };
    return {
      period: q,
      byChannel: group((i) => i.salesOrder?.channel ?? (i.type === "AGENCY_INVOICE" ? "AGENCY" : "OTHER")),
      byCustomerType: group((i) => i.customer?.type ?? "AD_CLIENT"),
      byCountry: group((i) => i.customer?.countryCode ?? "AE"),
    };
  }
}
