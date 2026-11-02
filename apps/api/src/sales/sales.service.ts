import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Customer, Prisma, SalesOrder, SalesOrderLine } from "@luxora/db";
import { BatchPick, d, hasPermission, round2, sum, toAed } from "@luxora/shared";
import { AuthUser } from "../common/auth/auth-user";
import { PrismaService, Tx } from "../common/prisma/prisma.service";
import { ApprovalsService } from "../core/approvals/approvals.service";
import { AuditService } from "../core/audit/audit.service";
import { NumberingService } from "../core/numbering/numbering.service";
import { ACC } from "../finance/ledger/accounts";
import { LedgerService, PostingLine } from "../finance/ledger/ledger.service";
import { StockService } from "../trading/inventory/stock.service";
import { customerExposureAed } from "./crm.controller";
import { isExportCustomer, LineRequest, PricingService } from "./pricing.service";

type OrderWithLines = SalesOrder & { lines: SalesOrderLine[]; customer: Customer | null };

const picksOf = (line: SalesOrderLine): BatchPick[] => (line.reservedPicks as unknown as BatchPick[] | null) ?? [];

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  // ---------- Orders ----------
  async createOrder(
    tx: Tx,
    me: AuthUser,
    input: { customerId: string; lines: LineRequest[]; warehouseId?: string; requiredBy?: Date; notes?: string; shippingFee?: string; quotationId?: string; channel?: "WHOLESALE" | "B2B_PORTAL" | "EXPORT"; campaignId?: string },
  ) {
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
    if (customer.status === "BLOCKED") throw new ConflictException(`${customer.companyName} is blocked`);
    const shipping = input.shippingFee ?? "0";
    const priced = await this.pricing.priceLines(tx, customer, input.lines, shipping);
    const exchangeRate = "1"; // wholesale is priced in AED
    const order = await tx.salesOrder.create({
      data: {
        number: await this.numbering.next("SO", tx),
        channel: input.channel ?? (isExportCustomer(customer) ? "EXPORT" : "WHOLESALE"),
        customerId: customer.id,
        quotationId: input.quotationId,
        warehouseId: input.warehouseId,
        salespersonId: customer.salespersonId ?? (me.roleKey === "SALES" ? me.id : null),
        requiredBy: input.requiredBy,
        notes: input.notes,
        campaignId: input.campaignId,
        currencyCode: "AED",
        exchangeRate,
        subtotal: priced.totals.subtotal.toString(),
        discount: priced.totals.discount.toString(),
        shippingFee: shipping,
        vatAmount: priced.totals.vat.toString(),
        total: priced.totals.total.toString(),
        totalAed: toAed(priced.totals.total, exchangeRate).toString(),
        shippingAddress: { companyName: customer.companyName, address: customer.address, city: customer.city, emirate: customer.emirate, countryCode: customer.countryCode },
        createdById: me.id,
        lines: {
          create: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, vatRate: l.vatRate, lineTotal: l.lineTotal, belowMinPrice: l.belowMinPrice })),
        },
      },
      include: { lines: true },
    });
    await this.audit.log({ userId: me.id, action: "CREATE", entityType: "SalesOrder", entityId: order.id, after: order }, tx);
    return order;
  }

  /**
   * Confirm an order:
   * 1. a price below the minimum (not already approved on the quotation) → Manager approval first;
   * 2. credit check for credit customers (outstanding + this order ≤ credit limit), Manager can override;
   * 3. reserve stock FEFO for every line.
   */
  async confirm(me: AuthUser, orderId: string, overrideCredit = false) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true, customer: true } });
      if (order.status !== "DRAFT") throw new BadRequestException(`Order is ${order.status}`);

      if (!order.quotationId && order.lines.some((l) => l.belowMinPrice)) {
        await tx.salesOrder.update({ where: { id: orderId }, data: { status: "PENDING_APPROVAL" } });
        const approval = await this.approvals.request(
          {
            type: "DISCOUNT_BELOW_MIN",
            entityType: "SalesOrder",
            entityId: orderId,
            title: `${order.number} for ${order.customer?.companyName}: ${order.lines.filter((l) => l.belowMinPrice).length} line(s) below minimum price`,
            details: { lines: order.lines.filter((l) => l.belowMinPrice).map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct })) },
            amountAed: Number(order.totalAed),
            requestedById: me.id,
          },
          tx,
        );
        // Approved straight away if the Manager raised the order himself
        if (approval.status !== "APPROVED") return { status: "PENDING_APPROVAL", order: await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId } }), approval };
        return { status: "CONFIRMED", order: await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } }), approval };
      }

      await this.reserveAndConfirm(tx, order, me, overrideCredit);
      return { status: "CONFIRMED", order: await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } }) };
    });
  }

  /** Also used by the DISCOUNT_BELOW_MIN approval handler. */
  async reserveAndConfirm(tx: Tx, order: OrderWithLines, me: AuthUser | null, overrideCredit = false) {
    const c = order.customer;
    if (c) {
      if (c.status === "ON_HOLD" || c.status === "BLOCKED") throw new ConflictException(`${c.companyName} is ${c.status.replace("_", " ").toLowerCase()}`);
      if (c.paymentTermsDays > 0) {
        const { exposure } = await customerExposureAed(tx, c.id, order.id);
        const after = exposure.plus(order.totalAed.toString());
        const canOverride = overrideCredit && me != null && hasPermission(me.permissions, "*");
        if (after.greaterThan(c.creditLimitAed.toString()) && !canOverride) {
          throw new ConflictException({
            statusCode: 409,
            message: `Credit limit exceeded for ${c.companyName}`,
            creditLimitAed: c.creditLimitAed.toString(),
            currentExposureAed: exposure.toFixed(2),
            orderAed: order.totalAed.toString(),
          });
        }
      }
    }
    for (const line of order.lines) {
      const picks = await this.stock.reserve(tx, line.variantId, line.quantity, order.warehouseId ?? undefined);
      await tx.salesOrderLine.update({ where: { id: line.id }, data: { reservedPicks: picks as unknown as Prisma.InputJsonValue } });
    }
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
  }

  async cancel(me: AuthUser, orderId: string, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
      if (!["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "PICKING", "PACKED"].includes(order.status)) throw new BadRequestException(`A ${order.status} order cannot be cancelled`);
      for (const line of order.lines) {
        const picks = picksOf(line);
        if (picks.length) await this.stock.release(tx, line.variantId, picks);
        await tx.salesOrderLine.update({ where: { id: line.id }, data: { reservedPicks: Prisma.DbNull } });
      }
      await tx.approvalRequest.updateMany({ where: { entityType: "SalesOrder", entityId: orderId, status: "PENDING" }, data: { status: "CANCELLED" } });
      await this.audit.log({ userId: me.id, action: "CANCEL", entityType: "SalesOrder", entityId: orderId, after: { reason } }, tx);
      return tx.salesOrder.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    });
  }

  /** Deliver reserved stock (all, or some lines / quantities): delivery note + cost of goods sold posting. */
  async deliver(me: AuthUser, orderId: string, input: { lines?: { lineId: string; quantity: number }[]; receivedBy?: string; notes?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
      if (!["CONFIRMED", "PICKING", "PACKED", "PARTIALLY_DELIVERED"].includes(order.status)) throw new BadRequestException(`A ${order.status} order cannot be delivered`);

      const wanted = input.lines ?? order.lines.map((l) => ({ lineId: l.id, quantity: l.quantity - l.deliveredQty }));
      const dnLines: { variantId: string; batchId: string; quantity: number }[] = [];
      let dnWarehouseId: string | undefined;
      const movements = [];

      for (const w of wanted.filter((x) => x.quantity > 0)) {
        const line = order.lines.find((l) => l.id === w.lineId);
        if (!line) throw new NotFoundException(`Line ${w.lineId} is not on this order`);
        if (line.deliveredQty + w.quantity > line.quantity) throw new BadRequestException(`Delivering more than ordered on line ${line.id}`);

        // Use the batches reserved for this line, in FEFO order
        const remaining = picksOf(line).map((p) => ({ ...p }));
        const take: BatchPick[] = [];
        let need = w.quantity;
        for (const p of remaining) {
          if (need === 0) break;
          const q = Math.min(p.quantity, need);
          take.push({ ...p, quantity: q });
          p.quantity -= q;
          need -= q;
        }
        if (need > 0) throw new BadRequestException(`Not enough reserved stock on line ${line.id}`);

        const mvs = await this.stock.issue(tx, { variantId: line.variantId, picks: take, type: "SALE_DELIVERY", fromReserved: true, refType: "SalesOrder", refId: order.id, userId: me.id });
        movements.push(...mvs);
        take.forEach((t) => dnLines.push({ variantId: line.variantId, batchId: t.batchId, quantity: t.quantity }));
        dnWarehouseId ??= take[0]?.warehouseId;

        // Weighted unit cost of everything delivered on this line so far (for profit reports)
        const costNow = sum(mvs.map((m) => d(m.unitCostAed.toString()).times(-m.quantity)));
        const costBefore = d(line.unitCostAed.toString()).times(line.deliveredQty);
        const deliveredQty = line.deliveredQty + w.quantity;
        await tx.salesOrderLine.update({
          where: { id: line.id },
          data: {
            deliveredQty,
            unitCostAed: round2(costBefore.plus(costNow).dividedBy(deliveredQty)).toString(),
            reservedPicks: remaining.filter((p) => p.quantity > 0) as unknown as Prisma.InputJsonValue,
          },
        });
      }
      if (dnLines.length === 0) throw new BadRequestException("Nothing to deliver");

      const dn = await tx.deliveryNote.create({
        data: {
          number: await this.numbering.next("DN", tx),
          salesOrderId: order.id,
          warehouseId: dnWarehouseId!,
          receivedBy: input.receivedBy,
          notes: input.notes,
          lines: { create: dnLines },
        },
        include: { lines: true },
      });

      const lines = await tx.salesOrderLine.findMany({ where: { salesOrderId: order.id } });
      const all = lines.every((l) => l.deliveredQty >= l.quantity);
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: all ? "DELIVERED" : "PARTIALLY_DELIVERED" } });
      await this.ledger.postStockMovements(tx, movements, { source: "COGS", refType: "DeliveryNote", refId: dn.id, memo: `${dn.number} cost of goods sold`, userId: me.id, customerId: order.customerId });
      return dn;
    });
  }

  // ---------- Invoices ----------
  /**
   * Tax invoice for a delivered order. UAE customers: 5% VAT (tax invoice);
   * customers abroad: zero-rated export invoice. Posts receivables, sales by brand and output VAT.
   */
  async invoiceOrder(me: AuthUser, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { lines: { include: { variant: { include: { product: { include: { brand: true } } } } } }, customer: true, invoices: true },
      });
      if (order.status !== "DELIVERED") throw new BadRequestException("Deliver the full order before invoicing it");
      if (order.invoices.some((i) => i.status !== "VOID")) throw new ConflictException("This order is already invoiced");
      const c = order.customer!;
      const isExport = isExportCustomer(c);
      const signatory = await tx.user.findFirst({ where: { isSignatory: true, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
      const issueDate = new Date();
      const rate = order.exchangeRate.toString();

      const invLines = order.lines.map((l) => {
        const net = d(l.lineTotal.toString());
        const vat = round2(net.times(l.vatRate.toString()).dividedBy(100));
        return {
          variantId: l.variantId,
          description: `${l.variant.product.brand.name} ${l.variant.product.nameEn}${l.variant.sizeMl ? ` ${l.variant.sizeMl}ml` : ""}${l.variant.packType === "TESTER" ? " Tester" : ""} (${l.variant.sku})`,
          quantity: String(l.quantity),
          unitPrice: l.unitPrice.toString(),
          discountPct: l.discountPct.toString(),
          vatCategory: isExport ? ("ZERO_RATED" as const) : ("STANDARD" as const),
          vatRate: l.vatRate.toString(),
          vatAmount: vat.toString(),
          lineTotal: net.toString(),
          brandId: l.variant.product.brandId,
        };
      });
      const shipping = d(order.shippingFee.toString());
      if (shipping.greaterThan(0)) {
        const vat = isExport ? d(0) : round2(shipping.times(5).dividedBy(100));
        invLines.push({ variantId: null as unknown as string, description: "Delivery charge", quantity: "1", unitPrice: shipping.toString(), discountPct: "0", vatCategory: isExport ? "ZERO_RATED" : "STANDARD", vatRate: isExport ? "0" : "5", vatAmount: vat.toString(), lineTotal: shipping.toString(), brandId: null as unknown as string });
      }

      const net = sum(invLines.map((l) => l.lineTotal));
      const vat = sum(invLines.map((l) => l.vatAmount));
      const total = net.plus(vat);
      const invoice = await tx.invoice.create({
        data: {
          number: await this.numbering.next("INV", tx, issueDate),
          type: isExport ? "EXPORT_INVOICE" : "TAX_INVOICE",
          status: "ISSUED",
          customerId: c.id,
          salesOrderId: order.id,
          issueDate,
          supplyDate: issueDate,
          dueDate: new Date(issueDate.getTime() + c.paymentTermsDays * 86_400_000),
          currencyCode: order.currencyCode,
          exchangeRate: rate,
          subtotal: net.toString(),
          discount: "0",
          vatAmount: vat.toString(),
          total: total.toString(),
          vatAmountAed: toAed(vat, rate).toString(),
          totalAed: toAed(total, rate).toString(),
          customerTrn: c.trn,
          billToSnapshot: { companyName: c.companyName, address: c.address, city: c.city, emirate: c.emirate, countryCode: c.countryCode, trn: c.trn, tradeLicenceNo: c.tradeLicenceNo },
          signatoryName: signatory?.fullName,
          signatoryTitle: signatory?.title,
          lines: { create: invLines.map(({ brandId: _b, ...l }) => ({ ...l, variantId: l.variantId ?? undefined })) },
        },
        include: { lines: true },
      });
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: "INVOICED" } });

      // Journal: Dr receivables / Cr sales (split by brand for profit reports) / Cr output VAT
      const salesAccount = isExport ? ACC.SALES_EXPORT : order.channel === "WEB_STORE" ? ACC.SALES_ONLINE : ACC.SALES_WHOLESALE;
      const byBrand = new Map<string | null, ReturnType<typeof d>>();
      invLines.forEach((l) => byBrand.set(l.brandId ?? null, (byBrand.get(l.brandId ?? null) ?? d(0)).plus(l.lineTotal)));
      const totalAed = toAed(total, rate);
      const vatAed = toAed(vat, rate);
      const salesLines: PostingLine[] = [...byBrand.entries()].map(([brandId, amount]) => ({ account: salesAccount, credit: toAed(amount, rate), brandId, customerId: c.id }));
      // keep the entry balanced after per-brand rounding
      const diff = totalAed.minus(vatAed).minus(sum(salesLines.map((l) => l.credit!)));
      if (!diff.isZero()) salesLines[0].credit = d(salesLines[0].credit!).plus(diff);
      await this.ledger.post(tx, {
        date: issueDate,
        source: "SALES_INVOICE",
        refType: "Invoice",
        refId: invoice.id,
        memo: `${invoice.number} ${c.companyName}`,
        userId: me.id,
        lines: [{ account: ACC.RECEIVABLES, debit: totalAed, customerId: c.id }, ...salesLines, { account: ACC.VAT_OUTPUT, credit: vatAed, customerId: c.id }],
      });

      await this.createCommission(tx, order.salespersonId, order.id, toAed(net, rate), issueDate);
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "Invoice", entityId: invoice.id, after: invoice }, tx);
      return invoice;
    });
  }

  private async createCommission(tx: Tx, salespersonId: string | null, salesOrderId: string, netAed: ReturnType<typeof d>, date: Date) {
    if (!salespersonId) return;
    const employee = await tx.employee.findUnique({ where: { userId: salespersonId } });
    const rate = d(employee?.commissionPct?.toString() ?? 0);
    if (rate.isZero()) return;
    const period = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit" }).format(date);
    await tx.commission.create({
      data: { userId: salespersonId, salesOrderId, ratePct: rate.toString(), baseAmount: netAed.toString(), amount: round2(netAed.times(rate).dividedBy(100)).toString(), period },
    });
  }

  /** Recalculate an invoice's status from payments and credit notes. */
  async refreshInvoiceStatus(tx: Tx, invoiceId: string) {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (inv.status === "VOID" || inv.status === "DRAFT") return inv;
    const settled = d(inv.amountPaid.toString()).plus(inv.amountCredited.toString());
    const status = settled.greaterThanOrEqualTo(inv.total.toString()) ? "PAID" : settled.greaterThan(0) ? "PARTIALLY_PAID" : "ISSUED";
    return tx.invoice.update({ where: { id: invoiceId }, data: { status } });
  }

  // ---------- Credit notes ----------
  async requestCreditNote(
    me: AuthUser,
    invoiceId: string,
    input: { reason: string; lines: { invoiceLineId: string; quantity: number }[]; restock: boolean; warehouseId?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true, creditNotes: { where: { status: { in: ["PENDING_APPROVAL", "ISSUED", "APPLIED"] } }, include: { lines: true } } } });
      if (inv.status === "VOID" || inv.status === "DRAFT") throw new BadRequestException("Invoice is not issued");
      if (input.restock && !input.warehouseId) throw new BadRequestException("Choose the warehouse the goods return to");

      const cnLines = input.lines.map((l) => {
        const il = inv.lines.find((x) => x.id === l.invoiceLineId);
        if (!il) throw new BadRequestException(`Line ${l.invoiceLineId} is not on ${inv.number}`);
        const already = sum(inv.creditNotes.flatMap((cn) => cn.lines).filter((x) => x.description === il.description).map((x) => x.quantity.toString()));
        if (already.plus(l.quantity).greaterThan(il.quantity.toString())) throw new BadRequestException(`Crediting more than invoiced for "${il.description}"`);
        const unitNet = d(il.lineTotal.toString()).dividedBy(il.quantity.toString());
        return {
          variantId: il.variantId,
          description: il.description,
          quantity: String(l.quantity),
          unitPrice: round2(unitNet).toString(),
          vatRate: il.vatRate.toString(),
          lineTotal: round2(unitNet.times(l.quantity)).toString(),
        };
      });
      const subtotal = sum(cnLines.map((l) => l.lineTotal));
      const vat = sum(cnLines.map((l) => round2(d(l.lineTotal).times(l.vatRate).dividedBy(100))));
      const total = subtotal.plus(vat);
      if (total.greaterThan(d(inv.total.toString()).minus(inv.amountCredited.toString()))) throw new BadRequestException("Credit is more than the invoice's remaining value");

      const cn = await tx.creditNote.create({
        data: {
          number: await this.numbering.next("CN", tx),
          invoiceId,
          customerId: inv.customerId,
          status: "PENDING_APPROVAL",
          reason: input.reason,
          subtotal: subtotal.toString(),
          vatAmount: vat.toString(),
          total: total.toString(),
          restock: input.restock,
          lines: { create: cnLines },
        },
        include: { lines: true },
      });
      const approval = await this.approvals.request(
        {
          type: "CREDIT_NOTE",
          entityType: "CreditNote",
          entityId: cn.id,
          title: `${cn.number} on ${inv.number}: AED ${toAed(total, inv.exchangeRate.toString()).toFixed(2)}, ${input.reason}`,
          details: { invoiceId, restock: input.restock, warehouseId: input.warehouseId },
          amountAed: toAed(total, inv.exchangeRate.toString()).toNumber(),
          requestedById: me.id,
        },
        tx,
      );
      return { creditNote: await tx.creditNote.findUniqueOrThrow({ where: { id: cn.id }, include: { lines: true } }), approval };
    });
  }

  /** Approval handler: issue the credit note, reduce the invoice, post the reversal, restock if asked. */
  async issueCreditNote(tx: Tx, creditNoteId: string, details: { warehouseId?: string }, deciderId: string) {
    const cn = await tx.creditNote.findUniqueOrThrow({ where: { id: creditNoteId }, include: { lines: true, invoice: true } });
    const inv = cn.invoice;
    const rate = inv.exchangeRate.toString();
    await tx.creditNote.update({ where: { id: cn.id }, data: { status: "ISSUED", issueDate: new Date() } });
    await tx.invoice.update({ where: { id: inv.id }, data: { amountCredited: { increment: cn.total } } });
    await this.refreshInvoiceStatus(tx, inv.id);

    const totalAed = toAed(cn.total.toString(), rate);
    const vatAed = toAed(cn.vatAmount.toString(), rate);
    await this.ledger.post(tx, {
      source: "CREDIT_NOTE",
      refType: "CreditNote",
      refId: cn.id,
      memo: `${cn.number} on ${inv.number}: ${cn.reason}`,
      userId: deciderId,
      lines: [
        { account: ACC.SALES_RETURNS, debit: totalAed.minus(vatAed), customerId: inv.customerId },
        { account: ACC.VAT_OUTPUT, debit: vatAed, customerId: inv.customerId },
        { account: ACC.RECEIVABLES, credit: totalAed, customerId: inv.customerId },
      ],
    });

    if (cn.restock && details.warehouseId && inv.salesOrderId) {
      const delivered = await tx.deliveryNoteLine.findMany({ where: { deliveryNote: { salesOrderId: inv.salesOrderId } }, include: { batch: true } });
      const movements = [];
      for (const l of cn.lines.filter((x) => x.variantId)) {
        const batch = delivered.find((x) => x.variantId === l.variantId)?.batch;
        if (!batch) continue;
        movements.push(
          await this.stock.receive(tx, {
            variantId: l.variantId!,
            warehouseId: details.warehouseId,
            batchNo: batch.batchNo,
            quantity: Number(l.quantity),
            unitCostAed: batch.unitCostAed.toString(),
            type: "CUSTOMER_RETURN",
            refType: "CreditNote",
            refId: cn.id,
            reason: cn.reason,
            userId: deciderId,
          }),
        );
      }
      await this.ledger.postStockMovements(tx, movements, { source: "CREDIT_NOTE", refType: "CreditNote", refId: cn.id, memo: `${cn.number} goods returned`, userId: deciderId, customerId: inv.customerId });
    }
  }
}
