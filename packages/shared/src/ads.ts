import { d, Num, round2, Decimal } from "./money";

const safeDiv = (a: Num, b: Num, scale = 1): Decimal =>
  d(b).isZero() ? d(0) : round2(d(a).dividedBy(b).times(scale));

/** Return on ad spend: revenue ÷ spend (e.g. 4.25 = AED 4.25 per AED 1). */
export const roas = (revenue: Num, spend: Num) => safeDiv(revenue, spend);
/** Click-through rate %. */
export const ctr = (clicks: Num, impressions: Num) => safeDiv(clicks, impressions, 100);
/** Cost per click. */
export const cpc = (spend: Num, clicks: Num) => safeDiv(spend, clicks);
/** Cost per 1,000 impressions. */
export const cpm = (spend: Num, impressions: Num) => safeDiv(spend, impressions, 1000);
/** Cost per lead. */
export const cpl = (spend: Num, leads: Num) => safeDiv(spend, leads);
/** Conversion rate %. */
export const conversionRate = (conversions: Num, clicks: Num) => safeDiv(conversions, clicks, 100);

export interface MediaBudgetState {
  toppedUpAed: Num;
  spentAed: Num;
  lowBalanceAlertAed: Num;
}

export function mediaBudgetStatus(b: MediaBudgetState) {
  const balance = d(b.toppedUpAed).minus(b.spentAed);
  return { balance, isLow: balance.lessThanOrEqualTo(b.lowBalanceAlertAed), isOverspent: balance.isNegative() };
}

export interface Booking {
  startsAt: Date;
  endsAt: Date;
}

/** Two bookings overlap when one starts before the other ends. */
export const overlaps = (a: Booking, b: Booking): boolean => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Can a new booking fit in a slot with `maxConcurrent` bookings at once? */
export function canBookSlot(existing: Booking[], requested: Booking, maxConcurrent: number): boolean {
  // Check concurrency at every point where a booking starts inside the requested window.
  const points = [requested.startsAt, ...existing.map((e) => e.startsAt)].filter(
    (p) => p >= requested.startsAt && p < requested.endsAt,
  );
  return points.every((p) => existing.filter((e) => e.startsAt <= p && p < e.endsAt).length < maxConcurrent);
}

export const COMPLIANCE_ITEMS = [
  "brandPermissionOk",
  "authenticityProofOk",
  "pricingNotMisleading",
  "arabicCopyReviewed",
  "influencerPermitsOk",
  "companyMediaLicenceOk",
] as const;

export type ComplianceItems = Record<(typeof COMPLIANCE_ITEMS)[number], boolean>;

export const compliancePassed = (c: ComplianceItems): boolean => COMPLIANCE_ITEMS.every((k) => c[k] === true);
