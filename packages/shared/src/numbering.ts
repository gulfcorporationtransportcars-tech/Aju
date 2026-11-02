/** LUX-INV-2026-0001 */
export const formatDocNumber = (prefix: string, docType: string, year: number, n: number, padding = 4): string =>
  `${prefix}-${docType}-${year}-${String(n).padStart(padding, "0")}`;

export const DOC_TYPES = {
  INVOICE: "INV",
  QUOTATION: "QT",
  SALES_ORDER: "SO",
  WEB_ORDER: "WEB",
  DELIVERY_NOTE: "DN",
  PURCHASE_ORDER: "PO",
  GOODS_RECEIPT: "GRN",
  SUPPLIER_BILL: "BILL",
  CREDIT_NOTE: "CN",
  PAYMENT: "PAY",
  EXPENSE: "EXP",
  JOURNAL: "JE",
  SHIPMENT: "SHP",
  STOCK_TAKE: "STK",
  CAMPAIGN: "CMP",
  PROPOSAL: "PRP",
  AD_CONTRACT: "AGC",
} as const;

export type DocType = (typeof DOC_TYPES)[keyof typeof DOC_TYPES];
