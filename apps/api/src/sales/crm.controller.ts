import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, OnModuleInit, Param, Patch, Post, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { d, hasPermission, isValidTrn, PERMISSIONS, sum } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../common/auth/decorators";
import { Money, PageQuery, skipTake, toPage } from "../common/http/pagination";
import { zod } from "../common/http/zod.pipe";
import { PrismaService, Tx } from "../common/prisma/prisma.service";
import { ApprovalsService } from "../core/approvals/approvals.service";
import { AuditService } from "../core/audit/audit.service";
import { NumberingService } from "../core/numbering/numbering.service";

const CUSTOMER_TYPES = ["RETAILER", "SALON", "ONLINE_SELLER", "DISTRIBUTOR", "EXPORT_BUYER", "CORPORATE", "OTHER"] as const;
const EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"] as const;

const CustomerBody = z.object({
  type: z.enum(CUSTOMER_TYPES),
  status: z.enum(["PROSPECT", "PENDING_VERIFICATION", "ACTIVE", "ON_HOLD", "BLOCKED"]).optional(),
  companyName: z.string().min(1),
  tradeLicenceNo: z.string().optional(),
  tradeLicenceExpiry: z.coerce.date().optional(),
  trn: z.string().refine(isValidTrn, "TRN must be 15 digits starting with 100").optional(),
  countryCode: z.string().length(2).default("AE"),
  emirate: z.enum(EMIRATES).optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  contactName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  website: z.string().optional(),
  instagram: z.string().optional(),
  priceTier: z.enum(["A", "B", "C", "EXPORT", "RETAIL", "CUSTOM"]).default("C"),
  priceListId: z.string().optional(),
  currencyCode: z.string().length(3).default("AED"),
  salespersonId: z.string().optional(),
  marketingOptIn: z.boolean().optional(),
  whatsappOptIn: z.boolean().optional(),
  notes: z.string().optional(),
});

const CreditBody = z.object({ creditLimitAed: Money, paymentTermsDays: z.number().int().min(0).max(365) });

const CustomerQuery = PageQuery.extend({
  type: z.enum(CUSTOMER_TYPES).optional(),
  status: z.string().optional(),
  salespersonId: z.string().optional(),
});

const ContactBody = z.object({ name: z.string().min(1), position: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), whatsapp: z.string().optional(), isPrimary: z.boolean().default(false) });

const ActivityBody = z.object({
  type: z.enum(["CALL", "MEETING", "WHATSAPP", "EMAIL", "VISIT", "NOTE", "TASK"]),
  subject: z.string().min(1),
  body: z.string().optional(),
  dueAt: z.coerce.date().optional(),
  doneAt: z.coerce.date().optional(),
  customerId: z.string().optional(),
  leadId: z.string().optional(),
});

const LeadBody = z.object({
  companyName: z.string().min(1),
  contactName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  countryCode: z.string().length(2).optional(),
  interestedBrands: z.array(z.string()).default([]),
  estValueAed: Money.optional(),
  ownerId: z.string().optional(),
  leadSourceId: z.string().optional(),
  campaignId: z.string().optional(),
  utmSource: z.string().optional(),
  utmMedium: z.string().optional(),
  utmCampaign: z.string().optional(),
});
const LeadUpdate = LeadBody.partial().extend({ stage: z.enum(["NEW", "CONTACTED", "SAMPLE_SENT", "NEGOTIATION", "WON", "LOST"]).optional(), lostReason: z.string().optional() });

/** Open balance of an invoice: total − paid − credited. */
export const invoiceBalance = (inv: { total: Prisma.Decimal; amountPaid: Prisma.Decimal; amountCredited: Prisma.Decimal }) =>
  d(inv.total.toString()).minus(inv.amountPaid.toString()).minus(inv.amountCredited.toString());

/** What a customer owes now, in AED. */
export async function customerOutstandingAed(tx: Tx | PrismaService, customerId: string) {
  const open = await tx.invoice.findMany({ where: { customerId, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } } });
  return sum(open.map((i) => invoiceBalance(i).times(i.exchangeRate.toString())));
}

/** Credit exposure = unpaid invoices + confirmed orders not yet invoiced (AED). */
export async function customerExposureAed(tx: Tx | PrismaService, customerId: string, excludeOrderId?: string) {
  const outstanding = await customerOutstandingAed(tx, customerId);
  const openOrders = await tx.salesOrder.aggregate({
    where: { customerId, id: excludeOrderId ? { not: excludeOrderId } : undefined, status: { in: ["CONFIRMED", "PICKING", "PACKED", "PARTIALLY_DELIVERED", "DELIVERED"] } },
    _sum: { totalAed: true },
  });
  return { outstanding, openOrders: d(openOrders._sum.totalAed?.toString() ?? 0), exposure: outstanding.plus(openOrders._sum.totalAed?.toString() ?? 0) };
}

@Controller("crm")
export class CrmController implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
  ) {}

  onModuleInit() {
    // A new credit limit / payment terms only apply once approved.
    this.approvals.registerHandler("CustomerCredit", {
      onApproved: async (tx, req) => {
        const c = req.details as unknown as { customerId: string; creditLimitAed: string; paymentTermsDays: number };
        await tx.customer.update({ where: { id: c.customerId }, data: { creditLimitAed: c.creditLimitAed, paymentTermsDays: c.paymentTermsDays } });
      },
    });
  }

  // ---------- Customers ----------
  @Get("customers")
  @RequirePermissions(PERMISSIONS.CRM_READ)
  async customers(@Query(zod(CustomerQuery)) q: z.infer<typeof CustomerQuery>) {
    const where: Prisma.CustomerWhereInput = {
      type: q.type,
      status: q.status as Prisma.CustomerWhereInput["status"],
      salespersonId: q.salespersonId,
      ...(q.q
        ? { OR: [{ companyName: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q, mode: "insensitive" } }, { trn: { contains: q.q } }, { phone: { contains: q.q } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, include: { salesperson: { select: { id: true, fullName: true } } }, orderBy: { companyName: "asc" }, ...skipTake(q) }),
      this.prisma.customer.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Get("customers/:id")
  @RequirePermissions(PERMISSIONS.CRM_READ)
  async customer(@Param("id") id: string) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: { contacts: true, addresses: true, salesperson: { select: { id: true, fullName: true } }, priceList: { select: { id: true, name: true, isApproved: true } } },
    });
    if (!c) throw new NotFoundException();
    const { outstanding, openOrders, exposure } = await customerExposureAed(this.prisma, id);
    const overdue = await this.prisma.invoice.count({ where: { customerId: id, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] }, dueDate: { lt: new Date() } } });
    return {
      ...c,
      outstandingAed: outstanding.toFixed(2),
      openOrdersAed: openOrders.toFixed(2),
      availableCreditAed: d(c.creditLimitAed.toString()).minus(exposure).toFixed(2),
      overdueInvoices: overdue,
    };
  }

  /** New customers start with no credit (cash / advance) until a credit limit is approved. */
  @Post("customers")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  async createCustomer(@CurrentUser() me: AuthUser, @Body(zod(CustomerBody.merge(CreditBody.partial()))) body: z.infer<typeof CustomerBody> & Partial<z.infer<typeof CreditBody>>) {
    const { creditLimitAed, paymentTermsDays, ...data } = body;
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: { ...data, code: await this.numbering.next("CUS", tx), salespersonId: data.salespersonId ?? (me.roleKey === "SALES" ? me.id : undefined) },
      });
      await this.audit.log({ userId: me.id, action: "CREATE", entityType: "Customer", entityId: customer.id, after: customer }, tx);
      let creditApproval = null;
      if (creditLimitAed && d(creditLimitAed).greaterThan(0)) {
        creditApproval = await this.requestCredit(tx, me, customer.id, customer.companyName, { creditLimitAed, paymentTermsDays: paymentTermsDays ?? 30 });
      }
      return { ...(await tx.customer.findUniqueOrThrow({ where: { id: customer.id } })), creditApproval };
    });
  }

  @Patch("customers/:id")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  async updateCustomer(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(CustomerBody.partial())) body: Partial<z.infer<typeof CustomerBody>>) {
    const before = await this.prisma.customer.findUniqueOrThrow({ where: { id } });
    const after = await this.prisma.customer.update({ where: { id }, data: body });
    await this.audit.log({ userId: me.id, action: "UPDATE", entityType: "Customer", entityId: id, before, after });
    return after;
  }

  /** Change credit limit / payment terms → CREDIT_LIMIT_CHANGE approval. */
  @Post("customers/:id/credit")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  @HttpCode(202)
  async changeCredit(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(CreditBody)) body: z.infer<typeof CreditBody>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.customer.findUniqueOrThrow({ where: { id } });
      const approval = await this.requestCredit(tx, me, id, c.companyName, body);
      return { status: approval.status === "APPROVED" ? "APPLIED" : "PENDING_APPROVAL", approval };
    });
  }

  private requestCredit(tx: Tx, me: AuthUser, customerId: string, name: string, body: { creditLimitAed: string; paymentTermsDays: number }) {
    return this.approvals.request(
      {
        type: "CREDIT_LIMIT_CHANGE",
        entityType: "CustomerCredit",
        entityId: customerId,
        title: `${name}: credit limit AED ${Number(body.creditLimitAed).toLocaleString("en-AE")}, ${body.paymentTermsDays} days`,
        details: { customerId, ...body },
        amountAed: Number(body.creditLimitAed),
        requestedById: me.id,
      },
      tx,
    );
  }

  /** Statement of account: invoices, credit notes and payments with a running balance (AED). */
  @Get("customers/:id/statement")
  @RequirePermissions(PERMISSIONS.CRM_READ)
  async statement(@Param("id") id: string, @Query(zod(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }))) q: { from?: Date; to?: Date }) {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, companyName: true, trn: true } });
    const range = { gte: q.from, lte: q.to };
    const [invoices, credits, payments] = await Promise.all([
      this.prisma.invoice.findMany({ where: { customerId: id, status: { not: "VOID" }, issueDate: range } }),
      this.prisma.creditNote.findMany({ where: { customerId: id, status: { in: ["ISSUED", "APPLIED"] }, issueDate: range }, include: { invoice: true } }),
      this.prisma.payment.findMany({ where: { customerId: id, direction: "RECEIVED", date: range } }),
    ]);
    const rows = [
      ...invoices.map((i) => ({ date: i.issueDate, type: "INVOICE", number: i.number, debit: i.totalAed.toString(), credit: "0", dueDate: i.dueDate })),
      ...credits.map((c) => ({ date: c.issueDate, type: "CREDIT_NOTE", number: c.number, debit: "0", credit: d(c.total.toString()).times(c.invoice.exchangeRate.toString()).toFixed(2), dueDate: null })),
      ...payments.map((p) => ({ date: p.date, type: "PAYMENT", number: p.number, debit: "0", credit: p.amountAed.toString(), dueDate: null })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    let balance = d(0);
    const lines = rows.map((r) => {
      balance = balance.plus(r.debit).minus(r.credit);
      return { ...r, balance: balance.toFixed(2) };
    });
    return { customer, lines, closingBalanceAed: balance.toFixed(2) };
  }

  @Post("customers/:id/contacts")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  addContact(@Param("id") customerId: string, @Body(zod(ContactBody)) body: z.infer<typeof ContactBody>) {
    return this.prisma.customerContact.create({ data: { ...body, customerId } });
  }

  // ---------- Activities ----------
  @Get("activities")
  @RequirePermissions(PERMISSIONS.CRM_READ)
  async activities(@CurrentUser() me: AuthUser, @Query(zod(PageQuery.extend({ customerId: z.string().optional(), leadId: z.string().optional(), open: z.coerce.boolean().optional() }))) q: PageQuery & { customerId?: string; leadId?: string; open?: boolean }) {
    const where: Prisma.ActivityWhereInput = {
      customerId: q.customerId,
      leadId: q.leadId,
      ...(q.open ? { doneAt: null, dueAt: { not: null } } : {}),
      ...(!q.customerId && !q.leadId ? { userId: me.id } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.activity.findMany({ where, orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }], ...skipTake(q) }),
      this.prisma.activity.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post("activities")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  addActivity(@CurrentUser() me: AuthUser, @Body(zod(ActivityBody)) body: z.infer<typeof ActivityBody>) {
    if (!body.customerId && !body.leadId) throw new BadRequestException("Link the activity to a customer or a lead");
    return this.prisma.activity.create({ data: { ...body, userId: me.id } });
  }

  @Post("activities/:id/done")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  @HttpCode(200)
  async doneActivity(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    const res = await this.prisma.activity.updateMany({ where: { id, ...(hasPermission(me.permissions, "*") ? {} : { userId: me.id }) }, data: { doneAt: new Date() } });
    if (res.count !== 1) throw new NotFoundException();
    return { ok: true };
  }

  // ---------- Leads ----------
  @Get("leads")
  @RequirePermissions(PERMISSIONS.CRM_READ)
  async leads(@Query(zod(PageQuery.extend({ stage: z.string().optional(), ownerId: z.string().optional(), campaignId: z.string().optional() }))) q: PageQuery & { stage?: string; ownerId?: string; campaignId?: string }) {
    const where: Prisma.LeadWhereInput = {
      stage: q.stage as Prisma.LeadWhereInput["stage"],
      ownerId: q.ownerId,
      campaignId: q.campaignId,
      ...(q.q ? { companyName: { contains: q.q, mode: "insensitive" } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({ where, include: { owner: { select: { fullName: true } }, leadSource: true, campaign: { select: { code: true, name: true } } }, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.lead.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  /** Pipeline board: number and estimated value of leads in each stage. */
  @Get("leads/pipeline")
  @RequirePermissions(PERMISSIONS.CRM_READ)
  async pipeline() {
    const rows = await this.prisma.lead.groupBy({ by: ["stage"], _count: { _all: true }, _sum: { estValueAed: true } });
    return rows.map((r) => ({ stage: r.stage, count: r._count._all, estValueAed: r._sum.estValueAed?.toString() ?? "0" }));
  }

  @Post("leads")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  createLead(@CurrentUser() me: AuthUser, @Body(zod(LeadBody)) body: z.infer<typeof LeadBody>) {
    return this.prisma.lead.create({ data: { ...body, ownerId: body.ownerId ?? me.id } });
  }

  @Patch("leads/:id")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  updateLead(@Param("id") id: string, @Body(zod(LeadUpdate)) body: z.infer<typeof LeadUpdate>) {
    if (body.stage === "LOST" && !body.lostReason) throw new BadRequestException("Please give a reason when a lead is lost");
    return this.prisma.lead.update({ where: { id }, data: body });
  }

  /** Won lead → new customer (keeps the campaign link for ad attribution). */
  @Post("leads/:id/convert")
  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  async convertLead(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUniqueOrThrow({ where: { id } });
      if (lead.customerId) throw new BadRequestException("Lead already converted");
      const customer = await tx.customer.create({
        data: {
          code: await this.numbering.next("CUS", tx),
          type: lead.customerType ?? "RETAILER",
          status: "PENDING_VERIFICATION",
          companyName: lead.companyName,
          contactName: lead.contactName,
          email: lead.email,
          phone: lead.phone,
          whatsapp: lead.whatsapp,
          countryCode: lead.countryCode ?? "AE",
          salespersonId: lead.ownerId ?? me.id,
        },
      });
      await tx.lead.update({ where: { id }, data: { stage: "WON", customerId: customer.id } });
      if (lead.campaignId) {
        await tx.campaignAttribution.create({ data: { campaignId: lead.campaignId, kind: "B2B_SIGNUP", refId: customer.id, customerId: customer.id, touchpoint: lead.utmSource ? "utm" : "lead" } });
      }
      await this.audit.log({ userId: me.id, action: "CONVERT", entityType: "Lead", entityId: id, after: customer }, tx);
      return customer;
    });
  }
}
