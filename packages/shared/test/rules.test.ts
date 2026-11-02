import { describe, expect, it } from "vitest";
import {
  canBookSlot,
  compliancePassed,
  cpm,
  ctr,
  daysUntil,
  dueExpiryAlert,
  formatDocNumber,
  hasPermission,
  InsufficientStockError,
  mediaBudgetStatus,
  needsApproval,
  pickFefo,
  resolveDelegate,
  roas,
  ROLE_PERMISSIONS,
} from "../src";

describe("FEFO picking", () => {
  const b = (id: string, available: number, expires: string | null, created = "2026-01-01") => ({
    batchId: id,
    warehouseId: "W1",
    available,
    expiresOn: expires ? new Date(expires) : null,
    createdAt: new Date(created),
  });

  it("takes the batch that expires first, then the next", () => {
    const picks = pickFefo([b("late", 10, "2029-01-01"), b("soon", 4, "2027-06-01"), b("none", 50, null)], 9);
    expect(picks).toEqual([
      { batchId: "soon", warehouseId: "W1", quantity: 4 },
      { batchId: "late", warehouseId: "W1", quantity: 5 },
    ]);
  });

  it("throws when there is not enough stock", () => {
    expect(() => pickFefo([b("a", 2, null)], 3)).toThrow(InsufficientStockError);
  });
});

describe("permissions", () => {
  it("handles *, module:* and exact keys", () => {
    expect(hasPermission(ROLE_PERMISSIONS.SUPER_ADMIN, "campaign:approve")).toBe(true);
    expect(hasPermission(ROLE_PERMISSIONS.B2B_CUSTOMER, "portal_b2b:order")).toBe(true);
    expect(hasPermission(ROLE_PERMISSIONS.SALES, "sales:manage")).toBe(true);
    expect(hasPermission(ROLE_PERMISSIONS.SALES, "finance:manage")).toBe(false);
    expect(hasPermission(ROLE_PERMISSIONS.MARKETING, "campaign:approve")).toBe(false);
  });
});

describe("approvals", () => {
  it("applies thresholds", () => {
    expect(needsApproval(20000, 15000)).toBe(false);
    expect(needsApproval(20000, 25000)).toBe(true);
    expect(needsApproval(null, 1)).toBe(true);
  });

  it("routes to the Manager's delegate during the delegation window", () => {
    const dl = [{ fromUserId: "althaf", toUserId: "deputy", types: ["PO_ABOVE_LIMIT"], startsAt: new Date("2026-11-01"), endsAt: new Date("2026-11-10") }];
    expect(resolveDelegate("althaf", "PO_ABOVE_LIMIT", dl, new Date("2026-11-05"))).toBe("deputy");
    expect(resolveDelegate("althaf", "CAMPAIGN_GO_LIVE", dl, new Date("2026-11-05"))).toBe("althaf");
    expect(resolveDelegate("althaf", "PO_ABOVE_LIMIT", dl, new Date("2026-11-20"))).toBe("althaf");
  });
});

describe("advertising maths", () => {
  it("computes ROAS, CTR, CPM", () => {
    expect(roas(42500, 10000).toNumber()).toBe(4.25);
    expect(ctr(150, 10000).toNumber()).toBe(1.5);
    expect(cpm(250, 100000).toNumber()).toBe(2.5);
    expect(roas(100, 0).toNumber()).toBe(0);
  });

  it("tracks client media budget balance", () => {
    expect(mediaBudgetStatus({ toppedUpAed: 5000, spentAed: 4600, lowBalanceAlertAed: 500 })).toMatchObject({ isLow: true, isOverspent: false });
    expect(mediaBudgetStatus({ toppedUpAed: 5000, spentAed: 5100, lowBalanceAlertAed: 500 }).isOverspent).toBe(true);
  });

  it("prevents overlapping ad slot bookings", () => {
    const existing = [{ startsAt: new Date("2026-12-01"), endsAt: new Date("2026-12-08") }];
    expect(canBookSlot(existing, { startsAt: new Date("2026-12-05"), endsAt: new Date("2026-12-10") }, 1)).toBe(false);
    expect(canBookSlot(existing, { startsAt: new Date("2026-12-08"), endsAt: new Date("2026-12-15") }, 1)).toBe(true);
    expect(canBookSlot(existing, { startsAt: new Date("2026-12-05"), endsAt: new Date("2026-12-10") }, 2)).toBe(true);
    expect(canBookSlot(existing, { startsAt: new Date("2026-11-25"), endsAt: new Date("2026-12-31") }, 1)).toBe(false);
  });

  it("passes compliance only when all six checks are ticked", () => {
    const all = { brandPermissionOk: true, authenticityProofOk: true, pricingNotMisleading: true, arabicCopyReviewed: true, influencerPermitsOk: true, companyMediaLicenceOk: true };
    expect(compliancePassed(all)).toBe(true);
    expect(compliancePassed({ ...all, influencerPermitsOk: false })).toBe(false);
  });
});

describe("numbering and expiry", () => {
  it("formats document numbers", () => {
    expect(formatDocNumber("LUX", "INV", 2026, 7)).toBe("LUX-INV-2026-0007");
  });

  it("works out licence expiry alerts", () => {
    const expiry = new Date("2026-10-27T00:00:00+04:00");
    expect(daysUntil(expiry, new Date("2026-07-29T10:00:00+04:00"))).toBe(90);
    expect(dueExpiryAlert(expiry, [], new Date("2026-08-10T10:00:00+04:00"))).toBe(90);
    expect(dueExpiryAlert(expiry, [90], new Date("2026-08-10T10:00:00+04:00"))).toBe(null);
    expect(dueExpiryAlert(expiry, [90, 60, 30, 7], new Date("2026-11-02T10:00:00+04:00"))).toBe(0); // expired
  });
});
