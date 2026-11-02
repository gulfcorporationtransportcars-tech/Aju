import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, OnModuleInit, Param, Post, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { hasPermission, PERMISSIONS } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../common/auth/decorators";
import { Money, PageQuery, skipTake, toPage } from "../common/http/pagination";
import { zod } from "../common/http/zod.pipe";
import { PrismaService } from "../common/prisma/prisma.service";
import { ApprovalsService } from "../core/approvals/approvals.service";
import { AuditService } from "../core/audit/audit.service";
import { NumberingService } from "../core/numbering/numbering.service";
import { invoiceBalance } from "./crm.controller";
import { PricingService } from "./pricing.service";
import { SalesService } from "./sales.service";

const LineReq = z.object({ variantId: z.string(), quantity: z.number().int().positive(), unitPrice: Money.optional(), discountPct: z.number().min(0).max(100).optional() });

const QuotationBody = z.object({
  customerId: z.string(),
  validUntil: z.coerce.date().optional(),
  terms: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(LineReq).min(1),
});

const OrderBody = z.object({
  customerId: z.string(),
  warehouseId: z.string().optional(),
  requiredBy: z.coerce.date().optional(),
  notes: z.string().optional(),
  shippingFee: Money.optional(),
  campaignId: z.string().optional(),
  lines: z.array(LineReq).min(1),
});

const DeliverBody = z.object({
  lines: z.array(z.object({ lineId: z.string(), quantity: z.number().int().positive() })).optional(),
  receivedBy: z.string().optional(),
  notes: z.string().optional(),
});

const CreditNoteBody = z.object({
  reason: z.string().min(3),
  lines: z.array(z.object({ invoiceLineId: z.string(), quantity: z.number().int().positive() })).min(1),
  restock: z.boolean().default(false),
  warehouseId: z.string().optional(),
});

const DocQuery = PageQuery.extend({ status: z.string().optional(), customerId: z.string().optional(), overdue: z.enum(["true", "false"]).transform((v) => v === "true").optional() });

const CUSTOMER_LABEL = { select: { id: true, code: true, companyName: true, trn: true } } as const;
const LINE_VARIANT = { include: { variant: { select: { sku: true, sizeMl: true, packType: true, product: { select: { nameEn: true, nameAr: true, brand: { select: { name: true } } } } } } } } as const;

@Controller("sales")
export class SalesController implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly pricing: PricingService,
    private readonly approvals: ApprovalsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // Below-minimum prices on a quotation: approved → quotation is sent to the customer.
    this.approvals.registerHandler("Quotation", {
      onApproved: async (tx, req) => {
        await tx.quotation.update({ where: { id: req.entityId }, data: { status: "SENT" } });
      },
      onRejected: async (tx, req) => {
        await tx.quotation.update({ where: { id: req.entityId }, data: { status: "DRAFT" } });
      },
    });
    // Below-minimum prices on a direct order: approved → credit check + stock reservation.
    this.approvals.registerHandler("SalesOrder", {
      onApproved: async (tx, req, deciderId) => {
        const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: req.entityId }, include: { lines: true, customer: true } });
        const decider = await tx.user.findUniqueOrThrow({ where: { id: deciderId }, include: { role: { include: { permissions: { include: { permission: true } } } } } });
        const permissions = decider.role?.permissions.map((p) => p.permission.key) ?? [];
        await this.sales.reserveAndConfirm(tx, order, { id: decider.id, permissions } as AuthUser);
      },
      onRejected: async (tx, req) => {
        await tx.salesOrder.update({ where: { id: req.entityId }, data: { status: "DRAFT" } });
      },
    });
    this.approvals.registerHandler("CreditNote", {
      onApproved: (tx, req, deciderId) => this.sales.issueCreditNote(tx, req.entityId, req.details as { warehouseId?: string }, deciderId),
      onRejected: async (tx, req) => {
        await tx.creditNote.update({ where: { id: req.entityId }, data: { status: "VOID" } });
      },
    });
  }

  // ---------- Price check ----------
  /** Preview prices for a customer before creating a quotation or order. */
  @Post("price-check")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  @HttpCode(200)
  async priceCheck(@Body(zod(z.object({ customerId: z.string(), lines: z.array(LineReq).min(1) }))) body: { customerId: string; lines: z.infer<typeof LineReq>[] }) {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: body.customerId } });
    const priced = await this.pricing.priceLines(this.prisma as never, customer, body.lines);
    return { lines: priced.lines, subtotal: priced.totals.net.toString(), vat: priced.totals.vat.toString(), total: priced.totals.total.toString() };
  }

  // ---------- Quotations ----------
  @Get("quotations")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  async quotations(@Query(zod(DocQuery)) q: z.infer<typeof DocQuery>) {
    const where: Prisma.QuotationWhereInput = { status: q.status as Prisma.QuotationWhereInput["status"], customerId: q.customerId, ...(q.q ? { number: { contains: q.q, mode: "insensitive" } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.quotation.findMany({ where, include: { customer: CUSTOMER_LABEL }, orderBy: { issueDate: "desc" }, ...skipTake(q) }),
      this.prisma.quotation.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Get("quotations/:id")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  quotation(@Param("id") id: string) {
    return this.prisma.quotation.findUniqueOrThrow({ where: { id }, include: { customer: CUSTOMER_LABEL, lines: LINE_VARIANT, createdBy: { select: { fullName: true } }, salesOrder: { select: { id: true, number: true } } } });
  }

  @Post("quotations")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  async createQuotation(@CurrentUser() me: AuthUser, @Body(zod(QuotationBody)) body: z.infer<typeof QuotationBody>) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: body.customerId } });
      const priced = await this.pricing.priceLines(tx, customer, body.lines);
      const qt = await tx.quotation.create({
        data: {
          number: await this.numbering.next("QT", tx),
          customerId: customer.id,
          validUntil: body.validUntil ?? new Date(Date.now() + 14 * 86_400_000),
          terms: body.terms,
          notes: body.notes,
          createdById: me.id,
          subtotal: priced.totals.subtotal.toString(),
          discount: priced.totals.discount.toString(),
          vatAmount: priced.totals.vat.toString(),
          total: priced.totals.total.toString(),
          lines: { create: priced.lines.map((l) => ({ variantId: l.variantId, description: l.label, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, vatRate: l.vatRate, lineTotal: l.lineTotal, belowMinPrice: l.belowMinPrice })) },
        },
        include: { lines: true },
      });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "Quotation", entityId: qt.id, after: qt }, tx);
      return qt;
    });
  }

  /** Send to the customer. Prices below the minimum need the Manager's approval first. */
  @Post("quotations/:id/send")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  @HttpCode(200)
  async sendQuotation(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    return this.prisma.$transaction(async (tx) => {
      const qt = await tx.quotation.findUniqueOrThrow({ where: { id }, include: { lines: true, customer: true } });
      if (qt.status !== "DRAFT") throw new BadRequestException(`Quotation is ${qt.status}`);
      const below = qt.lines.filter((l) => l.belowMinPrice);
      if (below.length === 0) return { status: "SENT", quotation: await tx.quotation.update({ where: { id }, data: { status: "SENT" } }) };
      await tx.quotation.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
      const approval = await this.approvals.request(
        {
          type: "DISCOUNT_BELOW_MIN",
          entityType: "Quotation",
          entityId: id,
          title: `${qt.number} for ${qt.customer.companyName}: ${below.length} line(s) below minimum price`,
          details: { lines: below.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct })) },
          amountAed: Number(qt.total),
          requestedById: me.id,
        },
        tx,
      );
      return { status: approval.status === "APPROVED" ? "SENT" : "PENDING_APPROVAL", approval, quotation: await tx.quotation.findUniqueOrThrow({ where: { id } }) };
    });
  }

  @Post("quotations/:id/accept")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  @HttpCode(200)
  async acceptQuotation(@Param("id") id: string) {
    const res = await this.prisma.quotation.updateMany({ where: { id, status: "SENT" }, data: { status: "ACCEPTED" } });
    if (res.count !== 1) throw new BadRequestException("Only a sent quotation can be accepted");
    return this.prisma.quotation.findUniqueOrThrow({ where: { id } });
  }

  /** Accepted quotation → sales order at the quoted (and approved) prices, then confirm it. */
  @Post("quotations/:id/convert")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  async convertQuotation(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(z.object({ warehouseId: z.string().optional(), overrideCredit: z.boolean().default(false) }))) body: { warehouseId?: string; overrideCredit: boolean }) {
    const order = await this.prisma.$transaction(async (tx) => {
      const qt = await tx.quotation.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (!["SENT", "ACCEPTED"].includes(qt.status)) throw new BadRequestException(`A ${qt.status} quotation cannot become an order`);
      if (qt.validUntil && qt.validUntil < new Date()) throw new BadRequestException("This quotation has expired");
      const o = await this.sales.createOrder(tx, me, {
        customerId: qt.customerId,
        quotationId: qt.id,
        warehouseId: body.warehouseId,
        lines: qt.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice.toString(), discountPct: Number(l.discountPct) })),
      });
      await tx.quotation.update({ where: { id }, data: { status: "CONVERTED" } });
      return o;
    });
    return this.sales.confirm(me, order.id, body.overrideCredit);
  }

  // ---------- Sales orders ----------
  @Get("orders")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  async orders(@Query(zod(DocQuery.extend({ channel: z.string().optional() }))) q: z.infer<typeof DocQuery> & { channel?: string }) {
    const where: Prisma.SalesOrderWhereInput = {
      status: q.status as Prisma.SalesOrderWhereInput["status"],
      channel: q.channel as Prisma.SalesOrderWhereInput["channel"],
      customerId: q.customerId,
      ...(q.q ? { number: { contains: q.q, mode: "insensitive" } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.salesOrder.findMany({ where, include: { customer: CUSTOMER_LABEL, salesperson: { select: { fullName: true } } }, orderBy: { orderDate: "desc" }, ...skipTake(q) }),
      this.prisma.salesOrder.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Get("orders/:id")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  async order(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    const o = await this.prisma.salesOrder.findUnique({
      where: { id },
      include: { customer: CUSTOMER_LABEL, lines: LINE_VARIANT, deliveryNotes: { include: { lines: true } }, invoices: { select: { id: true, number: true, status: true, totalAed: true } }, salesperson: { select: { fullName: true } } },
    });
    if (!o) throw new NotFoundException();
    if (hasPermission(me.permissions, PERMISSIONS.PRICE_READ_COST)) return o;
    return { ...o, lines: o.lines.map(({ unitCostAed: _c, ...l }) => l) };
  }

  @Post("orders")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  createOrder(@CurrentUser() me: AuthUser, @Body(zod(OrderBody)) body: z.infer<typeof OrderBody>) {
    return this.prisma.$transaction((tx) => this.sales.createOrder(tx, me, body));
  }

  /** Confirm: below-minimum approval → credit check → stock reserved (FEFO). `overrideCredit` is for the Manager only. */
  @Post("orders/:id/confirm")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  @HttpCode(200)
  confirm(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(z.object({ overrideCredit: z.boolean().default(false) }))) body: { overrideCredit: boolean }) {
    if (body.overrideCredit && !hasPermission(me.permissions, "*")) throw new ForbiddenException("Only the Manager can override a credit limit");
    return this.sales.confirm(me, id, body.overrideCredit);
  }

  @Post("orders/:id/cancel")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  @HttpCode(200)
  cancel(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(z.object({ reason: z.string().optional() }))) body: { reason?: string }) {
    return this.sales.cancel(me, id, body.reason);
  }

  @Post("orders/:id/deliveries")
  @RequirePermissions(PERMISSIONS.DELIVERY_MANAGE)
  deliver(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(DeliverBody)) body: z.infer<typeof DeliverBody>) {
    return this.sales.deliver(me, id, body);
  }

  @Post("orders/:id/invoice")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  invoice(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    return this.sales.invoiceOrder(me, id);
  }

  @Get("delivery-notes/:id")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  deliveryNote(@Param("id") id: string) {
    return this.prisma.deliveryNote.findUniqueOrThrow({
      where: { id },
      include: { salesOrder: { include: { customer: CUSTOMER_LABEL } }, warehouse: true, lines: { include: { variant: LINE_VARIANT.include.variant, batch: { select: { batchNo: true, expiresOn: true } } } } },
    });
  }

  // ---------- Invoices ----------
  @Get("invoices")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  async invoices(@Query(zod(DocQuery)) q: z.infer<typeof DocQuery>) {
    const where: Prisma.InvoiceWhereInput = {
      status: q.overdue ? { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } : (q.status as Prisma.InvoiceWhereInput["status"]),
      customerId: q.customerId,
      ...(q.overdue ? { dueDate: { lt: new Date() } } : {}),
      ...(q.q ? { number: { contains: q.q, mode: "insensitive" } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, include: { customer: CUSTOMER_LABEL }, orderBy: { issueDate: "desc" }, ...skipTake(q) }),
      this.prisma.invoice.count({ where }),
    ]);
    const now = new Date();
    return toPage(
      items.map((i) => {
        const balance = invoiceBalance(i);
        return { ...i, balance: balance.toFixed(2), isOverdue: balance.greaterThan(0) && !!i.dueDate && i.dueDate < now };
      }),
      total,
      q,
    );
  }

  /** Everything needed to print the bilingual tax invoice (company details, TRNs, VAT in AED, signatory). */
  @Get("invoices/:id")
  @RequirePermissions(PERMISSIONS.SALES_READ)
  async invoiceDetail(@Param("id") id: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: { lines: true, customer: CUSTOMER_LABEL, creditNotes: true, allocations: { include: { payment: { select: { number: true, date: true, method: true } } } } },
    });
    if (!inv) throw new NotFoundException();
    const company = await this.prisma.setting.findUnique({ where: { key: "company.profile" } });
    return {
      ...inv,
      title: inv.type === "EXPORT_INVOICE" ? { en: "Tax Invoice (Export, zero-rated)", ar: "فاتورة ضريبية (تصدير - نسبة صفر)" } : { en: "Tax Invoice", ar: "فاتورة ضريبية" },
      balance: invoiceBalance(inv).toFixed(2),
      seller: company?.value,
    };
  }

  @Post("invoices/:id/credit-notes")
  @RequirePermissions(PERMISSIONS.SALES_MANAGE)
  @HttpCode(202)
  creditNote(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(CreditNoteBody)) body: z.infer<typeof CreditNoteBody>) {
    return this.sales.requestCreditNote(me, id, body);
  }

  // ---------- Commissions ----------
  @Get("commissions")
  @RequirePermissions(PERMISSIONS.COMMISSION_READ_OWN)
  async commissions(@CurrentUser() me: AuthUser, @Query(zod(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), userId: z.string().optional() }))) q: { period?: string; userId?: string }) {
    const seeAll = hasPermission(me.permissions, PERMISSIONS.COMMISSION_READ_ALL);
    const where: Prisma.CommissionWhereInput = { period: q.period, userId: seeAll ? q.userId : me.id };
    const items = await this.prisma.commission.findMany({ where, include: { user: { select: { fullName: true } }, salesOrder: { select: { number: true } } }, orderBy: { createdAt: "desc" } });
    const total = items.reduce((s, c) => s + Number(c.amount), 0);
    return { items, totalAed: total.toFixed(2) };
  }
}
