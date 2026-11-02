import { StockService } from "../src/trading/inventory/stock.service";
import { MANAGER, setup, teardown, TestContext } from "./helpers";

let ctx: TestContext;
let admin: Record<string, string>;
let warehouseId: string;
let variantId: string;

beforeAll(async () => {
  ctx = await setup();
  admin = { Authorization: `Bearer ${await ctx.login(MANAGER.email)}` };
  warehouseId = (await ctx.prisma.warehouse.findUniqueOrThrow({ where: { code: "DXB-DEIRA" } })).id;
});
afterAll(() => teardown(ctx));

const as = async (email: string) => ({ Authorization: `Bearer ${await ctx.login(email)}` });

describe("catalogue", () => {
  it("creates a brand and a product with variants", async () => {
    const brand = await ctx.http().post("/api/v1/catalogue/brands").set(admin).send({ name: "Parfums de Marly", category: "NICHE", originCountryCode: "FR" });
    expect(brand.status).toBe(201);
    expect(brand.body.slug).toBe("parfums-de-marly");

    const product = await ctx.http().post("/api/v1/catalogue/products").set(admin).send({
      brandId: brand.body.id,
      nameEn: "Layton",
      nameAr: "لايتون",
      gender: "MEN",
      concentration: "EDP",
      variants: [
        { sku: "PDM-LAYTON-125", barcode: "3700578518002", sizeMl: 125, costAed: 520, wholesaleAAed: 610, wholesaleBAed: 630, wholesaleCAed: 650, retailPriceAed: 1150, minSellingPriceAed: 590, reorderLevel: 6 },
        { sku: "PDM-LAYTON-125-T", sizeMl: 125, packType: "TESTER", isSealed: false, costAed: 430, wholesaleCAed: 520, minSellingPriceAed: 480 },
      ],
    });
    expect(product.status).toBe(201);
    expect(product.body.slug).toBe("parfums-de-marly-layton-edp");
    expect(product.body.variants).toHaveLength(2);
    variantId = product.body.variants.find((v: { sku: string }) => v.sku === "PDM-LAYTON-125").id;
  });

  it("hides cost prices from sales staff", async () => {
    const res = await ctx.http().get("/api/v1/catalogue/variants/by-barcode/3700578518002").set(await as("sales@luxora.ae"));
    expect(res.status).toBe(200);
    expect(res.body.wholesaleAAed).toBe("610");
    expect(res.body.costAed).toBeUndefined();
  });

  it("stops staff without price:manage from changing prices", async () => {
    const res = await ctx.http().patch(`/api/v1/catalogue/variants/${variantId}`).set(await as("marketing@luxora.ae")).send({ retailPriceAed: 999 });
    expect(res.status).toBe(403);
  });

  it("keeps a price history", async () => {
    await ctx.http().patch(`/api/v1/catalogue/variants/${variantId}`).set(admin).send({ wholesaleCAed: 660 }).expect(200);
    const hist = await ctx.http().get(`/api/v1/catalogue/variants/${variantId}/price-history`).set(admin);
    expect(hist.body[0]).toMatchObject({ field: "wholesaleCAed", oldValue: "650", newValue: "660" });
  });

  it("finds products by search", async () => {
    const res = await ctx.http().get("/api/v1/catalogue/products?q=layton").set(admin);
    expect(res.body.total).toBe(1);
  });
});

describe("inventory", () => {
  it("loads opening stock in two batches and averages the cost", async () => {
    const res = await ctx.http().post("/api/v1/inventory/opening-stock").set(admin).send({
      lines: [
        { variantId, warehouseId, batchNo: "LATE-2029", quantity: 10, unitCostAed: 500, expiresOn: "2029-06-01" },
        { variantId, warehouseId, batchNo: "SOON-2027", quantity: 4, unitCostAed: 540, expiresOn: "2027-03-01" },
      ],
    });
    expect(res.status).toBe(201);
    const detail = await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin);
    expect(detail.body.onHand).toBe(14);
    expect(detail.body.levels[0].batch.batchNo).toBe("SOON-2027"); // earliest expiry first
    const v = await ctx.prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    // first receipt resets average from 520 (no stock) to 500, then (10×500 + 4×540) / 14 = 511.43
    expect(v.costAed.toString()).toBe("511.43");
  });

  it("reserves stock FEFO and never reserves more than is free", async () => {
    const stock = ctx.app.get(StockService);
    const picks = await ctx.prisma.$transaction((tx) => stock.reserve(tx, variantId, 6));
    expect(picks.map((p) => [p.quantity])).toEqual([[4], [2]]); // all of SOON-2027, then LATE-2029
    await expect(ctx.prisma.$transaction((tx) => stock.reserve(tx, variantId, 9))).rejects.toThrow(/Insufficient stock/);

    // two orders at the same moment for the last 8 units: only one can win
    const results = await Promise.allSettled([
      ctx.prisma.$transaction((tx) => stock.reserve(tx, variantId, 8)),
      ctx.prisma.$transaction((tx) => stock.reserve(tx, variantId, 8)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const detail = await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin);
    expect(detail.body.reserved).toBe(14);
  });

  it("shows the item in the low-stock list once everything is reserved", async () => {
    const res = await ctx.http().get("/api/v1/inventory/stock?lowStock=true").set(admin);
    expect(res.body.items.map((i: { sku: string }) => i.sku)).toContain("PDM-LAYTON-125");
  });

  it("lists batches expiring within 18 months", async () => {
    const res = await ctx.http().get("/api/v1/inventory/expiring?days=550").set(admin);
    expect(res.body.map((l: { batch: { batchNo: string } }) => l.batch.batchNo)).toEqual(["SOON-2027"]);
  });

  it("does not allow writing off stock that is reserved for orders", async () => {
    const batch = await ctx.prisma.batch.findFirstOrThrow({ where: { batchNo: "LATE-2029" } });
    const res = await ctx.http().post("/api/v1/inventory/adjustments").set(await as("store@luxora.ae"))
      .send({ variantId, warehouseId, batchId: batch.id, type: "DAMAGE", quantity: 1, reason: "Broken bottle" });
    expect(res.status).toBe(400);
  });
});

describe("approvals: stock write-off", () => {
  let approvalId: string;
  let batchId: string;

  beforeAll(async () => {
    // free up stock: release everything reserved above
    const stock = ctx.app.get(StockService);
    const levels = await ctx.prisma.stockLevel.findMany({ where: { variantId } });
    await ctx.prisma.$transaction((tx) => stock.release(tx, variantId, levels.map((l) => ({ batchId: l.batchId, warehouseId: l.warehouseId, quantity: l.reserved }))));
    batchId = (await ctx.prisma.batch.findFirstOrThrow({ where: { batchNo: "LATE-2029" } })).id;
  });

  it("puts a warehouse write-off in the Manager's inbox without touching stock", async () => {
    const res = await ctx.http().post("/api/v1/inventory/adjustments").set(await as("store@luxora.ae"))
      .send({ variantId, warehouseId, batchId, type: "DAMAGE", quantity: 2, reason: "Two bottles broken in delivery" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("PENDING_APPROVAL");
    approvalId = res.body.approval.id;

    const inbox = await ctx.http().get("/api/v1/approvals?status=PENDING").set(admin);
    expect(inbox.body.items[0]).toMatchObject({ id: approvalId, type: "STOCK_WRITE_OFF", amountAed: "1000", assignedTo: { fullName: "Althaf Najeeb" } });
    expect((await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin)).body.onHand).toBe(14);

    const notes = await ctx.prisma.notification.findMany({ where: { user: { email: MANAGER.email } } });
    expect(notes.map((n) => n.channel).sort()).toEqual(["EMAIL", "IN_APP", "PUSH", "WHATSAPP"]);
  });

  it("does not let the requester or other staff approve it", async () => {
    expect((await ctx.http().post(`/api/v1/approvals/${approvalId}/approve`).set(await as("store@luxora.ae")).send({})).status).toBe(403);
    expect((await ctx.http().post(`/api/v1/approvals/${approvalId}/approve`).set(await as("accounts@luxora.ae")).send({})).status).toBe(403);
  });

  it("applies the write-off when the Manager approves, with an audit trail", async () => {
    const res = await ctx.http().post(`/api/v1/approvals/${approvalId}/approve`).set(admin).send({ note: "OK, claim from courier" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect((await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin)).body.onHand).toBe(12);

    const mv = await ctx.prisma.stockMovement.findFirstOrThrow({ where: { refType: "StockAdjustment" } });
    expect(mv).toMatchObject({ type: "DAMAGE", quantity: -2 });
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: "APPROVE", entityType: "StockAdjustment" } });
    expect(audit).not.toBeNull();
    // cannot be approved twice
    expect((await ctx.http().post(`/api/v1/approvals/${approvalId}/approve`).set(admin).send({})).status).toBe(409);
  });

  it("applies the Manager's own adjustment straight away, still recorded as approved", async () => {
    const res = await ctx.http().post("/api/v1/inventory/adjustments").set(admin)
      .send({ variantId, warehouseId, batchId, type: "TESTER_USE", quantity: 1, reason: "Opened as shop tester" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("APPLIED");
    expect(res.body.approval.decisionNote).toMatch(/own action/);
    expect((await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin)).body.onHand).toBe(11);
  });

  it("routes approvals to the Manager's delegate while he is away", async () => {
    const accountant = await ctx.prisma.user.findUniqueOrThrow({ where: { email: "accounts@luxora.ae" } });
    const now = Date.now();
    await ctx.http().post("/api/v1/approvals/delegations").set(admin)
      .send({ toUserId: accountant.id, types: ["STOCK_WRITE_OFF"], startsAt: new Date(now - 60_000), endsAt: new Date(now + 86_400_000), reason: "Travelling" })
      .expect(201);

    const res = await ctx.http().post("/api/v1/inventory/adjustments").set(await as("store@luxora.ae"))
      .send({ variantId, warehouseId, batchId, type: "SAMPLE", quantity: 1, reason: "Sample for salon client" });
    expect(res.body.approval.assignedToId).toBe(accountant.id);

    const approve = await ctx.http().post(`/api/v1/approvals/${res.body.approval.id}/approve`).set(await as("accounts@luxora.ae")).send({});
    expect(approve.status).toBe(200);
    expect((await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin)).body.onHand).toBe(10);
  });

  it("only lets the Manager create delegations", async () => {
    const res = await ctx.http().post("/api/v1/approvals/delegations").set(await as("accounts@luxora.ae"))
      .send({ toUserId: "x", startsAt: new Date(), endsAt: new Date(Date.now() + 1000) });
    expect(res.status).toBe(403);
  });
});

describe("stock-take", () => {
  it("counts a warehouse and applies the difference after approval", async () => {
    const store = await as("store@luxora.ae");
    const st = await ctx.http().post("/api/v1/inventory/stock-takes").set(store).send({ warehouseId });
    expect(st.status).toBe(201);
    expect(st.body.number).toMatch(/^LUX-STK-\d{4}-0001$/);

    const lines = st.body.lines as { id: string; batchNo: string; systemQty: number }[];
    const counts = lines.map((l) => ({ lineId: l.id, countedQty: l.batchNo === "SOON-2027" ? l.systemQty - 1 : l.systemQty }));
    await ctx.http().patch(`/api/v1/inventory/stock-takes/${st.body.id}/counts`).set(store).send({ lines: counts }).expect(200);

    const submit = await ctx.http().post(`/api/v1/inventory/stock-takes/${st.body.id}/submit`).set(store);
    expect(submit.status).toBe(202);
    expect(submit.body).toMatchObject({ status: "PENDING_APPROVAL", differences: 1, valueAed: 540 });

    // still delegated to the accountant
    await ctx.http().post(`/api/v1/approvals/${submit.body.approval.id}/approve`).set(await as("accounts@luxora.ae")).send({}).expect(200);
    expect((await ctx.http().get(`/api/v1/inventory/stock/${variantId}`).set(admin)).body.onHand).toBe(9);
    expect((await ctx.prisma.stockTake.findUniqueOrThrow({ where: { id: st.body.id } })).status).toBe("APPROVED");
  });
});
