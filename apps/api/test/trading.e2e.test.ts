/**
 * One complete trading cycle, checked down to the fils:
 * buy from France → receive with landed costs → sell to a Sharjah salon (quotation with a
 * below-minimum discount) → credit limit → deliver → tax invoice → bank payment + credit note +
 * PDC → export sale (zero-rated) → expense → VAT201 → trial balance & balance sheet.
 */
import { MANAGER, setup, teardown, TestContext } from "./helpers";

let ctx: TestContext;
let admin: Record<string, string>;
let sales: Record<string, string>;
let accounts: Record<string, string>;
let store: Record<string, string>;

const ids: Record<string, string> = {};
const today = () => new Date().toISOString().slice(0, 10);
const api = (path: string) => `/api/v1${path}`;

beforeAll(async () => {
  ctx = await setup();
  const auth = async (email: string) => ({ Authorization: `Bearer ${await ctx.login(email)}` });
  admin = await auth(MANAGER.email);
  sales = await auth("sales@luxora.ae");
  accounts = await auth("accounts@luxora.ae");
  store = await auth("store@luxora.ae");

  ids.warehouse = (await ctx.prisma.warehouse.findUniqueOrThrow({ where: { code: "DXB-DEIRA" } })).id;
  ids.bank = (await ctx.prisma.bankAccount.findFirstOrThrow()).id;
  const salesUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email: "sales@luxora.ae" } });
  ids.salesUser = salesUser.id;
  await ctx.prisma.employee.create({ data: { userId: salesUser.id, employeeNo: "EMP-001", fullName: "Sara Sales", position: "Sales Executive", joinDate: new Date("2026-01-01"), basicSalaryAed: 8000, commissionPct: 2 } });

  const brand = await ctx.http().post(api("/catalogue/brands")).set(admin).send({ name: "Initio", category: "NICHE", originCountryCode: "FR" });
  const product = await ctx.http().post(api("/catalogue/products")).set(admin).send({
    brandId: brand.body.id,
    nameEn: "Oud for Greatness",
    concentration: "EDP",
    gender: "UNISEX",
    variants: [{ sku: "INI-OFG-90", sizeMl: 90, weightGrams: 450, wholesaleAAed: 700, wholesaleBAed: 725, wholesaleCAed: 750, retailPriceAed: 1350, minSellingPriceAed: 700 }],
  });
  ids.variant = product.body.variants[0].id;
});
afterAll(() => teardown(ctx));

const stockOf = async () => (await ctx.http().get(api(`/inventory/stock/${ids.variant}`)).set(admin)).body;
const account = async (code: string) => {
  const tb = await ctx.http().get(api("/finance/reports/trial-balance")).set(admin);
  const line = tb.body.lines.find((l: { code: string }) => l.code === code);
  return line ? Number(line.debit) - Number(line.credit) : 0;
};

describe("1. Purchasing", () => {
  it("needs the Manager's approval for a PO above AED 20,000", async () => {
    const supplier = await ctx.http().post(api("/purchasing/suppliers")).set(accounts).send({ code: "INITIO-FR", name: "Initio Parfums Privés", countryCode: "FR", currencyCode: "EUR", paymentTermsDays: 30 });
    expect(supplier.status).toBe(201);
    ids.supplier = supplier.body.id;

    const po = await ctx.http().post(api("/purchasing/orders")).set(accounts).send({
      supplierId: ids.supplier,
      currencyCode: "EUR",
      exchangeRate: "4.0",
      lines: [{ variantId: ids.variant, quantity: 40, unitPrice: 130 }],
    });
    expect(po.status).toBe(201);
    expect(po.body).toMatchObject({ total: "5200", totalAed: "20800", vatAmount: "0" }); // import: no UAE VAT on the invoice
    ids.po = po.body.id;

    const submit = await ctx.http().post(api(`/purchasing/orders/${ids.po}/submit`)).set(accounts);
    expect(submit.body.status).toBe("PENDING_APPROVAL");
    expect((await ctx.http().post(api(`/purchasing/orders/${ids.po}/send`)).set(accounts)).status).toBe(400);

    const req = await ctx.prisma.approvalRequest.findFirstOrThrow({ where: { entityType: "PurchaseOrder", entityId: ids.po } });
    await ctx.http().post(api(`/approvals/${req.id}/approve`)).set(admin).send({}).expect(200);
    expect((await ctx.http().post(api(`/purchasing/orders/${ids.po}/send`)).set(accounts)).body.status).toBe("SENT");
  });

  it("receives the goods with freight and customs duty added to the unit cost", async () => {
    const grn = await ctx.http().post(api("/purchasing/receipts")).set(store).send({
      purchaseOrderId: ids.po,
      supplierId: ids.supplier,
      warehouseId: ids.warehouse,
      lines: [{ variantId: ids.variant, batchNo: "OFG-24A", expiresOn: "2029-12-31", quantity: 40, unitPrice: 130 }],
      landedCosts: [
        { type: "FREIGHT", amountAed: 800 },
        { type: "CUSTOMS_DUTY", amountAed: 1040 },
      ],
    });
    expect(grn.status).toBe(201);
    expect(grn.body.lines[0]).toMatchObject({ unitPriceAed: "520", landedUnitCost: "566" }); // 520 + (1840 / 40)
    expect((await stockOf()).onHand).toBe(40);
    expect((await ctx.prisma.productVariant.findUniqueOrThrow({ where: { id: ids.variant } })).costAed.toString()).toBe("566");
    expect((await ctx.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.po } })).status).toBe("RECEIVED");
    expect(await account("1200")).toBe(22640);
    expect(await account("2050")).toBe(-22640);
  });

  it("does not let the same PO be over-received", async () => {
    const res = await ctx.http().post(api("/purchasing/receipts")).set(store).send({
      purchaseOrderId: ids.po, supplierId: ids.supplier, warehouseId: ids.warehouse,
      lines: [{ variantId: ids.variant, batchNo: "OFG-24A", quantity: 1, unitPrice: 130 }],
    });
    expect(res.status).toBe(400);
  });

  it("clears goods-received-not-invoiced with the supplier, freight and duty bills", async () => {
    await ctx.http().post(api("/purchasing/bills")).set(accounts).send({ supplierId: ids.supplier, purchaseOrderId: ids.po, supplierRef: "FR-2026-1187", billDate: today(), currencyCode: "EUR", exchangeRate: "4.0", subtotal: 5200 }).expect(201);
    const forwarder = await ctx.http().post(api("/purchasing/suppliers")).set(accounts).send({ code: "ARAMEX-DXB", name: "Aramex Freight", countryCode: "AE", trn: "100000000000003" });
    ids.forwarder = forwarder.body.id;
    const freight = await ctx.http().post(api("/purchasing/bills")).set(accounts).send({ supplierId: ids.forwarder, supplierRef: "AWB-7731", billDate: today(), subtotal: 800, vatAmount: 40 });
    ids.freightBill = freight.body.id;
    // customs duty paid directly from the bank
    await ctx.http().post(api("/finance/journals")).set(accounts).send({
      date: today(), memo: "Dubai Customs duty, declaration 101-26-0042",
      lines: [{ account: "2050", debit: 1040 }, { account: "1010", credit: 1040 }],
    }).expect(201);

    expect(await account("2050")).toBe(0);
    expect(await account("1300")).toBe(40);
    expect(await account("2000")).toBe(-(20800 + 840));
  });

  it("pays the freight forwarder", async () => {
    const pay = await ctx.http().post(api("/finance/payments")).set(accounts).send({
      direction: "MADE", method: "BANK_TRANSFER", amount: 840, supplierId: ids.forwarder, bankAccountId: ids.bank,
      allocations: [{ supplierBillId: ids.freightBill, amount: 840 }],
    });
    expect(pay.status).toBe(201);
    expect((await ctx.prisma.supplierBill.findUniqueOrThrow({ where: { id: ids.freightBill } })).status).toBe("PAID");
  });
});

describe("2. Customer and credit", () => {
  it("creates a Sharjah salon; its credit limit waits for the Manager", async () => {
    const bad = await ctx.http().post(api("/crm/customers")).set(sales).send({ type: "SALON", companyName: "X", trn: "12345" });
    expect(bad.status).toBe(400);

    const res = await ctx.http().post(api("/crm/customers")).set(sales).send({
      type: "SALON", status: "ACTIVE", companyName: "Bloom Beauty Salon LLC", trn: "100234567890003",
      emirate: "Sharjah", city: "Sharjah", address: "Al Majaz 2", priceTier: "C", creditLimitAed: 30000, paymentTermsDays: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^LUX-CUS-\d{4}-0001$/);
    expect(res.body.creditLimitAed).toBe("0");
    expect(res.body.salespersonId).toBe(ids.salesUser);
    expect(res.body.creditApproval.status).toBe("PENDING");
    ids.salon = res.body.id;

    await ctx.http().post(api(`/approvals/${res.body.creditApproval.id}/approve`)).set(admin).send({}).expect(200);
    const c = await ctx.http().get(api(`/crm/customers/${ids.salon}`)).set(sales);
    expect(c.body).toMatchObject({ creditLimitAed: "30000", paymentTermsDays: 30, availableCreditAed: "30000.00" });
  });
});

describe("3. Quotation → order", () => {
  it("prices at tier C and flags an 8% discount as below minimum", async () => {
    const check = await ctx.http().post(api("/sales/price-check")).set(sales).send({ customerId: ids.salon, lines: [{ variantId: ids.variant, quantity: 20, discountPct: 8 }] });
    expect(check.body.lines[0]).toMatchObject({ unitPrice: "750", belowMinPrice: true, lineTotal: "13800" });
    expect(check.body).toMatchObject({ subtotal: "13800", vat: "690", total: "14490" });
  });

  it("holds the quotation until the Manager approves the discount", async () => {
    const qt = await ctx.http().post(api("/sales/quotations")).set(sales).send({ customerId: ids.salon, lines: [{ variantId: ids.variant, quantity: 20, discountPct: 8 }] });
    expect(qt.status).toBe(201);
    ids.quotation = qt.body.id;
    const sent = await ctx.http().post(api(`/sales/quotations/${ids.quotation}/send`)).set(sales);
    expect(sent.body.status).toBe("PENDING_APPROVAL");
    await ctx.http().post(api(`/approvals/${sent.body.approval.id}/approve`)).set(admin).send({ note: "OK for the opening order" }).expect(200);
    expect((await ctx.prisma.quotation.findUniqueOrThrow({ where: { id: ids.quotation } })).status).toBe("SENT");
  });

  it("converts the accepted quotation into a confirmed order with stock reserved", async () => {
    await ctx.http().post(api(`/sales/quotations/${ids.quotation}/accept`)).set(sales).expect(200);
    const res = await ctx.http().post(api(`/sales/quotations/${ids.quotation}/convert`)).set(sales).send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CONFIRMED");
    expect(res.body.order).toMatchObject({ totalAed: "14490", quotationId: ids.quotation });
    ids.order1 = res.body.order.id;
    expect((await stockOf()).reserved).toBe(20);
  });

  it("counts open orders in the credit check and only lets the Manager override", async () => {
    const o2 = await ctx.http().post(api("/sales/orders")).set(sales).send({ customerId: ids.salon, lines: [{ variantId: ids.variant, quantity: 15 }] });
    expect(o2.body.totalAed).toBe("11812.5");
    ids.order2 = o2.body.id;
    expect((await ctx.http().post(api(`/sales/orders/${ids.order2}/confirm`)).set(sales).send({})).body.status).toBe("CONFIRMED"); // 14,490 + 11,812.50 = 26,302.50

    const o3 = await ctx.http().post(api("/sales/orders")).set(sales).send({ customerId: ids.salon, lines: [{ variantId: ids.variant, quantity: 5 }] });
    ids.order3 = o3.body.id;
    const blocked = await ctx.http().post(api(`/sales/orders/${ids.order3}/confirm`)).set(sales).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ creditLimitAed: "30000", currentExposureAed: "26302.50", orderAed: "3937.5" });
    expect((await ctx.http().post(api(`/sales/orders/${ids.order3}/confirm`)).set(sales).send({ overrideCredit: true })).status).toBe(403);

    const ok = await ctx.http().post(api(`/sales/orders/${ids.order3}/confirm`)).set(admin).send({ overrideCredit: true });
    expect(ok.body.status).toBe("CONFIRMED");
    expect((await stockOf()).reserved).toBe(40);
  });

  it("cancelling an order gives its stock back", async () => {
    await ctx.http().post(api(`/sales/orders/${ids.order3}/cancel`)).set(sales).send({ reason: "Customer changed mind" }).expect(200);
    expect((await stockOf()).reserved).toBe(35);
  });
});

describe("4. Delivery and tax invoice", () => {
  it("cannot invoice before delivery", async () => {
    expect((await ctx.http().post(api(`/sales/orders/${ids.order1}/invoice`)).set(sales)).status).toBe(400);
  });

  it("delivers in two parts and posts cost of goods sold", async () => {
    const order = await ctx.http().get(api(`/sales/orders/${ids.order1}`)).set(store);
    const lineId = order.body.lines[0].id;
    const dn1 = await ctx.http().post(api(`/sales/orders/${ids.order1}/deliveries`)).set(store).send({ lines: [{ lineId, quantity: 12 }], receivedBy: "Reem (salon manager)" });
    expect(dn1.status).toBe(201);
    expect((await ctx.prisma.salesOrder.findUniqueOrThrow({ where: { id: ids.order1 } })).status).toBe("PARTIALLY_DELIVERED");
    await ctx.http().post(api(`/sales/orders/${ids.order1}/deliveries`)).set(store).send({}).expect(201);
    expect((await ctx.prisma.salesOrder.findUniqueOrThrow({ where: { id: ids.order1 } })).status).toBe("DELIVERED");

    const s = await stockOf();
    expect(s).toMatchObject({ onHand: 20, reserved: 15 });
    expect(await account("5000")).toBe(20 * 566);
    expect(order.body.lines[0].unitCostAed).toBeUndefined(); // warehouse staff don't see costs
  });

  it("issues a bilingual tax invoice signed by the Manager, with a 2% commission", async () => {
    const res = await ctx.http().post(api(`/sales/orders/${ids.order1}/invoice`)).set(sales);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "TAX_INVOICE", status: "ISSUED", subtotal: "13800", vatAmount: "690", total: "14490", vatAmountAed: "690", customerTrn: "100234567890003", signatoryName: "Althaf Najeeb", signatoryTitle: "Manager" });
    expect(res.body.number).toMatch(/^LUX-INV-\d{4}-0001$/);
    ids.invoice1 = res.body.id;

    const detail = await ctx.http().get(api(`/sales/invoices/${ids.invoice1}`)).set(sales);
    expect(detail.body.title).toEqual({ en: "Tax Invoice", ar: "فاتورة ضريبية" });
    expect(detail.body.seller).toMatchObject({ legalName: "LUXORA Perfume & Cosmetics Trading LLC", licenceNumber: "2541889.01" });
    expect((await ctx.http().post(api(`/sales/orders/${ids.order1}/invoice`)).set(sales)).status).toBe(400);

    expect(await account("1100")).toBe(14490);
    expect(await account("4000")).toBe(-13800);
    expect(await account("2100")).toBe(-690);

    const mine = await ctx.http().get(api("/sales/commissions")).set(sales);
    expect(mine.body.totalAed).toBe("276.00");
  });
});

describe("5. Getting paid", () => {
  it("records a bank transfer against the invoice", async () => {
    const pay = await ctx.http().post(api("/finance/payments")).set(accounts).send({
      direction: "RECEIVED", method: "BANK_TRANSFER", amount: 10000, customerId: ids.salon, bankAccountId: ids.bank, reference: "FT26-99812",
      allocations: [{ invoiceId: ids.invoice1, amount: 10000 }],
    });
    expect(pay.status).toBe(201);
    const inv = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoice1 } });
    expect(inv.status).toBe("PARTIALLY_PAID");
    expect((await ctx.http().post(api("/finance/payments")).set(accounts).send({
      direction: "RECEIVED", method: "CASH", amount: 9999, customerId: ids.salon, allocations: [{ invoiceId: ids.invoice1, amount: 9999 }],
    })).status).toBe(400); // more than is open
  });

  it("issues a credit note for 2 returned bottles after approval and restocks them", async () => {
    const inv = await ctx.http().get(api(`/sales/invoices/${ids.invoice1}`)).set(sales);
    const res = await ctx.http().post(api(`/sales/invoices/${ids.invoice1}/credit-notes`)).set(sales).send({
      reason: "Damaged outer boxes", restock: true, warehouseId: ids.warehouse, lines: [{ invoiceLineId: inv.body.lines[0].id, quantity: 2 }],
    });
    expect(res.status).toBe(202);
    expect(res.body.creditNote).toMatchObject({ subtotal: "1380", vatAmount: "69", total: "1449", status: "PENDING_APPROVAL" });
    expect((await stockOf()).onHand).toBe(20);

    await ctx.http().post(api(`/approvals/${res.body.approval.id}/approve`)).set(admin).send({}).expect(200);
    const after = await ctx.http().get(api(`/sales/invoices/${ids.invoice1}`)).set(sales);
    expect(after.body.balance).toBe("3041.00");
    expect((await stockOf()).onHand).toBe(22);
    expect(await account("5000")).toBe(18 * 566);
  });

  it("handles post-dated cheques: no early deposit, bounce alert, clearance pays the invoice", async () => {
    const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const early = await ctx.http().post(api("/finance/pdcs")).set(accounts).send({ customerId: ids.salon, chequeNo: "000451", bankName: "Emirates NBD", chequeDate: future, amount: 3041 });
    expect((await ctx.http().post(api(`/finance/pdcs/${early.body.id}/deposit`)).set(accounts).send({ bankAccountId: ids.bank })).status).toBe(400);

    const bounced = await ctx.http().post(api("/finance/pdcs")).set(accounts).send({ customerId: ids.salon, chequeNo: "000450", bankName: "Emirates NBD", chequeDate: today(), amount: 3041 });
    await ctx.http().post(api(`/finance/pdcs/${bounced.body.id}/deposit`)).set(accounts).send({ bankAccountId: ids.bank }).expect(200);
    await ctx.http().post(api(`/finance/pdcs/${bounced.body.id}/bounce`)).set(accounts).send({ notes: "Insufficient funds" }).expect(200);
    const alert = await ctx.prisma.notification.findFirst({ where: { title: "Cheque bounced", channel: "WHATSAPP" } });
    expect(alert?.body).toContain("000450");
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoice1 } })).status).toBe("PARTIALLY_PAID");

    const good = await ctx.http().post(api("/finance/pdcs")).set(accounts).send({ customerId: ids.salon, chequeNo: "000452", bankName: "Mashreq", chequeDate: today(), amount: 3041 });
    await ctx.http().post(api(`/finance/pdcs/${good.body.id}/deposit`)).set(accounts).send({ bankAccountId: ids.bank }).expect(200);
    const cleared = await ctx.http().post(api(`/finance/pdcs/${good.body.id}/clear`)).set(accounts).send({});
    expect(cleared.body.status).toBe("CLEARED");
    expect(cleared.body.payment.allocations[0]).toMatchObject({ invoiceId: ids.invoice1, amount: "3041" });
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoice1 } })).status).toBe("PAID");
  });

  it("shows a statement of account that ends at zero", async () => {
    const st = await ctx.http().get(api(`/crm/customers/${ids.salon}/statement`)).set(sales);
    expect(st.body.lines.map((l: { type: string }) => l.type)).toEqual(["INVOICE", "PAYMENT", "CREDIT_NOTE", "PAYMENT"]);
    expect(st.body.closingBalanceAed).toBe("0.00");
  });
});

describe("6. Export sale", () => {
  it("issues a zero-rated export invoice to Kuwait", async () => {
    const cust = await ctx.http().post(api("/crm/customers")).set(sales).send({ type: "EXPORT_BUYER", status: "ACTIVE", companyName: "Al Salmiya Perfumes Co.", countryCode: "KW", city: "Kuwait City" });
    ids.export = cust.body.id;
    const o = await ctx.http().post(api("/sales/orders")).set(sales).send({ customerId: ids.export, lines: [{ variantId: ids.variant, quantity: 2 }] });
    expect(o.body).toMatchObject({ channel: "EXPORT", vatAmount: "0", total: "1500" });
    await ctx.http().post(api(`/sales/orders/${o.body.id}/confirm`)).set(sales).send({}).expect(200);
    await ctx.http().post(api(`/sales/orders/${o.body.id}/deliveries`)).set(store).send({}).expect(201);
    const inv = await ctx.http().post(api(`/sales/orders/${o.body.id}/invoice`)).set(sales);
    expect(inv.body).toMatchObject({ type: "EXPORT_INVOICE", vatAmount: "0", total: "1500" });
    expect(inv.body.lines[0].vatCategory).toBe("ZERO_RATED");
    expect(await account("4020")).toBe(-1500);
  });
});

describe("7. Expenses, VAT and the books", () => {
  it("records office rent with VAT", async () => {
    const res = await ctx.http().post(api("/finance/expenses")).set(accounts).send({
      date: today(), accountCode: "6200", vendor: "Shams Business Center", description: "Flexi desk renewal", amount: 5000, vatAmount: 250, paidVia: "BANK_TRANSFER", bankAccountId: ids.bank,
    });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^LUX-EXP-/);
  });

  it("calculates the VAT201 return", async () => {
    const r = await ctx.http().get(api(`/finance/vat/report?from=${today()}&to=${today()}`)).set(accounts);
    expect(r.status).toBe(200);
    expect(r.body.boxes["1c"]).toEqual({ amountAed: "12420.00", vatAed: "621.00" }); // Sharjah: 13,800 − 1,380
    expect(r.body.boxes["4"]).toEqual({ amountAed: "1500.00", vatAed: "0.00" }); // export
    expect(r.body.boxes["6"]).toEqual({ amountAed: "22640.00", vatAed: "1132.00" }); // import reverse charge
    expect(r.body.boxes["9"]).toEqual({ amountAed: "5800.00", vatAed: "290.00" }); // freight + rent
    expect(r.body.boxes["10"]).toEqual({ amountAed: "22640.00", vatAed: "1132.00" });
    expect(r.body).toMatchObject({ box12_totalDueTaxAed: "1753.00", box13_totalRecoverableTaxAed: "1422.00", box14_payableTaxAed: "331.00", result: "PAYABLE" });

    const saved = await ctx.http().post(api("/finance/vat/returns")).set(accounts).send({ from: today(), to: today() });
    expect(saved.body.netVatDue).toBe("331");
    expect((await ctx.http().get(api(`/finance/vat/report?from=${today()}&to=${today()}`)).set(sales)).status).toBe(403);
  });

  it("keeps the books balanced", async () => {
    const tb = await ctx.http().get(api("/finance/reports/trial-balance")).set(admin);
    expect(tb.body.balanced).toBe(true);
    const bs = await ctx.http().get(api("/finance/reports/balance-sheet")).set(admin);
    expect(bs.body.balanced).toBe(true);
    expect(await account("1100")).toBe(1500); // only the export invoice is open
    expect(await account("1200")).toBe(20 * 566); // 40 in − 20 − 2 export + 2 returned
  });

  it("reports profit, ageing and sales", async () => {
    const pl = await ctx.http().get(api(`/finance/reports/profit-loss?from=${today()}&to=${today()}`)).set(admin);
    // sales 13,800 + 1,500 − returns 1,380 = 13,920; COGS 20 × 566 = 11,320; rent 5,000
    expect(pl.body).toMatchObject({ costOfSales: "11320.00", grossProfitOnGoods: "2600.00", netProfit: "-2400.00" });

    const aged = await ctx.http().get(api("/finance/reports/aged-receivables")).set(admin);
    expect(aged.body.rows).toHaveLength(1);
    expect(aged.body.rows[0]).toMatchObject({ companyName: "Al Salmiya Perfumes Co.", current: "1500.00", total: "1500.00" });

    const brand = await ctx.http().get(api(`/finance/reports/profit-by-brand?from=${today()}&to=${today()}`)).set(admin);
    expect(brand.body.rows[0]).toMatchObject({ brand: "Initio", units: 22, revenueAed: "15300.00", costAed: "12452.00" });

    const summary = await ctx.http().get(api(`/finance/reports/sales-summary?from=${today()}&to=${today()}`)).set(admin);
    expect(summary.body.byChannel.map((r: { key: string }) => r.key).sort()).toEqual(["EXPORT", "WHOLESALE"]);
  });

  it("can reverse a manual journal, but only once", async () => {
    const je = await ctx.http().post(api("/finance/journals")).set(accounts).send({ date: today(), memo: "Test", lines: [{ account: "6900", debit: 10 }, { account: "1000", credit: 10 }] });
    await ctx.http().post(api(`/finance/journals/${je.body.id}/reverse`)).set(accounts).send({}).expect(201);
    expect((await ctx.http().post(api(`/finance/journals/${je.body.id}/reverse`)).set(accounts).send({})).status).toBe(400);
    expect((await ctx.http().post(api("/finance/journals")).set(accounts).send({ date: today(), memo: "Bad", lines: [{ account: "6900", debit: 10 }, { account: "1000", credit: 9 }] })).status).toBe(400);
  });
});
