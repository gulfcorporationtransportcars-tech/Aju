import { BadRequestException, Injectable } from "@nestjs/common";
import { StockMovementType } from "@luxora/db";
import { BatchPick, BatchStock, d, InsufficientStockError, pickFefo, weightedAverageCost } from "@luxora/shared";
import { Tx } from "../../common/prisma/prisma.service";

export interface ReceiveInput {
  variantId: string;
  warehouseId: string;
  batchNo: string;
  quantity: number;
  unitCostAed: string | number;
  expiresOn?: Date | null;
  manufacturedOn?: Date | null;
  originCountryCode?: string | null;
  supplierId?: string | null;
  goodsReceiptId?: string | null;
  type?: StockMovementType; // PURCHASE_RECEIPT (default), OPENING, CUSTOMER_RETURN, ADJUSTMENT_PLUS
  refType?: string;
  refId?: string;
  reason?: string;
  userId?: string;
}

export interface IssueInput {
  variantId: string;
  picks: BatchPick[];
  type: StockMovementType; // SALE_DELIVERY, WEB_ORDER_DELIVERY, DAMAGE, SAMPLE, TESTER_USE, INFLUENCER_GIFT, ADJUSTMENT_MINUS...
  fromReserved: boolean; // true when the stock was reserved by an order first
  refType?: string;
  refId?: string;
  reason?: string;
  userId?: string;
}

/**
 * The only place that changes stock. Every method needs a transaction (`tx`) and:
 * 1. locks the variant's stock rows (SELECT … FOR UPDATE) so two orders can't take the same bottle,
 * 2. updates StockLevel (current state),
 * 3. appends a StockMovement (permanent history).
 */
@Injectable()
export class StockService {
  /** Lock all stock rows for a variant until the transaction ends. */
  private async lock(tx: Tx, variantId: string) {
    await tx.$queryRaw`SELECT id FROM "StockLevel" WHERE "variantId" = ${variantId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ProductVariant" WHERE id = ${variantId} FOR UPDATE`;
  }

  /** Batches with free stock (on hand − reserved) for FEFO picking. */
  async availableBatches(tx: Tx, variantId: string, warehouseId?: string): Promise<BatchStock[]> {
    const levels = await tx.stockLevel.findMany({
      where: { variantId, warehouseId, warehouse: { isActive: true, type: { not: "IN_TRANSIT" } } },
      include: { batch: true },
    });
    return levels.map((l) => ({
      batchId: l.batchId,
      warehouseId: l.warehouseId,
      available: l.onHand - l.reserved,
      expiresOn: l.batch.expiresOn,
      createdAt: l.batch.createdAt,
    }));
  }

  /** Stock arrives: purchase receipt, opening stock, customer return, positive adjustment. */
  async receive(tx: Tx, input: ReceiveInput) {
    if (input.quantity <= 0) throw new BadRequestException("Quantity must be positive");
    await this.lock(tx, input.variantId);

    const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: input.variantId } });
    const totals = await tx.stockLevel.aggregate({ where: { variantId: input.variantId }, _sum: { onHand: true } });
    const onHandBefore = totals._sum.onHand ?? 0;

    const existing = await tx.batch.findUnique({ where: { variantId_batchNo: { variantId: input.variantId, batchNo: input.batchNo } } });
    const batch = existing
      ? await tx.batch.update({
          where: { id: existing.id },
          data: {
            // same lot received again: keep a weighted cost for the lot
            unitCostAed: weightedAverageCost(
              (await tx.stockLevel.aggregate({ where: { batchId: existing.id }, _sum: { onHand: true } }))._sum.onHand ?? 0,
              existing.unitCostAed.toString(),
              input.quantity,
              input.unitCostAed,
            ).toString(),
            expiresOn: input.expiresOn ?? existing.expiresOn,
          },
        })
      : await tx.batch.create({
          data: {
            variantId: input.variantId,
            batchNo: input.batchNo,
            unitCostAed: d(input.unitCostAed).toString(),
            expiresOn: input.expiresOn ?? null,
            manufacturedOn: input.manufacturedOn ?? null,
            originCountryCode: input.originCountryCode ?? null,
            supplierId: input.supplierId ?? null,
            goodsReceiptId: input.goodsReceiptId ?? null,
          },
        });

    await tx.stockLevel.upsert({
      where: { variantId_warehouseId_batchId: { variantId: input.variantId, warehouseId: input.warehouseId, batchId: batch.id } },
      update: { onHand: { increment: input.quantity } },
      create: { variantId: input.variantId, warehouseId: input.warehouseId, batchId: batch.id, onHand: input.quantity },
    });

    // Customer returns go back at their original cost; they don't change the average.
    if (input.type !== "CUSTOMER_RETURN") {
      await tx.productVariant.update({
        where: { id: input.variantId },
        data: { costAed: weightedAverageCost(onHandBefore, variant.costAed.toString(), input.quantity, input.unitCostAed).toString() },
      });
    }

    return tx.stockMovement.create({
      data: {
        type: input.type ?? "PURCHASE_RECEIPT",
        variantId: input.variantId,
        warehouseId: input.warehouseId,
        batchId: batch.id,
        quantity: input.quantity,
        unitCostAed: d(input.unitCostAed).toString(),
        reason: input.reason,
        refType: input.refType,
        refId: input.refId,
        createdById: input.userId,
      },
    });
  }

  /** Hold stock for a confirmed order (wholesale, B2B portal or web shop), picking FEFO. */
  async reserve(tx: Tx, variantId: string, quantity: number, warehouseId?: string): Promise<BatchPick[]> {
    await this.lock(tx, variantId);
    const picks = pickFefo(await this.availableBatches(tx, variantId, warehouseId), quantity);
    for (const p of picks) {
      await tx.stockLevel.update({
        where: { variantId_warehouseId_batchId: { variantId, warehouseId: p.warehouseId, batchId: p.batchId } },
        data: { reserved: { increment: p.quantity } },
      });
    }
    return picks;
  }

  /** Give reserved stock back (order cancelled or changed). */
  async release(tx: Tx, variantId: string, picks: BatchPick[]) {
    await this.lock(tx, variantId);
    for (const p of picks) {
      const level = await tx.stockLevel.findUniqueOrThrow({
        where: { variantId_warehouseId_batchId: { variantId, warehouseId: p.warehouseId, batchId: p.batchId } },
      });
      if (level.reserved < p.quantity) throw new BadRequestException("Cannot release more than is reserved");
      await tx.stockLevel.update({ where: { id: level.id }, data: { reserved: { decrement: p.quantity } } });
    }
  }

  /** Stock leaves: delivery, damage, sample, tester, influencer gift, negative adjustment. */
  async issue(tx: Tx, input: IssueInput) {
    await this.lock(tx, input.variantId);
    const movements = [];
    for (const p of input.picks) {
      const level = await tx.stockLevel.findUnique({
        where: { variantId_warehouseId_batchId: { variantId: input.variantId, warehouseId: p.warehouseId, batchId: p.batchId } },
        include: { batch: true },
      });
      if (!level) throw new InsufficientStockError(p.quantity, 0);
      const free = input.fromReserved ? level.onHand : level.onHand - level.reserved;
      if (free < p.quantity) throw new InsufficientStockError(p.quantity, free);
      if (input.fromReserved && level.reserved < p.quantity) throw new BadRequestException("Stock was not reserved for this order");

      await tx.stockLevel.update({
        where: { id: level.id },
        data: { onHand: { decrement: p.quantity }, ...(input.fromReserved ? { reserved: { decrement: p.quantity } } : {}) },
      });
      movements.push(
        await tx.stockMovement.create({
          data: {
            type: input.type,
            variantId: input.variantId,
            warehouseId: p.warehouseId,
            batchId: p.batchId,
            quantity: -p.quantity,
            unitCostAed: level.batch.unitCostAed,
            reason: input.reason,
            refType: input.refType,
            refId: input.refId,
            createdById: input.userId,
          },
        }),
      );
    }
    return movements;
  }

  /** Move free stock of one batch between warehouses. */
  async transfer(
    tx: Tx,
    input: { variantId: string; batchId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; userId?: string; reason?: string },
  ) {
    if (input.fromWarehouseId === input.toWarehouseId) throw new BadRequestException("Choose two different warehouses");
    const refId = `TRF-${Date.now()}`;
    const [out] = await this.issue(tx, {
      variantId: input.variantId,
      picks: [{ batchId: input.batchId, warehouseId: input.fromWarehouseId, quantity: input.quantity }],
      type: "TRANSFER_OUT",
      fromReserved: false,
      refType: "Transfer",
      refId,
      reason: input.reason,
      userId: input.userId,
    });
    await tx.stockLevel.upsert({
      where: { variantId_warehouseId_batchId: { variantId: input.variantId, warehouseId: input.toWarehouseId, batchId: input.batchId } },
      update: { onHand: { increment: input.quantity } },
      create: { variantId: input.variantId, warehouseId: input.toWarehouseId, batchId: input.batchId, onHand: input.quantity },
    });
    const into = await tx.stockMovement.create({
      data: {
        type: "TRANSFER_IN",
        variantId: input.variantId,
        warehouseId: input.toWarehouseId,
        batchId: input.batchId,
        quantity: input.quantity,
        unitCostAed: out.unitCostAed,
        refType: "Transfer",
        refId,
        reason: input.reason,
        createdById: input.userId,
      },
    });
    return { out, into };
  }
}
