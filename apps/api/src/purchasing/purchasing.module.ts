import { BadRequestException, Body, Controller, Get, HttpCode, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { allocateLandedCosts, calcDocument, d, PERMISSIONS, round2, toAed } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../common/auth/decorators";
import { Money, PageQuery, skipTake, toPage } from "../common/http/pagination";
import { zod } from "../common/http/zod.pipe";
import { PrismaService } from "../common/prisma/prisma.service";
import { ApprovalsService } from "../core/approvals/approvals.service";
import { AuditService } from "../core/audit/audit.service";
import { NumberingService } from "../core/numbering/numbering.service";
import { ACC } from "../finance/ledger/accounts";
import { LedgerService } from "../finance/ledger/ledger.service";
import { InventoryModule } from "../trading/inventory/inventory.module";
import { StockService } from "../trading/inventory/stock.service";

const SupplierBody = z.object({
  code: z.string().min(2).toUpperCase(),
  name: z.string().min(1),
  countryCode: z.string().length(2).optional(),
  contactName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  address: z.string().optional(),
  trn: z.string().optional(),
  currencyCode: z.string().length(3).default("AED"),
  paymentTermsDays: z.number().int().min(0).default(0),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
});

const Rate = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,6})?$/)]).transform(String);

const PoBody = z.object({
  supplierId: z.string(),
  currencyCode: z.string().length(3).default("AED"),
  exchangeRate: Rate.default("1"), // 1 unit of currency = X AED
  expectedOn: z.coerce.date().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({ variantId: z.string(), quantity: z.number().int().positive(), unitPrice: Money, vatRate: z.number().min(0).max(100).optional() })).min(1),
});

const ReceiptBody = z.object({
  purchaseOrderId: z.string().optional(),
  supplierId: z.string(),
  warehouseId: z.string(),
  exchangeRate: Rate.optional(), // defaults to the PO's rate, else 1
  receivedOn: z.coerce.date().optional(),
  notes: z.string().optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().optional(),
        variantId: z.string(),
        batchNo: z.string().min(1),
        expiresOn: z.coerce.date().optional(),
        quantity: z.number().int().positive(),
        unitPrice: Money, // in the receipt currency
      }),
    )
    .min(1),
  landedCosts: z
    .array(z.object({ type: z.enum(["FREIGHT", "CUSTOMS_DUTY", "CLEARING", "INSURANCE", "LOCAL_TRANSPORT", "OTHER"]), amountAed: Money, method: z.enum(["BY_VALUE", "BY_QUANTITY", "BY_WEIGHT"]).default("BY_VALUE"), reference: z.string().optional() }))
    .default([]),
});

const BillBody = z.object({
  supplierId: z.string(),
  purchaseOrderId: z.string().optional(),
  supplierRef: z.string().min(1),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  currencyCode: z.string().length(3).default("AED"),
  exchangeRate: Rate.default("1"),
  subtotal: Money,
  vatAmount: Money.default("0"),
  // Where the cost goes. Goods & freight already in stock → "Goods received not invoiced" (2050).
  debitAccount: z.string().default(ACC.GRNI),
});

const ListQuery = PageQuery.extend({ status: z.string().optional(), supplierId: z.string().optional() });

const PO_INCLUDE = {
  supplier: { select: { id: true, code: true, name: true } },
  lines: { include: { variant: { select: { sku: true, sizeMl: true, product: { select: { nameEn: true, brand: { select: { name: true } } } } } } } },
} as const;

@Controller("purchasing")
export class PurchasingController implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler("PurchaseOrder", {
      onApproved: async (tx, req) => {
        await tx.purchaseOrder.update({ where: { id: req.entityId }, data: { status: "APPROVED" } });
      },
      onRejected: async (tx, req) => {
        await tx.purchaseOrder.update({ where: { id: req.entityId }, data: { status: "DRAFT" } });
      },
    });
  }

  // ---------- Suppliers ----------
  @Get("suppliers")
  @RequirePermissions(PERMISSIONS.PURCHASING_READ)
  async suppliers(@Query(zod(PageQuery)) q: PageQuery) {
    const where: Prisma.SupplierWhereInput = q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q, mode: "insensitive" } }] } : {};
    const [items, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, orderBy: { name: "asc" }, ...skipTake(q) }),
      this.prisma.supplier.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post("suppliers")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  createSupplier(@Body(zod(SupplierBody)) body: z.infer<typeof SupplierBody>) {
    return this.prisma.supplier.create({ data: body });
  }

  @Patch("suppliers/:id")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  updateSupplier(@Param("id") id: string, @Body(zod(SupplierBody.partial())) body: Partial<z.infer<typeof SupplierBody>>) {
    return this.prisma.supplier.update({ where: { id }, data: body });
  }

  // ---------- Purchase orders ----------
  @Get("orders")
  @RequirePermissions(PERMISSIONS.PURCHASING_READ)
  async orders(@Query(zod(ListQuery)) q: z.infer<typeof ListQuery>) {
    const where: Prisma.PurchaseOrderWhereInput = { status: q.status as Prisma.PurchaseOrderWhereInput["status"], supplierId: q.supplierId, ...(q.q ? { number: { contains: q.q, mode: "insensitive" } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, include: { supplier: PO_INCLUDE.supplier }, orderBy: { orderDate: "desc" }, ...skipTake(q) }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Get("orders/:id")
  @RequirePermissions(PERMISSIONS.PURCHASING_READ)
  async order(@Param("id") id: string) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { ...PO_INCLUDE, goodsReceipts: true, supplierBills: true } });
    if (!po) throw new NotFoundException();
    return po;
  }

  @Post("orders")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  async createOrder(@CurrentUser() me: AuthUser, @Body(zod(PoBody)) body: z.infer<typeof PoBody>) {
    const supplier = await this.prisma.supplier.findUniqueOrThrow({ where: { id: body.supplierId } });
    // Imports from outside the UAE carry no UAE VAT on the supplier invoice (import VAT is handled at customs).
    const defaultVat = (supplier.countryCode ?? "AE") === "AE" ? 5 : 0;
    const lines = body.lines.map((l) => ({ ...l, vatRate: l.vatRate ?? defaultVat }));
    const totals = calcDocument(lines);
    return this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.create({
        data: {
          number: await this.numbering.next("PO", tx),
          supplierId: body.supplierId,
          currencyCode: body.currencyCode,
          exchangeRate: body.exchangeRate,
          expectedOn: body.expectedOn,
          notes: body.notes,
          createdById: me.id,
          subtotal: totals.net.toString(),
          vatAmount: totals.vat.toString(),
          total: totals.total.toString(),
          totalAed: toAed(totals.total, body.exchangeRate).toString(),
          lines: {
            create: lines.map((l, i) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate, lineTotal: totals.lines[i].net.toString() })),
          },
        },
        include: PO_INCLUDE,
      });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "PurchaseOrder", entityId: po.id, after: po }, tx);
      return po;
    });
  }

  /** Submit for approval. Orders above the PO limit (default AED 20,000) go to the Manager. */
  @Post("orders/:id/submit")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @HttpCode(200)
  async submitOrder(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    return this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { supplier: true } });
      if (po.status !== "DRAFT") throw new BadRequestException(`Order is ${po.status}`);
      const amount = Number(po.totalAed);
      if (!(await this.approvals.isRequired("PO_ABOVE_LIMIT", amount, tx))) {
        return tx.purchaseOrder.update({ where: { id }, data: { status: "APPROVED" } });
      }
      await tx.purchaseOrder.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
      await this.approvals.request(
        { type: "PO_ABOVE_LIMIT", entityType: "PurchaseOrder", entityId: id, title: `${po.number}: ${po.supplier.name}, AED ${amount.toLocaleString("en-AE")}`, amountAed: amount, requestedById: me.id },
        tx,
      );
      return tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    });
  }

  @Post("orders/:id/send")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @HttpCode(200)
  async sendOrder(@Param("id") id: string) {
    const res = await this.prisma.purchaseOrder.updateMany({ where: { id, status: "APPROVED" }, data: { status: "SENT" } });
    if (res.count !== 1) throw new BadRequestException("Only approved orders can be sent");
    return this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
  }

  @Post("orders/:id/cancel")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @HttpCode(200)
  async cancelOrder(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    const res = await this.prisma.purchaseOrder.updateMany({ where: { id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"] } }, data: { status: "CANCELLED" } });
    if (res.count !== 1) throw new BadRequestException("This order can no longer be cancelled");
    await this.prisma.approvalRequest.updateMany({ where: { entityType: "PurchaseOrder", entityId: id, status: "PENDING" }, data: { status: "CANCELLED" } });
    await this.audit.log({ userId: me.id, action: "CANCEL", entityType: "PurchaseOrder", entityId: id });
    return { ok: true };
  }

  // ---------- Goods receipts ----------
  /**
   * Receive goods: creates batches and stock, adds landed costs (freight, duty, clearing,
   * insurance) to each unit's cost, and posts Inventory ← Goods received not invoiced.
   */
  @Post("receipts")
  @RequirePermissions(PERMISSIONS.INVENTORY_MOVE)
  async receive(@CurrentUser() me: AuthUser, @Body(zod(ReceiptBody)) body: z.infer<typeof ReceiptBody>) {
    return this.prisma.$transaction(async (tx) => {
      const po = body.purchaseOrderId ? await tx.purchaseOrder.findUniqueOrThrow({ where: { id: body.purchaseOrderId }, include: { lines: true } }) : null;
      if (po && !["APPROVED", "SENT", "PARTIALLY_RECEIVED"].includes(po.status)) throw new BadRequestException(`Purchase order is ${po.status}`);
      if (po && po.supplierId !== body.supplierId) throw new BadRequestException("Supplier does not match the purchase order");
      const rate = body.exchangeRate ?? po?.exchangeRate.toString() ?? "1";

      // Check quantities against the PO
      for (const l of body.lines) {
        if (!po) continue;
        const pol = po.lines.find((x) => x.id === l.purchaseOrderLineId) ?? po.lines.find((x) => x.variantId === l.variantId);
        if (!pol) throw new BadRequestException(`Item ${l.variantId} is not on ${po.number}`);
        l.purchaseOrderLineId = pol.id;
        const already = body.lines.filter((x) => x.purchaseOrderLineId === pol.id && x !== l).reduce((s, x) => s + x.quantity, 0);
        if (pol.receivedQty + already + l.quantity > pol.quantity) throw new BadRequestException(`Receiving more than ordered for line ${pol.id}`);
      }

      const variants = await tx.productVariant.findMany({ where: { id: { in: body.lines.map((l) => l.variantId) } } });
      const weightOf = (id: string) => variants.find((v) => v.id === id)?.weightGrams ?? 0;
      const receiptLines = body.lines.map((l) => ({ quantity: l.quantity, unitPriceAed: toAed(l.unitPrice, rate), unitWeightGrams: weightOf(l.variantId) }));
      const landed = allocateLandedCosts(receiptLines, body.landedCosts);

      const grn = await tx.goodsReceipt.create({
        data: {
          number: await this.numbering.next("GRN", tx),
          purchaseOrderId: po?.id,
          supplierId: body.supplierId,
          warehouseId: body.warehouseId,
          receivedOn: body.receivedOn,
          notes: body.notes,
          isLandedCostFinal: body.landedCosts.length > 0,
          lines: {
            create: body.lines.map((l, i) => ({ variantId: l.variantId, batchNo: l.batchNo, expiresOn: l.expiresOn, quantity: l.quantity, unitPriceAed: receiptLines[i].unitPriceAed.toString(), landedUnitCost: landed[i].toString() })),
          },
          landedCosts: { create: body.landedCosts },
        },
        include: { lines: true, landedCosts: true },
      });

      const movements = [];
      for (const [i, l] of body.lines.entries()) {
        movements.push(
          await this.stock.receive(tx, {
            variantId: l.variantId,
            warehouseId: body.warehouseId,
            batchNo: l.batchNo,
            expiresOn: l.expiresOn,
            quantity: l.quantity,
            unitCostAed: landed[i].toString(),
            supplierId: body.supplierId,
            goodsReceiptId: grn.id,
            type: "PURCHASE_RECEIPT",
            refType: "GoodsReceipt",
            refId: grn.id,
            userId: me.id,
          }),
        );
        if (l.purchaseOrderLineId) await tx.purchaseOrderLine.update({ where: { id: l.purchaseOrderLineId }, data: { receivedQty: { increment: l.quantity } } });
      }

      if (po) {
        const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
        const done = lines.every((x) => x.receivedQty >= x.quantity);
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: done ? "RECEIVED" : "PARTIALLY_RECEIVED" } });
      }

      await this.ledger.postStockMovements(tx, movements, { source: "SUPPLIER_BILL", refType: "GoodsReceipt", refId: grn.id, memo: `${grn.number} goods received`, userId: me.id });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "GoodsReceipt", entityId: grn.id, after: grn }, tx);
      return grn;
    });
  }

  @Get("receipts/:id")
  @RequirePermissions(PERMISSIONS.PURCHASING_READ)
  receipt(@Param("id") id: string) {
    return this.prisma.goodsReceipt.findUniqueOrThrow({ where: { id }, include: { lines: true, landedCosts: true, supplier: true, warehouse: true, purchaseOrder: { select: { number: true } } } });
  }

  // ---------- Supplier bills ----------
  @Get("bills")
  @RequirePermissions(PERMISSIONS.PURCHASING_READ)
  async bills(@Query(zod(ListQuery)) q: z.infer<typeof ListQuery>) {
    const where: Prisma.SupplierBillWhereInput = { status: q.status as Prisma.SupplierBillWhereInput["status"], supplierId: q.supplierId };
    const [items, total] = await Promise.all([
      this.prisma.supplierBill.findMany({ where, include: { supplier: { select: { name: true } } }, orderBy: { billDate: "desc" }, ...skipTake(q) }),
      this.prisma.supplierBill.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  /** Record a supplier invoice: Dr goods/expense + Dr VAT input, Cr Accounts payable. */
  @Post("bills")
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  async createBill(@CurrentUser() me: AuthUser, @Body(zod(BillBody)) body: z.infer<typeof BillBody>) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: body.supplierId } });
      const total = round2(d(body.subtotal).plus(body.vatAmount));
      const subtotalAed = toAed(body.subtotal, body.exchangeRate);
      const vatAed = toAed(body.vatAmount, body.exchangeRate);
      const totalAed = subtotalAed.plus(vatAed);
      const dueDate = body.dueDate ?? new Date(body.billDate.getTime() + supplier.paymentTermsDays * 86_400_000);
      const bill = await tx.supplierBill.create({
        data: {
          number: await this.numbering.next("BILL", tx),
          supplierRef: body.supplierRef,
          supplierId: body.supplierId,
          purchaseOrderId: body.purchaseOrderId,
          billDate: body.billDate,
          dueDate,
          currencyCode: body.currencyCode,
          exchangeRate: body.exchangeRate,
          subtotal: body.subtotal,
          vatAmount: body.vatAmount,
          total: total.toString(),
          totalAed: totalAed.toString(),
        },
      });
      await this.ledger.post(tx, {
        date: body.billDate,
        source: "SUPPLIER_BILL",
        refType: "SupplierBill",
        refId: bill.id,
        memo: `${bill.number} ${supplier.name} inv ${body.supplierRef}`,
        userId: me.id,
        lines: [
          { account: body.debitAccount, debit: subtotalAed },
          { account: ACC.VAT_INPUT, debit: vatAed },
          { account: ACC.PAYABLES, credit: totalAed },
        ],
      });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "SupplierBill", entityId: bill.id, after: bill }, tx);
      return bill;
    });
  }
}

@Module({ imports: [InventoryModule], controllers: [PurchasingController] })
export class PurchasingModule {}
