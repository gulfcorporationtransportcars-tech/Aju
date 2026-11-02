import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { d, PERMISSIONS, round2 } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../common/auth/decorators";
import { Money, PageQuery, skipTake, toPage } from "../common/http/pagination";
import { zod } from "../common/http/zod.pipe";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditService } from "../core/audit/audit.service";
import { NotificationsService } from "../core/notifications/notifications.service";
import { NumberingService } from "../core/numbering/numbering.service";
import { ACC } from "./ledger/accounts";
import { LedgerService } from "./ledger/ledger.service";
import { PaymentsService } from "./payments.service";

const Rate = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,6})?$/)]).transform(String);

const AccountBody = z.object({ code: z.string().regex(/^\d{4}$/), name: z.string().min(1), type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]), parentId: z.string().optional() });

const JournalBody = z.object({
  date: z.coerce.date(),
  memo: z.string().min(3),
  lines: z.array(z.object({ account: z.string(), debit: Money.optional(), credit: Money.optional(), description: z.string().optional() })).min(2),
});

const BankBody = z.object({
  code: z.string().regex(/^10\d{2}$/, "Bank ledger codes are 1011–1049"),
  bankName: z.string().min(1),
  accountName: z.string().min(1),
  accountNo: z.string().optional(),
  iban: z.string().regex(/^AE\d{21}$/, "UAE IBAN: AE + 21 digits").optional(),
  swift: z.string().optional(),
  currencyCode: z.string().length(3).default("AED"),
});

const PaymentBody = z.object({
  direction: z.enum(["RECEIVED", "MADE"]),
  method: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD", "ONLINE_GATEWAY", "CASH_ON_DELIVERY"]),
  date: z.coerce.date().optional(),
  amount: Money,
  currencyCode: z.string().length(3).default("AED"),
  exchangeRate: Rate.default("1"),
  customerId: z.string().optional(),
  supplierId: z.string().optional(),
  adClientId: z.string().optional(),
  bankAccountId: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  allocations: z.array(z.object({ invoiceId: z.string().optional(), supplierBillId: z.string().optional(), amount: Money })).default([]),
  autoAllocate: z.boolean().default(false),
});

const PdcBody = z.object({
  customerId: z.string(),
  chequeNo: z.string().min(1),
  bankName: z.string().min(1),
  chequeDate: z.coerce.date(),
  amount: Money,
  imageUrl: z.string().url().optional(),
  notes: z.string().optional(),
});

const ExpenseBody = z.object({
  date: z.coerce.date(),
  accountCode: z.string().regex(/^[5-7]\d{3}$/, "Choose an expense account (5xxx–7xxx)"),
  vendor: z.string().optional(),
  vendorTrn: z.string().optional(),
  description: z.string().min(2),
  amount: Money,
  vatAmount: Money.default("0"),
  paidVia: z.enum(["CASH", "BANK_TRANSFER", "CARD", "CHEQUE"]),
  bankAccountId: z.string().optional(),
  receiptUrl: z.string().url().optional(),
  campaignId: z.string().optional(),
});

@Controller("finance")
export class FinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- Chart of accounts & journals ----------
  @Get("accounts")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  accounts() {
    return this.prisma.account.findMany({ orderBy: { code: "asc" } });
  }

  @Post("accounts")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  createAccount(@Body(zod(AccountBody)) body: z.infer<typeof AccountBody>) {
    return this.prisma.account.create({ data: body });
  }

  @Get("journals")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async journals(@Query(zod(PageQuery.extend({ source: z.string().optional(), refType: z.string().optional(), refId: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }))) q: PageQuery & { source?: string; refType?: string; refId?: string; from?: Date; to?: Date }) {
    const where: Prisma.JournalEntryWhereInput = { source: q.source as Prisma.JournalEntryWhereInput["source"], refType: q.refType, refId: q.refId, date: { gte: q.from, lte: q.to } };
    const [items, total] = await Promise.all([
      this.prisma.journalEntry.findMany({ where, include: { lines: { include: { account: { select: { code: true, name: true } } } } }, orderBy: [{ date: "desc" }, { number: "desc" }], ...skipTake(q) }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post("journals")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  manualJournal(@CurrentUser() me: AuthUser, @Body(zod(JournalBody)) body: z.infer<typeof JournalBody>) {
    return this.prisma.$transaction((tx) => this.ledger.post(tx, { date: body.date, source: "MANUAL", memo: body.memo, userId: me.id, lines: body.lines }));
  }

  @Post("journals/:id/reverse")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  reverse(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(z.object({ memo: z.string().optional() }))) body: { memo?: string }) {
    return this.prisma.$transaction((tx) => this.ledger.reverse(tx, id, me.id, body.memo));
  }

  // ---------- Bank accounts ----------
  @Get("bank-accounts")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  banks() {
    return this.prisma.bankAccount.findMany({ include: { account: { select: { code: true, name: true } } } });
  }

  @Post("bank-accounts")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  async createBank(@Body(zod(BankBody)) body: z.infer<typeof BankBody>) {
    const { code, ...bank } = body;
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { code, name: `Bank: ${bank.bankName} ${bank.currencyCode}`, type: "ASSET", isSystem: false } });
      return tx.bankAccount.create({ data: { ...bank, accountId: account.id } });
    });
  }

  // ---------- Payments ----------
  @Get("payments")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async paymentList(@Query(zod(PageQuery.extend({ direction: z.enum(["RECEIVED", "MADE"]).optional(), customerId: z.string().optional(), supplierId: z.string().optional() }))) q: PageQuery & { direction?: "RECEIVED" | "MADE"; customerId?: string; supplierId?: string }) {
    const where: Prisma.PaymentWhereInput = { direction: q.direction, customerId: q.customerId, supplierId: q.supplierId };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({ where, include: { customer: { select: { companyName: true } }, supplier: { select: { name: true } }, allocations: true }, orderBy: { date: "desc" }, ...skipTake(q) }),
      this.prisma.payment.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post("payments")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  recordPayment(@CurrentUser() me: AuthUser, @Body(zod(PaymentBody)) body: z.infer<typeof PaymentBody>) {
    return this.prisma.$transaction((tx) => this.payments.record(tx, body, me.id));
  }

  // ---------- Post-dated cheques ----------
  @Get("pdcs")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  pdcs(@Query(zod(z.object({ status: z.string().optional(), dueBefore: z.coerce.date().optional() }))) q: { status?: string; dueBefore?: Date }) {
    return this.prisma.postDatedCheque.findMany({
      where: { status: q.status as Prisma.PostDatedChequeWhereInput["status"], chequeDate: { lte: q.dueBefore } },
      include: { customer: { select: { companyName: true } } },
      orderBy: { chequeDate: "asc" },
    });
  }

  /** Cheque received, dated in the future. No accounting entry until it clears. */
  @Post("pdcs")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  receivePdc(@Body(zod(PdcBody)) body: z.infer<typeof PdcBody>) {
    return this.prisma.postDatedCheque.create({ data: { ...body, direction: "RECEIVED" } });
  }

  @Post("pdcs/:id/deposit")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @HttpCode(200)
  async depositPdc(@Param("id") id: string, @Body(zod(z.object({ bankAccountId: z.string() }))) body: { bankAccountId: string }) {
    const pdc = await this.prisma.postDatedCheque.findUniqueOrThrow({ where: { id } });
    if (pdc.status !== "RECEIVED") throw new BadRequestException(`Cheque is ${pdc.status}`);
    if (pdc.chequeDate > new Date()) throw new BadRequestException(`Cheque is dated ${pdc.chequeDate.toISOString().slice(0, 10)}; it cannot be deposited before then`);
    return this.prisma.postDatedCheque.update({ where: { id }, data: { status: "DEPOSITED", bankAccountId: body.bankAccountId } });
  }

  /** Cheque cleared: becomes a payment, allocated to the given (or oldest) invoices. */
  @Post("pdcs/:id/clear")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @HttpCode(200)
  async clearPdc(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(z.object({ allocations: PaymentBody.shape.allocations }))) body: { allocations: { invoiceId?: string; amount: string }[] }) {
    return this.prisma.$transaction(async (tx) => {
      const pdc = await tx.postDatedCheque.findUniqueOrThrow({ where: { id } });
      if (pdc.status !== "DEPOSITED") throw new BadRequestException("Deposit the cheque first");
      const payment = await this.payments.record(
        tx,
        {
          direction: "RECEIVED",
          method: "PDC",
          amount: pdc.amount.toString(),
          customerId: pdc.customerId!,
          bankAccountId: pdc.bankAccountId!,
          reference: `Cheque ${pdc.chequeNo} ${pdc.bankName}`,
          allocations: body.allocations,
          autoAllocate: body.allocations.length === 0,
        },
        me.id,
      );
      return tx.postDatedCheque.update({ where: { id }, data: { status: "CLEARED", paymentId: payment.id }, include: { payment: { include: { allocations: true } } } });
    });
  }

  /** Cheque bounced: the Manager is alerted (the invoices stay open). */
  @Post("pdcs/:id/bounce")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @HttpCode(200)
  async bouncePdc(@Param("id") id: string, @Body(zod(z.object({ notes: z.string().optional() }))) body: { notes?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const pdc = await tx.postDatedCheque.findUniqueOrThrow({ where: { id }, include: { customer: true } });
      if (!["RECEIVED", "DEPOSITED"].includes(pdc.status)) throw new BadRequestException(`Cheque is ${pdc.status}`);
      const updated = await tx.postDatedCheque.update({ where: { id }, data: { status: "BOUNCED", notes: body.notes ?? pdc.notes } });
      const managers = await tx.user.findMany({ where: { status: "ACTIVE", role: { key: "SUPER_ADMIN" } } });
      for (const m of managers) {
        await this.notifications.notify(
          { userId: m.id, title: "Cheque bounced", body: `${pdc.customer?.companyName}: cheque ${pdc.chequeNo} (${pdc.bankName}) AED ${pdc.amount}`, link: `/finance/pdcs/${id}`, channels: ["IN_APP", "WHATSAPP", "EMAIL"] },
          tx,
        );
      }
      return updated;
    });
  }

  // ---------- Expenses ----------
  @Get("expenses")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async expenses(@Query(zod(PageQuery.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), campaignId: z.string().optional() }))) q: PageQuery & { from?: Date; to?: Date; campaignId?: string }) {
    const where: Prisma.ExpenseWhereInput = { date: { gte: q.from, lte: q.to }, campaignId: q.campaignId };
    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({ where, include: { account: { select: { code: true, name: true } } }, orderBy: { date: "desc" }, ...skipTake(q) }),
      this.prisma.expense.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post("expenses")
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  async createExpense(@CurrentUser() me: AuthUser, @Body(zod(ExpenseBody)) body: z.infer<typeof ExpenseBody>) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findUnique({ where: { code: body.accountCode } });
      if (!account || account.type !== "EXPENSE") throw new BadRequestException("Choose an expense account");
      const bank = body.paidVia === "CASH" ? null : await tx.bankAccount.findUnique({ where: { id: body.bankAccountId ?? "" }, include: { account: true } });
      if (body.paidVia !== "CASH" && !bank) throw new BadRequestException("Choose the bank account it was paid from");
      const total = round2(d(body.amount).plus(body.vatAmount));
      const { accountCode: _a, bankAccountId: _b, ...data } = body;
      const expense = await tx.expense.create({
        data: { ...data, number: await this.numbering.next("EXP", tx, body.date), accountId: account.id, total: total.toString(), createdById: me.id },
      });
      await this.ledger.post(tx, {
        date: body.date,
        source: "EXPENSE",
        refType: "Expense",
        refId: expense.id,
        memo: `${expense.number} ${body.description}`,
        userId: me.id,
        lines: [
          { account: body.accountCode, debit: body.amount, campaignId: body.campaignId },
          { account: ACC.VAT_INPUT, debit: body.vatAmount },
          { account: bank?.account.code ?? ACC.CASH, credit: total },
        ],
      });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "Expense", entityId: expense.id, after: expense }, tx);
      return expense;
    });
  }

  @Get("expenses/:id")
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async expense(@Param("id") id: string) {
    const e = await this.prisma.expense.findUnique({ where: { id }, include: { account: true } });
    if (!e) throw new NotFoundException();
    return e;
  }
}
