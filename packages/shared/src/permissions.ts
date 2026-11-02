/**
 * Permission keys are "module:action". "*" = everything, "module:*" = every action in a module.
 * The server checks these on every request.
 */
export const PERMISSIONS = {
  // core
  USER_READ: "user:read",
  USER_MANAGE: "user:manage",
  SETTINGS_MANAGE: "settings:manage",
  AUDIT_READ: "audit:read",
  APPROVAL_READ: "approval:read",
  APPROVAL_DECIDE: "approval:decide",
  APPROVAL_DELEGATE: "approval:delegate",
  // catalogue
  CATALOGUE_READ: "catalogue:read",
  CATALOGUE_MANAGE: "catalogue:manage",
  PRICE_READ_COST: "price:read_cost",
  PRICE_MANAGE: "price:manage",
  // inventory
  INVENTORY_READ: "inventory:read",
  INVENTORY_MOVE: "inventory:move",
  INVENTORY_ADJUST: "inventory:adjust",
  WAREHOUSE_MANAGE: "warehouse:manage",
  // purchasing
  PURCHASING_READ: "purchasing:read",
  PURCHASING_MANAGE: "purchasing:manage",
  // sales & crm
  CRM_READ: "crm:read",
  CRM_MANAGE: "crm:manage",
  SALES_READ: "sales:read",
  SALES_MANAGE: "sales:manage",
  DELIVERY_MANAGE: "delivery:manage",
  COMMISSION_READ_OWN: "commission:read_own",
  COMMISSION_READ_ALL: "commission:read_all",
  // finance
  FINANCE_READ: "finance:read",
  FINANCE_MANAGE: "finance:manage",
  VAT_MANAGE: "vat:manage",
  REPORT_FINANCE: "report:finance",
  // advertising
  MARKETING_READ: "marketing:read",
  MARKETING_MANAGE: "marketing:manage",
  CAMPAIGN_APPROVE: "campaign:approve",
  AGENCY_READ: "agency:read",
  AGENCY_MANAGE: "agency:manage",
  // company
  DOCUMENT_READ: "document:read",
  DOCUMENT_MANAGE: "document:manage",
  HR_READ: "hr:read",
  HR_MANAGE: "hr:manage",
  SHIPPING_MANAGE: "shipping:manage",
  // outside users
  PORTAL_B2B: "portal_b2b:*",
  PORTAL_CLIENT: "portal_client:*",
  STORE: "store:*",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS] | "*";

export const ROLE_KEYS = [
  "SUPER_ADMIN",
  "SALES",
  "WAREHOUSE",
  "ACCOUNTANT",
  "MARKETING",
  "AD_CLIENT",
  "B2B_CUSTOMER",
  "RETAIL_CUSTOMER",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

const P = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  SUPER_ADMIN: ["*"],
  SALES: [
    P.CATALOGUE_READ, P.INVENTORY_READ, P.CRM_READ, P.CRM_MANAGE, P.SALES_READ, P.SALES_MANAGE,
    P.COMMISSION_READ_OWN, P.APPROVAL_READ,
  ],
  WAREHOUSE: [
    P.CATALOGUE_READ, P.INVENTORY_READ, P.INVENTORY_MOVE, P.INVENTORY_ADJUST, P.PURCHASING_READ,
    P.SALES_READ, P.DELIVERY_MANAGE, P.SHIPPING_MANAGE, P.APPROVAL_READ,
  ],
  ACCOUNTANT: [
    P.CATALOGUE_READ, P.PRICE_READ_COST, P.INVENTORY_READ, P.PURCHASING_READ, P.PURCHASING_MANAGE,
    P.CRM_READ, P.SALES_READ, P.FINANCE_READ, P.FINANCE_MANAGE, P.VAT_MANAGE, P.REPORT_FINANCE,
    P.COMMISSION_READ_ALL, P.AGENCY_READ, P.DOCUMENT_READ, P.HR_READ, P.APPROVAL_READ,
  ],
  MARKETING: [
    P.CATALOGUE_READ, P.INVENTORY_READ, P.CRM_READ, P.MARKETING_READ, P.MARKETING_MANAGE,
    P.AGENCY_READ, P.AGENCY_MANAGE, P.DOCUMENT_READ, P.APPROVAL_READ,
  ],
  AD_CLIENT: [P.PORTAL_CLIENT],
  B2B_CUSTOMER: [P.PORTAL_B2B],
  RETAIL_CUSTOMER: [P.STORE],
};

/** Does a set of granted keys satisfy one required key? */
export function hasPermission(granted: readonly string[], required: string): boolean {
  if (granted.includes("*") || granted.includes(required)) return true;
  const [module] = required.split(":");
  return granted.includes(`${module}:*`);
}

export const hasAllPermissions = (granted: readonly string[], required: readonly string[]): boolean =>
  required.every((r) => hasPermission(granted, r));
