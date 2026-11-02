# Step 2: Database Schema

**File:** `packages/db/prisma/schema.prisma`
**First migration:** `packages/db/prisma/migrations/20261031000000_init/migration.sql`
**Size:** 125 tables, 75 enums (fixed lists of values) · PostgreSQL 16 · Prisma 6

The schema passes `prisma validate` and was applied to a real PostgreSQL 16 database
with `prisma migrate deploy`.

---

## 1. Ground rules

| Rule | How it is done |
|---|---|
| Money is exact | `Decimal(14,2)`, never floating point. Exchange rates use `Decimal(14,6)`. |
| VAT shown in AED | Invoices store `vatAmountAed` and `totalAed` next to the document currency, as the FTA requires |
| Stock and accounts are never edited | `StockMovement` and `JournalEntry` are append-only. A mistake is fixed with a reversing row (`reversalOfId`). |
| Fast stock reads | `StockLevel` holds the current `onHand` / `reserved` per variant + warehouse + batch, kept in sync with the movements |
| Two languages | Paired fields: `nameEn` / `nameAr`, `headlineEn` / `headlineAr`, and so on |
| Document numbers | `NumberSequence` produces `LUX-INV-2026-0001`, `LUX-QT-…`, `LUX-CMP-…` per type and year |
| Snapshots | Invoices copy the customer's TRN and address at issue time, so old invoices never change |

---

## 2. The main groups and how they connect

### Core: users, roles, approvals
```
Role ──< RolePermission >── Permission          ("sales_order:create", "campaign:approve", "*")
 │
 └──< User ──┬── customerId → Customer          (B2B portal login)
             ├── adClientId → AdClient          (ad client portal login)
             ├── RetailCustomer                 (shop account)
             └── Employee                       (staff HR record)

ApprovalRule (one per ApprovalType: approver role, AED threshold)
ApprovalRequest: type, entityType + entityId, requestedBy → assignedTo → decidedBy
ApprovalDelegation: Manager → other user, start/end dates, which types
AuditLog: who did what to which record, with before/after values
```
- **One approval inbox.** Every approval (discount, PO, campaign, creative, influencer deal...)
  is one `ApprovalRequest` row that points at its record with `entityType` + `entityId`.
- **The Manager's role** is stored in data, not hard-coded. Althaf Najeeb is a `User` with the
  `SUPER_ADMIN` role, `title = "Manager"` and `isSignatory = true`. `ApprovalRule.approverRoleKey`
  defaults to `SUPER_ADMIN`, and `ApprovalDelegation` lets him hand rights over for a set period.

### Catalogue
```
Brand ──< Product ──< ProductVariant (sku, barcode, size ml, tester/retail box, prices)
            │  ├──< ProductNote >── Note   (TOP / HEART / BASE)
            │  ├──< ProductImage
            │  └── FragranceFamily
            │
PriceList ──< PriceListItem >── ProductVariant    (tier A/B/C/export/custom, volume breaks)
```
- **`Product`** is the fragrance, e.g. *Parfums de Marly Layton EDP*. **`ProductVariant`** is
  what you stock and sell, e.g. *Layton EDP 125 ml Tester*.
- Each variant carries cost, wholesale A/B/C, export, retail and **minimum selling price**.
  Selling below the minimum sets `belowMinPrice = true` on the line and creates a
  `DISCOUNT_BELOW_MIN` approval.
- `Brand.adLogoPermission` records whether LUXORA may use that brand's logo in ads. The
  compliance check (8C) reads it.

### Inventory
```
GoodsReceipt ──< Batch (batchNo, expiry, landed unit cost, authenticity documents)
                   │
Warehouse ──< StockLevel >── ProductVariant         (onHand, reserved: current state)
Warehouse ──< StockMovement >── ProductVariant      (every change, signed quantity: history)
StockTake ──< StockTakeLine
```
- **One stock pool.** A wholesale order, a B2B portal order and a web order all increase
  `StockLevel.reserved`, so the same bottle cannot be sold twice.
- **FEFO picking.** `DeliveryNoteLine.batchId` records which batch was shipped, choosing the one
  that expires first.
- **Authenticity.** Each `Batch` can have `Document` rows of type `SUPPLIER_INVOICE`. The ad
  compliance check uses these before any "100% original" claim goes out.

### Purchasing
```
Supplier ──< PurchaseOrder ──< PurchaseOrderLine
                 │
                 ├──< GoodsReceipt ──< GoodsReceiptLine
                 │         └──< LandedCost (freight, duty, clearing, insurance)
                 └──< SupplierBill ──< PaymentAllocation >── Payment
```
- Landed costs are spread over the received lines (by value, quantity or weight) to give each
  batch's `unitCostAed`. The variant's `costAed` is the weighted average of those.

### Sales & CRM
```
Lead (stage, source, campaign, UTM) ──converts──► Customer
Customer ──< Quotation ──1:1── SalesOrder ──< DeliveryNote ──< DeliveryNoteLine → Batch
                                  │
                                  ├──< Invoice ──< InvoiceLine
                                  │        ├──< CreditNote
                                  │        └──< PaymentAllocation >── Payment
                                  ├──< Shipment ──< ShipmentEvent
                                  └──< Commission → User (salesperson)
Customer ──< Activity, CustomerContact, Address, Document (trade licence), PostDatedCheque
```
- **One `SalesOrder` model for all channels**, marked by `channel`: `WHOLESALE`, `B2B_PORTAL`,
  `WEB_STORE` or `EXPORT`. Reservation, delivery and invoicing logic is shared.
- `Customer.creditLimitAed` and `paymentTermsDays` drive the credit check. A change to the limit
  goes through `CREDIT_LIMIT_CHANGE` approval.
- `SalesOrder.campaignId` and the UTM fields record which campaign brought each order.

### Retail storefront
```
User ──1:1── RetailCustomer ──< Cart ──< CartItem
                             ├──< WishlistItem, Address, LoyaltyTransaction
                             └──< SalesOrder (channel = WEB_STORE) ──< OnlinePayment (Stripe / Telr / PayTabs / NI / COD)
Product ──< ProductReview
```

### Finance & VAT
```
Account (chart of accounts, tree) ──< JournalLine >── JournalEntry (source: invoice, bill, payment, COGS, ad spend...)
BankAccount ──1:1── Account
Payment ──< PaymentAllocation → Invoice | SupplierBill
PostDatedCheque ──(when cleared)──► Payment
Expense → Account (+ optional Campaign for ad spend)
VatReturn (VAT201 figures per quarter)
```
- Invoices, bills, payments, expenses and stock write-offs **post journal entries
  automatically** (the `source` field says which).
- `JournalLine` has optional `brandId`, `customerId`, `campaignId` and `adClientId`, so
  reports can show profit **by brand, by customer, by campaign and by ad client**.
- `InvoiceLine.vatCategory`: `STANDARD` (5%), `ZERO_RATED` (exports), `EXEMPT` or
  `OUT_OF_SCOPE`, which feed the VAT201 boxes.

### Company & HR
```
Document (type, number, issuer, expiresOn, file) ──< ExpiryAlert (90 / 60 / 30 / 7 / 0 days)
Employee ──< LeaveRequest, Payslip, Document (visa, Emirates ID)
```
- The SHAMS trade licence is a `Document` with `type = TRADE_LICENCE`,
  `number = 2541889.01`, `issuer = SHAMS` and `expiresOn = 2026-10-27`. The worker sends alerts
  from it, and `ExpiryAlert` stops the same alert from being sent twice.

---

## 3. The advertising tables (8A, 8B, 8C)

### 8A: in-house marketing
```
Campaign (ownerType = IN_HOUSE)
  ├──< CampaignChannel (Instagram, TikTok, Google Ads... + budget + external ids)
  ├──< CampaignBrand >── Brand        ├──< CampaignProduct >── Product
  ├──< AdCreative ──< CreativeAsset (images/videos), CreativeApproval (decisions + comments), versions
  ├──< ContentCalendarItem ──1:1── SocialPost → SocialAccount
  ├──< Broadcast → MarketingSegment (rules) + MessageTemplate ──< BroadcastRecipient
  ├──< Promotion ──< PromotionItem, Coupon (incl. influencer codes)
  ├──< LandingPage ──< LandingPageSubmission ──► Lead
  ├──< UtmLink (short links + clicks)
  ├──< CampaignMetric (daily: impressions, clicks, leads, spend, revenue per channel)
  ├──< AdSpendEntry
  ├──< CampaignAttribution (lead / order / B2B sign-up → revenue)
  └──< ComplianceCheck (8C)
MarketingSeason (Ramadan, Eid, National Day, DSF, White Friday... per year)
MarketingOptOut (checked before every send) · TrackingPixel · AiContentGeneration
```
- **Campaign status flow:** `DRAFT → COMPLIANCE_CHECK → PENDING_APPROVAL → APPROVED → LIVE → COMPLETED`.
  A campaign can only reach `PENDING_APPROVAL` after a passed `ComplianceCheck`, and only the
  Manager (or his delegate) moves it to `APPROVED`.
- **Creative status flow:** `DRAFT → IN_REVIEW → (CHANGES_REQUESTED) → APPROVED → LIVE → ARCHIVED`.
  Each decision is a `CreativeApproval` row. `isClient = true` marks one made by an ad client in
  their portal.
- **Return on ad spend** = total `CampaignAttribution.revenueAed` ÷ total `AdSpendEntry.amountAed`.
  The analytics dashboard also uses `CampaignMetric` for click-through rate, cost per click,
  cost per 1,000 impressions and cost per lead.

### Influencers
```
Influencer (Media Council permit no. + expiry) ──< InfluencerProfile (per platform: handle, followers, engagement)
           ├──< InfluencerDeal (deliverables, fee, results) ──< InfluencerGift → ProductVariant (+ stock movement)
           ├──< Coupon (personal discount code, used for tracking)
           └──< Payment, Document (permit copy)
```

### 8B: agency services for outside clients
```
AdClient ──< User (portal logins)
   ├──< AgencyProposal ──< AgencyProposalItem → ServicePackage
   │         └──1:1── AdContract ──< AdContractItem → ServicePackage
   │                      ├──< Campaign (ownerType = AGENCY_CLIENT)
   │                      ├──< Invoice (type = AGENCY_INVOICE)
   │                      └──< MediaBudget ──< MediaBudgetTopUp
   │                                     └──< AdSpendEntry (isRecharged)
   ├──< AdSlotBooking → AdSlot (LUXORA's own banner / newsletter / WhatsApp space)
   ├──< ClientReport (monthly PDF)
   ├──< Task ──< TimeEntry (agency profitability)
   └──< SocialAccount (client's own pages, connected by LUXORA)
```
- **Agency fees and the client's ad money are kept apart.** Fees are invoiced from the
  contract. The client's ad money sits in `MediaBudget`, where the balance is top-ups minus
  spend and a low-balance alert is set.
- **Agency workflow:** brief (`AgencyProposal.brief`) → proposal (`PENDING_APPROVAL` by the
  Manager, then `SENT`) → client accepts → `AdContract` → campaigns → creatives approved by the
  client in the portal → launch → `ClientReport` → `Invoice`.
- **Ad slot bookings** are checked for overlap in code: date range against
  `AdSlot.maxConcurrent`.
- **Profit per client** = agency invoices − (team time × cost rate + direct costs).

### 8C: compliance
```
ComplianceCheck → Campaign
  brandPermissionOk · authenticityProofOk · pricingNotMisleading
  arabicCopyReviewed · influencerPermitsOk · companyMediaLicenceOk
```
- All six must be `true` for `result = PASSED`. The company's own Media Council licence is a
  `Document` of type `MEDIA_COUNCIL_LICENCE` and gets expiry alerts like the trade licence.
- Every approval and status change is written to `AuditLog`.

---

## 4. Commands

```bash
pnpm install
cp .env.example .env              # set DATABASE_URL
pnpm db:validate                  # check the schema
pnpm db:migrate                   # create / update the database
pnpm --filter @luxora/db studio   # browse the data
```

---

**Next: Step 3, the backend: login and permissions, the approvals engine, then each
module's API.**
