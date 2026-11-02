export interface BatchStock {
  batchId: string;
  warehouseId: string;
  available: number; // onHand − reserved
  expiresOn: Date | null;
  createdAt: Date;
}

export interface BatchPick {
  batchId: string;
  warehouseId: string;
  quantity: number;
}

export class InsufficientStockError extends Error {
  constructor(public readonly requested: number, public readonly available: number) {
    super(`Insufficient stock: requested ${requested}, available ${available}`);
  }
}

/**
 * First-Expiry-First-Out: pick from the batch that expires soonest. Batches with no
 * expiry date go last; ties are broken by oldest receipt (FIFO).
 */
export function pickFefo(batches: BatchStock[], quantity: number): BatchPick[] {
  if (quantity <= 0) return [];
  const sorted = batches
    .filter((b) => b.available > 0)
    .sort((a, b) => {
      const ea = a.expiresOn?.getTime() ?? Number.POSITIVE_INFINITY;
      const eb = b.expiresOn?.getTime() ?? Number.POSITIVE_INFINITY;
      return ea !== eb ? ea - eb : a.createdAt.getTime() - b.createdAt.getTime();
    });

  const total = sorted.reduce((s, b) => s + b.available, 0);
  if (total < quantity) throw new InsufficientStockError(quantity, total);

  const picks: BatchPick[] = [];
  let remaining = quantity;
  for (const b of sorted) {
    if (remaining === 0) break;
    const take = Math.min(b.available, remaining);
    picks.push({ batchId: b.batchId, warehouseId: b.warehouseId, quantity: take });
    remaining -= take;
  }
  return picks;
}
