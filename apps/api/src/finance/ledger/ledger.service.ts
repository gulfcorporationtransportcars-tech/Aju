import { BadRequestException, Global, Injectable, Module } from "@nestjs/common";
import { JournalSource, StockMovement, StockMovementType } from "@luxora/db";
import { d, Decimal, round2, sum } from "@luxora/shared";
import { Tx } from "../../common/prisma/prisma.service";
import { NumberingService } from "../../core/numbering/numbering.service";
import { ACC } from "./accounts";

export interface PostingLine {
  account: string; // account code, e.g. "1100"
  debit?: Decimal.Value;
  credit?: Decimal.Value;
  description?: string;
  brandId?: string | null;
  customerId?: string | null;
  campaignId?: string | null;
  adClientId?: string | null;
}

export interface PostingInput {
  date?: Date;
  source: JournalSource;
  refType?: string;
  refId?: string;
  memo?: string;
  userId?: string | null;
  lines: PostingLine[];
}

/** Debit / credit account for each kind of stock movement (value = qty × unit cost). */
const STOCK_POSTING: Partial<Record<StockMovementType, { in: [string, string]; out: [string, string] }>> = {
  OPENING: { in: [ACC.INVENTORY, ACC.OPENING_EQUITY], out: [ACC.OPENING_EQUITY, ACC.INVENTORY] },
  PURCHASE_RECEIPT: { in: [ACC.INVENTORY, ACC.GRNI], out: [ACC.GRNI, ACC.INVENTORY] },
  SUPPLIER_RETURN: { in: [ACC.INVENTORY, ACC.GRNI], out: [ACC.GRNI, ACC.INVENTORY] },
  SALE_DELIVERY: { in: [ACC.INVENTORY, ACC.COGS], out: [ACC.COGS, ACC.INVENTORY] },
  WEB_ORDER_DELIVERY: { in: [ACC.INVENTORY, ACC.COGS], out: [ACC.COGS, ACC.INVENTORY] },
  CUSTOMER_RETURN: { in: [ACC.INVENTORY, ACC.COGS], out: [ACC.COGS, ACC.INVENTORY] },
  ADJUSTMENT_PLUS: { in: [ACC.INVENTORY, ACC.WRITE_OFFS], out: [ACC.WRITE_OFFS, ACC.INVENTORY] },
  ADJUSTMENT_MINUS: { in: [ACC.INVENTORY, ACC.WRITE_OFFS], out: [ACC.WRITE_OFFS, ACC.INVENTORY] },
  DAMAGE: { in: [ACC.INVENTORY, ACC.WRITE_OFFS], out: [ACC.WRITE_OFFS, ACC.INVENTORY] },
  STOCK_TAKE: { in: [ACC.INVENTORY, ACC.WRITE_OFFS], out: [ACC.WRITE_OFFS, ACC.INVENTORY] },
  SAMPLE: { in: [ACC.INVENTORY, ACC.SAMPLES_TESTERS], out: [ACC.SAMPLES_TESTERS, ACC.INVENTORY] },
  TESTER_USE: { in: [ACC.INVENTORY, ACC.SAMPLES_TESTERS], out: [ACC.SAMPLES_TESTERS, ACC.INVENTORY] },
  INFLUENCER_GIFT: { in: [ACC.INVENTORY, ACC.INFLUENCER_GIFTS], out: [ACC.INFLUENCER_GIFTS, ACC.INVENTORY] },
  // TRANSFER_IN / TRANSFER_OUT: same company, same value, no posting
};

/**
 * Double-entry bookkeeping. Every posting must balance (debits = credits, in AED).
 * Entries are never edited; `reverse()` creates the opposite entry.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly numbering: NumberingService) {}

  async post(tx: Tx, input: PostingInput) {
    const lines = input.lines
      .map((l) => ({ ...l, debit: round2(l.debit ?? 0), credit: round2(l.credit ?? 0) }))
      .filter((l) => !l.debit.isZero() || !l.credit.isZero());
    if (lines.length === 0) return null;
    if (lines.some((l) => l.debit.isNegative() || l.credit.isNegative())) throw new BadRequestException("Journal amounts cannot be negative");

    const debits = sum(lines.map((l) => l.debit));
    const credits = sum(lines.map((l) => l.credit));
    if (!debits.equals(credits)) throw new BadRequestException(`Journal does not balance: debit ${debits} ≠ credit ${credits}`);

    const codes = [...new Set(lines.map((l) => l.account))];
    const accounts = await tx.account.findMany({ where: { code: { in: codes } } });
    const idOf = new Map(accounts.map((a) => [a.code, a.id]));
    const missing = codes.filter((c) => !idOf.has(c));
    if (missing.length) throw new BadRequestException(`Unknown account(s): ${missing.join(", ")}`);

    return tx.journalEntry.create({
      data: {
        number: await this.numbering.next("JE", tx),
        date: input.date ?? new Date(),
        source: input.source,
        refType: input.refType,
        refId: input.refId,
        memo: input.memo,
        createdById: input.userId ?? null,
        lines: {
          create: lines.map((l) => ({
            accountId: idOf.get(l.account)!,
            debit: l.debit.toString(),
            credit: l.credit.toString(),
            description: l.description,
            brandId: l.brandId ?? null,
            customerId: l.customerId ?? null,
            campaignId: l.campaignId ?? null,
            adClientId: l.adClientId ?? null,
          })),
        },
      },
      include: { lines: true },
    });
  }

  async reverse(tx: Tx, journalEntryId: string, userId: string | null, memo?: string) {
    const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId }, include: { lines: { include: { account: true } }, reversedBy: true } });
    if (je.reversedBy) throw new BadRequestException(`${je.number} is already reversed`);
    if (je.reversalOfId) throw new BadRequestException("A reversal cannot itself be reversed");
    const entry = await this.post(tx, {
      source: je.source,
      refType: je.refType ?? undefined,
      refId: je.refId ?? undefined,
      memo: memo ?? `Reversal of ${je.number}`,
      userId,
      lines: je.lines.map((l) => ({ account: l.account.code, debit: l.credit.toString(), credit: l.debit.toString(), description: l.description ?? undefined, brandId: l.brandId, customerId: l.customerId, campaignId: l.campaignId, adClientId: l.adClientId })),
    });
    return tx.journalEntry.update({ where: { id: entry!.id }, data: { reversalOfId: je.id } });
  }

  /** Post the value of stock movements (write-offs, samples, COGS, opening stock...). */
  async postStockMovements(tx: Tx, movements: StockMovement[], meta: { source: JournalSource; refType?: string; refId?: string; memo?: string; userId?: string | null; customerId?: string | null }) {
    const lines: PostingLine[] = [];
    for (const m of movements) {
      const rule = STOCK_POSTING[m.type];
      if (!rule) continue;
      const value = round2(d(m.unitCostAed.toString()).times(Math.abs(m.quantity)));
      const [dr, cr] = m.quantity > 0 ? rule.in : rule.out;
      lines.push({ account: dr, debit: value, customerId: meta.customerId }, { account: cr, credit: value, customerId: meta.customerId });
    }
    return this.post(tx, { ...meta, lines });
  }
}

@Global()
@Module({ providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
