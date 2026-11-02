/**
 * Core reference data that every LUXORA Hub install needs:
 * roles + permissions, approval rules, currencies, countries, warehouses,
 * company profile, and the Manager (Super Admin) account.
 *
 * Safe to run more than once (everything is an upsert).
 * The full demo data (brands, products, customers, campaigns) is Step 7.
 */
import * as argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
import {
  APPROVAL_TYPES,
  DEFAULT_APPROVAL_THRESHOLDS,
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
} from "@luxora/shared";

const ROLE_NAMES: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "Super Admin / Manager",
  SALES: "Sales Executive",
  WAREHOUSE: "Warehouse / Logistics",
  ACCOUNTANT: "Accountant",
  MARKETING: "Marketing Manager",
  AD_CLIENT: "Ad Client (external)",
  B2B_CUSTOMER: "B2B Customer (external)",
  RETAIL_CUSTOMER: "Retail Customer (external)",
};

export const COMPANY_PROFILE = {
  legalName: "LUXORA Perfume & Cosmetics Trading LLC",
  legalNameAr: "لوكسورا لتجارة العطور ومستحضرات التجميل ش.ذ.م.م",
  companyType: "Limited Liability Company",
  registrationAuthority: "Sharjah Media City Free Zone Authority (SHAMS)",
  formationNumber: "2541889",
  licenceNumber: "2541889.01",
  licenceIssuedOn: "2025-10-28",
  licenceExpiresOn: "2026-10-27",
  manager: { name: "Althaf Najeeb", title: "Manager" },
  registeredAddress: "Shams Business Center, Sharjah Media City Free Zone, Al Messaned, Sharjah, UAE",
  facilityType: "Flexi Desk",
  businessAddress: "44-12 Al Daghaya Street, Al Daghaya, Deira, Dubai, UAE",
  phone: "+971 55 389 4353",
  trn: null as string | null, // add when VAT registration certificate is available
  isFreeZone: true,
  licensedActivities: [
    "Wholesale of perfumery, cosmetics, beauty products and soaps",
    "Non-specialized wholesale trade",
    "General trading",
    "Retail sale of watches, clocks and jewellery",
    "Retail sale of products over the internet",
    "Online advertising",
    "Advertising agency",
  ],
};

const CURRENCIES = [
  { code: "AED", name: "UAE Dirham", symbol: "د.إ", isBase: true },
  { code: "USD", name: "US Dollar", symbol: "$", isBase: false },
  { code: "EUR", name: "Euro", symbol: "€", isBase: false },
  { code: "GBP", name: "Pound Sterling", symbol: "£", isBase: false },
  { code: "SAR", name: "Saudi Riyal", symbol: "ر.س", isBase: false },
];

const COUNTRIES = [
  { code: "AE", nameEn: "United Arab Emirates", nameAr: "الإمارات العربية المتحدة", isGcc: true },
  { code: "SA", nameEn: "Saudi Arabia", nameAr: "المملكة العربية السعودية", isGcc: true },
  { code: "KW", nameEn: "Kuwait", nameAr: "الكويت", isGcc: true },
  { code: "QA", nameEn: "Qatar", nameAr: "قطر", isGcc: true },
  { code: "BH", nameEn: "Bahrain", nameAr: "البحرين", isGcc: true },
  { code: "OM", nameEn: "Oman", nameAr: "عُمان", isGcc: true },
  { code: "FR", nameEn: "France", nameAr: "فرنسا", isGcc: false },
  { code: "GB", nameEn: "United Kingdom", nameAr: "المملكة المتحدة", isGcc: false },
  { code: "IT", nameEn: "Italy", nameAr: "إيطاليا", isGcc: false },
  { code: "US", nameEn: "United States", nameAr: "الولايات المتحدة", isGcc: false },
  { code: "TR", nameEn: "Türkiye", nameAr: "تركيا", isGcc: false },
  { code: "CH", nameEn: "Switzerland", nameAr: "سويسرا", isGcc: false },
  { code: "SE", nameEn: "Sweden", nameAr: "السويد", isGcc: false },
  { code: "IN", nameEn: "India", nameAr: "الهند", isGcc: false },
];

/**
 * Chart of accounts. "system" accounts are used by automatic postings and cannot be
 * deleted. Codes are referenced in apps/api/src/finance/ledger/accounts.ts.
 */
export const CHART_OF_ACCOUNTS: { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }[] = [
  // Assets
  { code: "1000", name: "Cash on hand", type: "ASSET" },
  { code: "1010", name: "Bank: main AED account", type: "ASSET" },
  { code: "1050", name: "Cheques in hand (PDC receivable)", type: "ASSET" },
  { code: "1100", name: "Accounts receivable", type: "ASSET" },
  { code: "1200", name: "Inventory", type: "ASSET" },
  { code: "1300", name: "VAT input (recoverable)", type: "ASSET" },
  { code: "1400", name: "Prepayments & deposits", type: "ASSET" },
  // Liabilities
  { code: "2000", name: "Accounts payable", type: "LIABILITY" },
  { code: "2050", name: "Goods received not invoiced", type: "LIABILITY" },
  { code: "2100", name: "VAT output payable", type: "LIABILITY" },
  { code: "2150", name: "Client media funds held", type: "LIABILITY" },
  { code: "2200", name: "Customer advances", type: "LIABILITY" },
  { code: "2300", name: "Salaries & commissions payable", type: "LIABILITY" },
  // Equity
  { code: "3000", name: "Share capital", type: "EQUITY" },
  { code: "3100", name: "Retained earnings", type: "EQUITY" },
  { code: "3900", name: "Opening balance equity", type: "EQUITY" },
  // Income
  { code: "4000", name: "Sales: wholesale & B2B", type: "INCOME" },
  { code: "4010", name: "Sales: online store", type: "INCOME" },
  { code: "4020", name: "Sales: export", type: "INCOME" },
  { code: "4100", name: "Advertising agency services", type: "INCOME" },
  { code: "4200", name: "Ad space income", type: "INCOME" },
  { code: "4900", name: "Sales returns & credit notes", type: "INCOME" },
  // Cost of sales & expenses
  { code: "5000", name: "Cost of goods sold", type: "EXPENSE" },
  { code: "5100", name: "Stock write-offs & damage", type: "EXPENSE" },
  { code: "5110", name: "Samples & testers", type: "EXPENSE" },
  { code: "5120", name: "Influencer gifted products", type: "EXPENSE" },
  { code: "5200", name: "Media spend recharged to clients", type: "EXPENSE" },
  { code: "6000", name: "Advertising & marketing", type: "EXPENSE" },
  { code: "6100", name: "Salaries & commissions", type: "EXPENSE" },
  { code: "6200", name: "Rent, licence & government fees", type: "EXPENSE" },
  { code: "6300", name: "Bank charges", type: "EXPENSE" },
  { code: "6400", name: "Courier & delivery", type: "EXPENSE" },
  { code: "6500", name: "Office & IT", type: "EXPENSE" },
  { code: "6900", name: "Other expenses", type: "EXPENSE" },
  { code: "7000", name: "Exchange gains & losses", type: "EXPENSE" },
];

export interface SeedCoreOptions {
  managerEmail: string;
  managerPassword: string;
}

export async function seedCore(prisma: PrismaClient, opts: SeedCoreOptions) {
  // Permissions
  const allKeys = new Set<string>(["*", ...Object.values(PERMISSIONS)]);
  for (const key of allKeys) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, module: key === "*" ? "all" : key.split(":")[0] },
    });
  }

  // Roles + their permissions
  for (const roleKey of ROLE_KEYS) {
    const role = await prisma.role.upsert({
      where: { key: roleKey },
      update: { name: ROLE_NAMES[roleKey] },
      create: { key: roleKey, name: ROLE_NAMES[roleKey], isSystem: true },
    });
    const perms = await prisma.permission.findMany({ where: { key: { in: ROLE_PERMISSIONS[roleKey] } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
  }

  // Approval rules: the Manager approves everything by default
  for (const type of APPROVAL_TYPES) {
    await prisma.approvalRule.upsert({
      where: { type },
      update: {},
      create: { type, approverRoleKey: "SUPER_ADMIN", thresholdAed: DEFAULT_APPROVAL_THRESHOLDS[type] },
    });
  }

  for (const c of CURRENCIES) await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  // USD is pegged at 3.6725
  await prisma.exchangeRate.upsert({
    where: { currencyCode_effectiveOn: { currencyCode: "USD", effectiveOn: new Date("2025-01-01") } },
    update: {},
    create: { currencyCode: "USD", rateToAed: "3.6725", effectiveOn: new Date("2025-01-01"), source: "peg" },
  });
  for (const c of COUNTRIES) await prisma.country.upsert({ where: { code: c.code }, update: {}, create: c });

  await prisma.warehouse.upsert({
    where: { code: "DXB-DEIRA" },
    update: {},
    create: { code: "DXB-DEIRA", name: "Deira Warehouse", type: "OWN", address: "44-12 Al Daghaya Street, Al Daghaya, Deira", emirate: "Dubai" },
  });
  await prisma.warehouse.upsert({
    where: { code: "IN-TRANSIT" },
    update: {},
    create: { code: "IN-TRANSIT", name: "In Transit", type: "IN_TRANSIT" },
  });

  for (const a of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({ where: { code: a.code }, update: {}, create: { ...a, isSystem: true } });
  }
  const bankLedger = await prisma.account.findUniqueOrThrow({ where: { code: "1010" } });
  await prisma.bankAccount.upsert({
    where: { accountId: bankLedger.id },
    update: {},
    create: { accountId: bankLedger.id, bankName: "Main bank", accountName: COMPANY_PROFILE.legalName, currencyCode: "AED" },
  });

  await prisma.setting.upsert({ where: { key: "company.profile" }, update: {}, create: { key: "company.profile", value: COMPANY_PROFILE } });
  await prisma.setting.upsert({
    where: { key: "numbering" },
    update: {},
    create: { key: "numbering", value: { prefix: "LUX", padding: 4 } },
  });

  // The Manager: Super Admin, signatory on invoices and contracts
  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  const manager = await prisma.user.upsert({
    where: { email: opts.managerEmail },
    update: {},
    create: {
      type: "STAFF",
      email: opts.managerEmail,
      phone: "+971553894353",
      fullName: "Althaf Najeeb",
      title: "Manager",
      isSignatory: true,
      roleId: superAdmin.id,
      passwordHash: await argon2.hash(opts.managerPassword),
    },
  });

  return { managerId: manager.id };
}

// CLI: `pnpm --filter @luxora/db seed`
if (require.main === module) {
  const managerEmail = process.env.MANAGER_EMAIL ?? "althaf@luxora.ae";
  const managerPassword = process.env.MANAGER_PASSWORD;
  if (!managerPassword) {
    console.error("Set MANAGER_PASSWORD before seeding (the Manager's first login password).");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  seedCore(prisma, { managerEmail, managerPassword })
    .then(() => console.log(`Core data ready. Manager login: ${managerEmail}`))
    .finally(() => prisma.$disconnect());
}
