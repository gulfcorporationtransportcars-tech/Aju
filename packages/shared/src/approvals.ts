export const APPROVAL_TYPES = [
  "DISCOUNT_BELOW_MIN",
  "CREDIT_LIMIT_CHANGE",
  "PO_ABOVE_LIMIT",
  "PRICE_LIST_CHANGE",
  "STOCK_WRITE_OFF",
  "CREDIT_NOTE",
  "CAMPAIGN_GO_LIVE",
  "CREATIVE_PUBLISH",
  "AGENCY_PROPOSAL",
  "MEDIA_BUDGET",
  "INFLUENCER_DEAL",
] as const;

export type ApprovalTypeKey = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_LABELS: Record<ApprovalTypeKey, { en: string; ar: string }> = {
  DISCOUNT_BELOW_MIN: { en: "Price below minimum", ar: "سعر أقل من الحد الأدنى" },
  CREDIT_LIMIT_CHANGE: { en: "Credit limit change", ar: "تغيير حد الائتمان" },
  PO_ABOVE_LIMIT: { en: "Large purchase order", ar: "أمر شراء كبير" },
  PRICE_LIST_CHANGE: { en: "Price list change", ar: "تغيير قائمة الأسعار" },
  STOCK_WRITE_OFF: { en: "Stock write-off", ar: "شطب مخزون" },
  CREDIT_NOTE: { en: "Credit note", ar: "إشعار دائن" },
  CAMPAIGN_GO_LIVE: { en: "Campaign go-live", ar: "إطلاق حملة" },
  CREATIVE_PUBLISH: { en: "Publish ad creative", ar: "نشر تصميم إعلاني" },
  AGENCY_PROPOSAL: { en: "Agency proposal", ar: "عرض خدمات إعلانية" },
  MEDIA_BUDGET: { en: "Client media budget", ar: "ميزانية إعلانات العميل" },
  INFLUENCER_DEAL: { en: "Influencer deal", ar: "اتفاقية مؤثر" },
};

/** Default thresholds (AED). null = always needs approval. */
export const DEFAULT_APPROVAL_THRESHOLDS: Record<ApprovalTypeKey, number | null> = {
  DISCOUNT_BELOW_MIN: null,
  CREDIT_LIMIT_CHANGE: null,
  PO_ABOVE_LIMIT: 20000,
  PRICE_LIST_CHANGE: null,
  STOCK_WRITE_OFF: null,
  CREDIT_NOTE: null,
  CAMPAIGN_GO_LIVE: null,
  CREATIVE_PUBLISH: null,
  AGENCY_PROPOSAL: null,
  MEDIA_BUDGET: null,
  INFLUENCER_DEAL: null,
};

/** Is approval required for this amount under the threshold rule? */
export const needsApproval = (threshold: number | null | undefined, amountAed?: number): boolean =>
  threshold == null || amountAed == null || amountAed > threshold;

export interface DelegationWindow {
  fromUserId: string;
  toUserId: string;
  types: string[]; // empty = all
  startsAt: Date;
  endsAt: Date;
  revokedAt?: Date | null;
}

/** If the approver has an active delegation for this type, return the delegate. */
export function resolveDelegate(
  approverId: string,
  type: string,
  delegations: DelegationWindow[],
  now: Date = new Date(),
): string {
  const active = delegations.find(
    (dl) =>
      dl.fromUserId === approverId &&
      !dl.revokedAt &&
      dl.startsAt <= now &&
      dl.endsAt >= now &&
      (dl.types.length === 0 || dl.types.includes(type)),
  );
  return active ? active.toUserId : approverId;
}
