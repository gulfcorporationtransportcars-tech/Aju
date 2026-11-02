import { BadRequestException, Body, Controller, Get, HttpCode, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query } from "@nestjs/common";
import { ApprovalRequest, Prisma } from "@luxora/db";
import { d, PERMISSIONS, sum } from "@luxora/shared";
import { randomUUID } from "crypto";
import { z } from "zod";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../../common/auth/decorators";
import { Money, PageQuery, skipTake, toPage } from "../../common/http/pagination";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService, Tx } from "../../common/prisma/prisma.service";
import { ApprovalsService } from "../../core/approvals/approvals.service";
import { AuditService } from "../../core/audit/audit.service";
import { NumberingService } from "../../core/numbering/numbering.service";
import { LedgerService } from "../../finance/ledger/ledger.service";
import { StockService } from "./stock.service";

const WarehouseBody = z.object({
  code: z.string().min(2).toUpperCase(),
  name: z.string().min(1),
  type: z.enum(["OWN", "THIRD_PARTY", "IN_TRANSIT", "SHOWROOM"]).default("OWN"),
  address: z.string().optional(),
  emirate: z.string().optional(),
  isActive: z.boolean().optional(),
});

const StockQuery = PageQuery.extend({
  warehouseId: z.string().optional(),
  brandId: z.string().optional(),
  lowStock: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

const MovementQuery = PageQuery.extend({
  variantId: z.string().optional(),
  warehouseId: z.string().optional(),
  type: z.string().optional(),
  refType: z.string().optional(),
  refId: z.string().optional(),
});

const OpeningStockBody = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.string(),
        warehouseId: z.string(),
        batchNo: z.string().min(1),
        quantity: z.number().int().positive(),
        unitCostAed: Money,
        expiresOn: z.coerce.date().optional(),
      }),
    )
    .min(1),
});

const ADJUSTMENT_TYPES = ["ADJUSTMENT_PLUS", "ADJUSTMENT_MINUS", "DAMAGE", "SAMPLE", "TESTER_USE"] as const;
const AdjustmentBody = z.object({
  variantId: z.string(),
  warehouseId: z.string(),
  batchId: z.string(),
  type: z.enum(ADJUSTMENT_TYPES),
  quantity: z.number().int().positive(),
  reason: z.string().min(3, "Please give a reason"),
});
type AdjustmentBody = z.infer<typeof AdjustmentBody>;

const TransferBody = z.object({
  variantId: z.string(),
  batchId: z.string(),
  fromWarehouseId: z.string(),
  toWarehouseId: z.string(),
  quantity: z.number().int().positive(),
  reason: z.string().optional(),
});

const CountsBody = z.object({ lines: z.array(z.object({ lineId: z.string(), countedQty: z.number().int().min(0) })).min(1) });

const VARIANT_LABEL = { select: { id: true, sku: true, sizeMl: true, packType: true, reorderLevel: true, product: { select: { nameEn: true, brand: { select: { name: true } } } } } } as const;

@Controller("inventory")
export class InventoryController implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit() {
    // Stock adjustments and write-offs are applied only after Manager approval.
    this.approvals.registerHandler("StockAdjustment", {
      onApproved: (tx, req, deciderId) => this.applyAdjustment(tx, req, deciderId),
    });
    this.approvals.registerHandler("StockTake", {
      onApproved: (tx, req, deciderId) => this.applyStockTake(tx, req.entityId, deciderId),
      onRejected: async (tx, req) => {
        await tx.stockTake.update({ where: { id: req.entityId }, data: { status: "COUNTING" } });
      },
    });
  }

  // ---------- Warehouses ----------
  @Get("warehouses")
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  warehouses() {
    return this.prisma.warehouse.findMany({ orderBy: { code: "asc" } });
  }

  @Post("warehouses")
  @RequirePermissions(PERMISSIONS.WAREHOUSE_MANAGE)
  createWarehouse(@Body(zod(WarehouseBody)) body: z.infer<typeof WarehouseBody>) {
    return this.prisma.warehouse.create({ data: body });
  }

  @Patch("warehouses/:id")
  @RequirePermissions(PERMISSIONS.WAREHOUSE_MANAGE)
  updateWarehouse(@Param("id") id: string, @Body(zod(WarehouseBody.partial())) body: Partial<z.infer<typeof WarehouseBody>>) {
    return this.prisma.warehouse.update({ where: { id }, data: body });
  }

  // ---------- Stock levels ----------
  /** Stock per variant: on hand, reserved, available; `lowStock=true` lists items at or below reorder level. */
  @Get("stock")
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  async stockList(@Query(zod(StockQuery)) q: z.infer<typeof StockQuery>) {
    const where: Prisma.ProductVariantWhereInput = {
      isActive: true,
      product: { brandId: q.brandId },
      ...(q.q ? { OR: [{ sku: { contains: q.q, mode: "insensitive" } }, { barcode: q.q }, { product: { nameEn: { contains: q.q, mode: "insensitive" } } }] } : {}),
      ...(q.lowStock ? { reorderLevel: { gt: 0 } } : {}),
    };
    const select = { ...VARIANT_LABEL.select, stockLevels: { where: { warehouseId: q.warehouseId }, select: { onHand: true, reserved: true } } };
    const toRow = (v: Prisma.ProductVariantGetPayload<{ select: typeof select }>) => {
      const onHand = v.stockLevels.reduce((s, l) => s + l.onHand, 0);
      const reserved = v.stockLevels.reduce((s, l) => s + l.reserved, 0);
      const { stockLevels: _s, ...rest } = v;
      return { ...rest, onHand, reserved, available: onHand - reserved, isLow: v.reorderLevel > 0 && onHand - reserved <= v.reorderLevel };
    };

    if (q.lowStock) {
      // Low stock depends on computed totals, so filter before paging.
      const rows = (await this.prisma.productVariant.findMany({ where, select, orderBy: { sku: "asc" } })).map(toRow).filter((r) => r.isLow);
      const { skip, take } = skipTake(q);
      return toPage(rows.slice(skip, skip + take), rows.length, q);
    }
    const [items, total] = await Promise.all([
      this.prisma.productVariant.findMany({ where, select, orderBy: { sku: "asc" }, ...skipTake(q) }),
      this.prisma.productVariant.count({ where }),
    ]);
    return toPage(items.map(toRow), total, q);
  }

  /** One variant: stock by warehouse and batch, with expiry dates. */
  @Get("stock/:variantId")
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  async stockDetail(@Param("variantId") variantId: string) {
    const variant = await this.prisma.productVariant.findUnique({ where: { id: variantId }, ...VARIANT_LABEL });
    if (!variant) throw new NotFoundException();
    const levels = await this.prisma.stockLevel.findMany({
      where: { variantId, onHand: { gt: 0 } },
      include: { warehouse: { select: { code: true, name: true } }, batch: { select: { batchNo: true, expiresOn: true, authenticityVerified: true } } },
      orderBy: [{ batch: { expiresOn: "asc" } }],
    });
    return {
      variant,
      onHand: levels.reduce((s, l) => s + l.onHand, 0),
      reserved: levels.reduce((s, l) => s + l.reserved, 0),
      levels: levels.map((l) => ({ ...l, available: l.onHand - l.reserved })),
    };
  }

  @Get("movements")
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  async movements(@Query(zod(MovementQuery)) q: z.infer<typeof MovementQuery>) {
    const where: Prisma.StockMovementWhereInput = {
      variantId: q.variantId,
      warehouseId: q.warehouseId,
      type: q.type as Prisma.StockMovementWhereInput["type"],
      refType: q.refType,
      refId: q.refId,
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: { variant: VARIANT_LABEL, warehouse: { select: { code: true } }, batch: { select: { batchNo: true } }, createdBy: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        ...skipTake(q),
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  /** Batches in stock that expire within `days` (default 90). */
  @Get("expiring")
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  async expiring(@Query(zod(z.object({ days: z.coerce.number().int().min(0).max(3650).default(90) }))) q: { days: number }) {
    const until = new Date(Date.now() + q.days * 86_400_000);
    return this.prisma.stockLevel.findMany({
      where: { onHand: { gt: 0 }, batch: { expiresOn: { lte: until } } },
      include: { variant: VARIANT_LABEL, warehouse: { select: { code: true } }, batch: { select: { batchNo: true, expiresOn: true } } },
      orderBy: { batch: { expiresOn: "asc" } },
    });
  }

  // ---------- Stock in / out ----------
  /** Opening stock when moving to LUXORA Hub (no approval: it is the starting point). */
  @Post("opening-stock")
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  async openingStock(@CurrentUser() me: AuthUser, @Body(zod(OpeningStockBody)) body: z.infer<typeof OpeningStockBody>) {
    return this.prisma.$transaction(async (tx) => {
      const movements = [];
      for (const line of body.lines) {
        movements.push(await this.stock.receive(tx, { ...line, type: "OPENING", refType: "OpeningStock", reason: "Opening stock", userId: me.id }));
      }
      await this.ledger.postStockMovements(tx, movements, { source: "OPENING", refType: "OpeningStock", memo: "Opening stock", userId: me.id });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "OpeningStock", after: body }, tx);
      return { count: movements.length };
    });
  }

  /** Request a stock adjustment. It is applied when the Manager approves (STOCK_WRITE_OFF). */
  @Post("adjustments")
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @HttpCode(202)
  async requestAdjustment(@CurrentUser() me: AuthUser, @Body(zod(AdjustmentBody)) body: AdjustmentBody) {
    const level = await this.prisma.stockLevel.findUnique({
      where: { variantId_warehouseId_batchId: { variantId: body.variantId, warehouseId: body.warehouseId, batchId: body.batchId } },
      include: { batch: true, variant: VARIANT_LABEL },
    });
    if (!level) throw new BadRequestException("This batch has no stock in this warehouse");
    const isMinus = body.type !== "ADJUSTMENT_PLUS";
    if (isMinus && level.onHand - level.reserved < body.quantity) {
      throw new BadRequestException(`Only ${level.onHand - level.reserved} unit(s) free to adjust (others are reserved for orders)`);
    }
    const valueAed = d(level.batch.unitCostAed).times(body.quantity).toNumber();
    const label = `${level.variant.product.brand.name} ${level.variant.product.nameEn} (${level.variant.sku})`;
    const approval = await this.approvals.request({
      type: "STOCK_WRITE_OFF",
      entityType: "StockAdjustment",
      entityId: randomUUID(),
      title: `${body.type.replace(/_/g, " ").toLowerCase()} ${isMinus ? "−" : "+"}${body.quantity} × ${label}, batch ${level.batch.batchNo}`,
      details: { ...body, unitCostAed: level.batch.unitCostAed.toString() },
      amountAed: valueAed,
      requestedById: me.id,
    });
    return { status: approval.status === "APPROVED" ? "APPLIED" : "PENDING_APPROVAL", approval };
  }

  @Post("transfers")
  @RequirePermissions(PERMISSIONS.INVENTORY_MOVE)
  async transfer(@CurrentUser() me: AuthUser, @Body(zod(TransferBody)) body: z.infer<typeof TransferBody>) {
    return this.prisma.$transaction(async (tx) => {
      const res = await this.stock.transfer(tx, { ...body, userId: me.id });
      await this.audit.log({ userId: me.id, action: "TRANSFER", entityType: "StockMovement", entityId: res.out.refId, after: body }, tx);
      return res;
    });
  }

  // ---------- Stock-take ----------
  /** Start a count: snapshot the system quantity of every batch in the warehouse. */
  @Post("stock-takes")
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  async startStockTake(@CurrentUser() me: AuthUser, @Body(zod(z.object({ warehouseId: z.string(), notes: z.string().optional() }))) body: { warehouseId: string; notes?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const levels = await tx.stockLevel.findMany({ where: { warehouseId: body.warehouseId, onHand: { gt: 0 } }, include: { batch: true } });
      return tx.stockTake.create({
        data: {
          number: await this.numbering.next("STK", tx),
          warehouseId: body.warehouseId,
          status: "COUNTING",
          countedById: me.id,
          notes: body.notes,
          lines: { create: levels.map((l) => ({ variantId: l.variantId, batchNo: l.batch.batchNo, systemQty: l.onHand })) },
        },
        include: { lines: true },
      });
    });
  }

  @Get("stock-takes/:id")
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  stockTake(@Param("id") id: string) {
    return this.prisma.stockTake.findUniqueOrThrow({ where: { id }, include: { lines: { include: { variant: VARIANT_LABEL } }, warehouse: true } });
  }

  @Patch("stock-takes/:id/counts")
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  async saveCounts(@Param("id") id: string, @Body(zod(CountsBody)) body: z.infer<typeof CountsBody>) {
    const st = await this.prisma.stockTake.findUniqueOrThrow({ where: { id } });
    if (st.status !== "COUNTING") throw new BadRequestException("This count is no longer open");
    await this.prisma.$transaction(
      body.lines.map((l) => this.prisma.stockTakeLine.updateMany({ where: { id: l.lineId, stockTakeId: id }, data: { countedQty: l.countedQty } })),
    );
    return { ok: true };
  }

  /** Submit the count. Differences are applied once the Manager approves. */
  @Post("stock-takes/:id/submit")
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @HttpCode(202)
  async submitStockTake(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    return this.prisma.$transaction(async (tx) => {
      const st = await tx.stockTake.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (st.status !== "COUNTING") throw new BadRequestException("This count is not open");
      if (st.lines.some((l) => l.countedQty == null)) throw new BadRequestException("Every line needs a counted quantity");
      const diffs = st.lines.filter((l) => l.countedQty !== l.systemQty);
      await tx.stockTake.update({ where: { id }, data: { status: "SUBMITTED" } });

      const batches = await tx.batch.findMany({ where: { OR: diffs.map((l) => ({ variantId: l.variantId, batchNo: l.batchNo! })) } });
      const valueAed = sum(
        diffs.map((l) => {
          const b = batches.find((x) => x.variantId === l.variantId && x.batchNo === l.batchNo);
          return d(b?.unitCostAed.toString() ?? 0).times(Math.abs(l.countedQty! - l.systemQty));
        }),
      ).toNumber();
      const approval = await this.approvals.request(
        {
          type: "STOCK_WRITE_OFF",
          entityType: "StockTake",
          entityId: id,
          title: `Stock-take ${st.number}: ${diffs.length} difference(s)`,
          details: { differences: diffs.map((l) => ({ variantId: l.variantId, batchNo: l.batchNo, systemQty: l.systemQty, countedQty: l.countedQty })) },
          amountAed: valueAed,
          requestedById: me.id,
        },
        tx,
      );
      return { status: approval.status === "APPROVED" ? "APPLIED" : "PENDING_APPROVAL", differences: diffs.length, valueAed, approval };
    });
  }

  // ---------- Approval handlers ----------
  private async applyAdjustment(tx: Tx, req: ApprovalRequest, deciderId: string) {
    const a = req.details as unknown as AdjustmentBody & { unitCostAed: string };
    const common = { refType: "StockAdjustment", refId: req.entityId, reason: a.reason, userId: deciderId };
    if (a.type === "ADJUSTMENT_PLUS") {
      const batch = await tx.batch.findUniqueOrThrow({ where: { id: a.batchId } });
      const mv = await this.stock.receive(tx, { ...common, variantId: a.variantId, warehouseId: a.warehouseId, batchNo: batch.batchNo, quantity: a.quantity, unitCostAed: a.unitCostAed, type: "ADJUSTMENT_PLUS" });
      await this.ledger.postStockMovements(tx, [mv], { source: "STOCK_ADJUSTMENT", refType: "StockAdjustment", refId: req.entityId, memo: a.reason, userId: deciderId });
    } else {
      const mvs = await this.stock.issue(tx, {
        ...common,
        variantId: a.variantId,
        picks: [{ batchId: a.batchId, warehouseId: a.warehouseId, quantity: a.quantity }],
        type: a.type,
        fromReserved: false,
      });
      await this.ledger.postStockMovements(tx, mvs, { source: "STOCK_ADJUSTMENT", refType: "StockAdjustment", refId: req.entityId, memo: a.reason, userId: deciderId });
    }
  }

  private async applyStockTake(tx: Tx, stockTakeId: string, deciderId: string) {
    const st = await tx.stockTake.findUniqueOrThrow({ where: { id: stockTakeId }, include: { lines: true } });
    const movements = [];
    for (const l of st.lines) {
      const diff = (l.countedQty ?? l.systemQty) - l.systemQty;
      if (diff === 0) continue;
      const batch = await tx.batch.findUniqueOrThrow({ where: { variantId_batchNo: { variantId: l.variantId, batchNo: l.batchNo! } } });
      const common = { refType: "StockTake", refId: st.id, reason: `Stock-take ${st.number}`, userId: deciderId };
      if (diff > 0) {
        movements.push(await this.stock.receive(tx, { ...common, variantId: l.variantId, warehouseId: st.warehouseId, batchNo: batch.batchNo, quantity: diff, unitCostAed: batch.unitCostAed.toString(), type: "STOCK_TAKE" }));
      } else {
        movements.push(...(await this.stock.issue(tx, { ...common, variantId: l.variantId, picks: [{ batchId: batch.id, warehouseId: st.warehouseId, quantity: -diff }], type: "STOCK_TAKE", fromReserved: false })));
      }
    }
    await this.ledger.postStockMovements(tx, movements, { source: "STOCK_ADJUSTMENT", refType: "StockTake", refId: st.id, memo: `Stock-take ${st.number}`, userId: deciderId });
    await tx.stockTake.update({ where: { id: st.id }, data: { status: "APPROVED", completedAt: new Date() } });
  }
}

@Module({ providers: [StockService], controllers: [InventoryController], exports: [StockService] })
export class InventoryModule {}
