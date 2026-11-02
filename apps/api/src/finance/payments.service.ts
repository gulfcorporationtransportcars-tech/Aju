import { BadRequestException, Injectable } from "@nestjs/common";
import { PaymentDirection, PaymentMethod } from "@luxora/db";
import { d, Decimal, sum, toAed } from "@luxora/shared";
import { Tx } from "../common/prisma/prisma.service";
import { AuditService } from "../core/audit/audit.service";
import { NumberingService } from "../core/numbering/numbering.service";
import { SalesService } from "../sales/sales.service";
import { invoiceBalance } from "../sales/crm.controller";
import { ACC } from "./ledger/accounts";
import { LedgerService, PostingLine } from "./ledger/ledger.service";

export interface PaymentInput {
  direction: PaymentDirection;
  method: PaymentMethod;
  date?: Date;
  amount: string;
  currencyCode?: string;
  exchangeRate?: string;
  customerId?: string;
  supplierId?: string;
  adClientId?: string;
  bankAccountId?: string;
  reference?: string;
  notes?: string;
  allocations?: { invoiceId?: string; supplierBillId?: string; amount: string }[];
  autoAllocate?: boolean; // oldest open invoices first
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Record money in or out and allocate it to invoices / supplier bills.
   * Received: Dr bank/cash, Cr receivables (allocated) + Cr customer advances (unallocated).
   * Made:     Dr payables (allocated) + Dr prepayments (unallocated), Cr bank/cash.
   */
  async record(tx: Tx, input: PaymentInput, userId: string) {
    const rate = input.exchangeRate ?? "1";
    const amount = d(input.amount);
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException("Amount must be positive");
    const isIn = input.direction === "RECEIVED";
    if (isIn && !input.customerId && !input.adClientId) throw new BadRequestException("Choose the customer or ad client who paid");
    if (!isIn && !input.supplierId) throw new BadRequestException("Choose the supplier being paid");

    let allocations = input.allocations ?? [];
    if (input.autoAllocate && allocations.length === 0 && isIn) {
      const open = await tx.invoice.findMany({
        where: { customerId: input.customerId, adClientId: input.adClientId, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } },
        orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
      });
      let left = amount;
      allocations = [];
      for (const inv of open) {
        if (left.lessThanOrEqualTo(0)) break;
        const take = Decimal.min(left, invoiceBalance(inv));
        if (take.greaterThan(0)) allocations.push({ invoiceId: inv.id, amount: take.toString() });
        left = left.minus(take);
      }
    }
    const allocated = sum(allocations.map((a) => a.amount));
    if (allocated.greaterThan(amount)) throw new BadRequestException("Allocations are more than the payment");

    // Validate every allocation belongs to this party and is not more than what is open
    for (const a of allocations) {
      if (a.invoiceId) {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
        if (inv.customerId !== (input.customerId ?? null) && inv.adClientId !== (input.adClientId ?? null)) throw new BadRequestException(`${inv.number} belongs to another customer`);
        if (d(a.amount).greaterThan(invoiceBalance(inv))) throw new BadRequestException(`${inv.number} has only ${invoiceBalance(inv).toFixed(2)} open`);
      } else if (a.supplierBillId) {
        const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: a.supplierBillId } });
        if (bill.supplierId !== input.supplierId) throw new BadRequestException(`${bill.number} belongs to another supplier`);
        if (d(a.amount).greaterThan(d(bill.total.toString()).minus(bill.amountPaid.toString()))) throw new BadRequestException(`${bill.number} is over-allocated`);
      } else throw new BadRequestException("Each allocation needs an invoice or a supplier bill");
    }

    const bank = input.bankAccountId ? await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId }, include: { account: true } }) : null;
    if (!bank && input.method !== "CASH" && input.method !== "CASH_ON_DELIVERY") throw new BadRequestException("Choose the bank account");
    const moneyAccount = bank?.account.code ?? ACC.CASH;

    const amountAed = toAed(amount, rate);
    const payment = await tx.payment.create({
      data: {
        number: await this.numbering.next("PAY", tx, input.date),
        direction: input.direction,
        method: input.method,
        date: input.date ?? new Date(),
        amount: amount.toString(),
        currencyCode: input.currencyCode ?? "AED",
        exchangeRate: rate,
        amountAed: amountAed.toString(),
        customerId: input.customerId,
        supplierId: input.supplierId,
        adClientId: input.adClientId,
        bankAccountId: bank?.id,
        reference: input.reference,
        notes: input.notes,
        allocations: { create: allocations.map((a) => ({ invoiceId: a.invoiceId, supplierBillId: a.supplierBillId, amount: a.amount })) },
      },
      include: { allocations: true },
    });

    for (const a of allocations) {
      if (a.invoiceId) {
        await tx.invoice.update({ where: { id: a.invoiceId }, data: { amountPaid: { increment: a.amount } } });
        await this.sales.refreshInvoiceStatus(tx, a.invoiceId);
      } else if (a.supplierBillId) {
        const bill = await tx.supplierBill.update({ where: { id: a.supplierBillId }, data: { amountPaid: { increment: a.amount } } });
        const paid = d(bill.amountPaid.toString()).greaterThanOrEqualTo(bill.total.toString());
        await tx.supplierBill.update({ where: { id: bill.id }, data: { status: paid ? "PAID" : "PARTIALLY_PAID" } });
      }
    }

    const allocatedAed = toAed(allocated, rate);
    const unallocatedAed = amountAed.minus(allocatedAed);
    const party = { customerId: input.customerId, adClientId: input.adClientId };
    const lines: PostingLine[] = isIn
      ? [
          { account: moneyAccount, debit: amountAed, ...party },
          { account: ACC.RECEIVABLES, credit: allocatedAed, ...party },
          { account: ACC.CUSTOMER_ADVANCES, credit: unallocatedAed, ...party },
        ]
      : [
          { account: ACC.PAYABLES, debit: allocatedAed },
          { account: "1400", debit: unallocatedAed },
          { account: moneyAccount, credit: amountAed },
        ];
    await this.ledger.post(tx, {
      date: payment.date,
      source: isIn ? "PAYMENT_RECEIVED" : "PAYMENT_MADE",
      refType: "Payment",
      refId: payment.id,
      memo: `${payment.number} ${input.method}${input.reference ? ` ${input.reference}` : ""}`,
      userId,
      lines,
    });
    await this.audit.log({ userId, action: "CREATE", entityType: "Payment", entityId: payment.id, after: payment }, tx);
    return payment;
  }
}
