# Step 3B: Purchasing, Sales & CRM, Finance & UAE VAT

| Part | Contents | Status |
|---|---|---|
| 3A | Foundation, approvals engine, catalogue, inventory | ✅ Done |
| **3B** | **Purchasing, sales & CRM, finance & VAT** | ✅ Done (this document) |
| 3C | Advertising (8A, 8B, 8C), influencers, shipping, documents & HR | Next |

**Tests:** 73 passing in total. Part 3B adds `apps/api/test/trading.e2e.test.ts`, which runs
**one complete business cycle** and checks every amount to the fils (summary at the end).

Database change: migration `20261102000000_sales_reservations` adds
`SalesOrderLine.reservedPicks` (which batches are held for each line) and
`Invoice.amountCredited`.

---

## 1. Purchasing

```
Supplier ─► Purchase order (DRAFT)
              │ submit
              ├─ total ≤ AED 20,000 → APPROVED
              └─ total > AED 20,000 → PENDING_APPROVAL → Manager approves → APPROVED
              │ send → SENT
              ▼
           Goods receipt (GRN): batch no. + expiry per line, freight / duty / clearing / insurance
              │  • landed unit cost = price in AED + share of extra costs (by value, quantity or weight)
              │  • stock in, batch created, weighted-average cost updated
              │  • PO → PARTIALLY_RECEIVED / RECEIVED (over-receiving is blocked)
              │  • Journal: Dr Inventory / Cr Goods received not invoiced (2050)
              ▼
           Supplier bills (goods, freight, other)
              • Dr 2050 (or an expense account) + Dr VAT input / Cr Accounts payable
```
- Suppliers outside the UAE get 0% VAT on the PO by default. Import VAT is handled as a
  reverse charge on the VAT return (see section 4).
- Account 2050 returns to zero once the supplier, freight and duty costs are all recorded, so any
  balance left there shows a missing bill.

## 2. Sales & CRM

**Customers:** retailer, salon, online seller, distributor, export buyer, corporate.
- The TRN is checked (15 digits starting with 100), along with the emirate (used by the VAT
  return), the price tier or price list, and the assigned salesperson.
- **New customers start on cash terms.** A credit limit or payment terms only apply after
  **CREDIT_LIMIT_CHANGE** approval.
- The customer page shows money owed, open orders, credit left and overdue invoices.
- **Statement of account:** invoices, credit notes and payments with a running balance.

**Leads** move `NEW → CONTACTED → SAMPLE_SENT → NEGOTIATION → WON / LOST` (a reason is
required for LOST). There is a pipeline board by stage and value. Converting a lead creates a
customer and, if it came from a campaign, records a B2B sign-up for that campaign. **Activities**
(calls, WhatsApp, visits, tasks) have due dates.

**Pricing** (`PricingService`): the customer's **approved** price list with volume breaks, else
their tier price (A/B/C). UAE customers pay 5% VAT; customers abroad are zero-rated. Any line
whose net price falls below the variant's minimum is flagged.

```
Quotation (DRAFT) ── send ──► below minimum? ── yes ─► Manager approval ─► SENT
                                             └─ no ──────────────────────► SENT
   accept → ACCEPTED → convert → Sales order at the approved prices

Sales order (DRAFT) ── confirm ──►
   1. below-minimum price (not from an approved quotation) → DISCOUNT_BELOW_MIN approval
   2. credit check for credit customers:
        unpaid invoices + open orders + this order ≤ credit limit
        else 409 (only the Manager can override)
   3. stock reserved, picking the batches that expire first → CONFIRMED
   ▼
Delivery notes (full or partial) → stock issued from the reserved batches
   • cost per line recorded for profit reports
   • Journal: Dr Cost of goods sold / Cr Inventory
   ▼ (fully delivered)
Tax invoice LUX-INV-2026-0001
   • UAE: "Tax Invoice / فاتورة ضريبية", 5% VAT, customer TRN, VAT shown in AED
   • Abroad: "Tax Invoice (Export, zero-rated)", 0%
   • signed "Althaf Najeeb, Manager"; seller details and SHAMS licence from the company profile
   • Journal: Dr Receivables / Cr Sales (split by brand) / Cr Output VAT
   • Salesperson commission (e.g. 2% of net sales)
   ▼
Credit note → CREDIT_NOTE approval → issued
   • Journal: Dr Sales returns + Dr Output VAT / Cr Receivables
   • optional restock into the original batch (Dr Inventory / Cr COGS)
```
Cancelling an order releases its reserved stock and cancels any pending approval for it.

## 3. Finance

**Ledger:** double-entry accounting with 36 system accounts (see `CHART_OF_ACCOUNTS` in
`packages/db/src/seed-core.ts`).
- Every posting must balance, and entries can only be reversed, never edited (a reversal cannot
  itself be reversed).
- Journal lines carry brand, customer, campaign and ad client, for profit reports.
- Stock movements (opening stock, write-offs, samples and testers, influencer gifts, COGS,
  returns) post automatically.

**Payments**, received or made, are allocated to invoices or supplier bills, or allocated
automatically to the oldest open invoices.
- Paying more than an invoice owes is blocked, and so is allocating to another customer's invoice.
- Money that isn't allocated goes to Customer advances (received) or Prepayments (paid out).

**Post-dated cheques:** `RECEIVED → DEPOSITED → CLEARED` (this creates the payment) or
`BOUNCED`.
- A cheque cannot be deposited before its date.
- A bounced cheque alerts the Manager in the app, by WhatsApp and by email, and its invoices stay
  open.

**Expenses** use an expense account, recoverable VAT, the bank or cash, and an optional campaign
(ad spend for return-on-ad-spend reports).

**Reports:**
- trial balance, profit & loss (with gross profit on goods) and balance sheet (with a balance check)
- money owed to you and money you owe, by age: current, 1–30, 31–60, 61–90 and 90+ days
- profit and margin by brand
- sales by channel, customer type and country

## 4. UAE VAT return (VAT201)

`GET /finance/vat/report?from=&to=` calculates the boxes. `POST /finance/vat/returns` saves
them, and `POST /finance/vat/returns/:id/filed` records the FTA reference.

| Box | Source |
|---|---|
| 1a–1g | Standard-rated sales by **emirate** (customer's emirate; Dubai if not set), less credit notes |
| 4 | Zero-rated exports |
| 5 | Exempt supplies |
| 6 / 10 | **Goods imported** from foreign suppliers (reverse charge): goods + freight + insurance + customs duty, 5% |
| 9 | Standard-rated purchases & expenses (supplier bills, expenses with VAT) |
| 8, 11–14 | Totals, VAT due, VAT recoverable, **net payable / refundable** |

> Always check against the FTA portal and customs declarations before filing. Whether
> imports count as reverse charge depends on how goods are cleared. Confirm this with the
> company's tax adviser.

## 5. API reference (Part 3B)

All routes start with `/api/v1`.

| Route | Permission | Purpose |
|---|---|---|
| `GET/POST /purchasing/suppliers`, `PATCH /:id` | `purchasing:read` / `manage` | Suppliers |
| `GET/POST /purchasing/orders`, `GET /:id` | same | Purchase orders |
| `POST /purchasing/orders/:id/submit` · `/send` · `/cancel` | `purchasing:manage` | PO workflow (**PO_ABOVE_LIMIT**) |
| `POST /purchasing/receipts`, `GET /:id` | `inventory:move` | Goods receipt with landed costs |
| `GET/POST /purchasing/bills` | `purchasing:read` / `manage` | Supplier bills |
| `GET/POST /crm/customers`, `GET/PATCH /:id` | `crm:read` / `manage` | Customers (with credit summary) |
| `POST /crm/customers/:id/credit` | `crm:manage` | Credit limit / terms (**CREDIT_LIMIT_CHANGE**) |
| `GET /crm/customers/:id/statement` | `crm:read` | Statement of account |
| `POST /crm/customers/:id/contacts` | `crm:manage` | Contacts |
| `GET/POST /crm/activities`, `POST /:id/done` | `crm:read` / `manage` | Calls, visits, tasks |
| `GET/POST /crm/leads`, `PATCH /:id`, `GET /leads/pipeline`, `POST /:id/convert` | same | Leads |
| `POST /sales/price-check` | `sales:read` | Preview a customer's prices |
| `GET/POST /sales/quotations`, `GET /:id` | `sales:read` / `manage` | Quotations |
| `POST /sales/quotations/:id/send` · `/accept` · `/convert` | `sales:manage` | **DISCOUNT_BELOW_MIN** → order |
| `GET/POST /sales/orders`, `GET /:id` | `sales:read` / `manage` | Orders (cost hidden without `price:read_cost`) |
| `POST /sales/orders/:id/confirm` · `/cancel` | `sales:manage` | Confirm (credit check, reserve) / cancel |
| `POST /sales/orders/:id/deliveries` | `delivery:manage` | Delivery note (full or partial) |
| `GET /sales/delivery-notes/:id` | `sales:read` | Print the delivery note (batch numbers) |
| `POST /sales/orders/:id/invoice` | `sales:manage` | Tax / export invoice |
| `GET /sales/invoices?overdue=true`, `GET /:id` | `sales:read` | Invoices (with balance and print data) |
| `POST /sales/invoices/:id/credit-notes` | `sales:manage` | Credit note (**CREDIT_NOTE**) |
| `GET /sales/commissions?period=2026-11` | `commission:read_own` (all with `read_all`) | Commissions |
| `GET/POST /finance/accounts` | `finance:read` / `manage` | Chart of accounts |
| `GET/POST /finance/journals`, `POST /:id/reverse` | same | Journals (manual + reversal) |
| `GET/POST /finance/bank-accounts` | same | Bank accounts (UAE IBAN checked) |
| `GET/POST /finance/payments` | same | Payments in / out with allocation |
| `GET/POST /finance/pdcs`, `POST /:id/deposit` · `/clear` · `/bounce` | same | Post-dated cheques |
| `GET/POST /finance/expenses`, `GET /:id` | same | Expenses |
| `GET /finance/vat/report`, `GET/POST /finance/vat/returns`, `POST /:id/filed` | `vat:manage` | VAT201 |
| `GET /finance/reports/trial-balance` · `profit-loss` · `balance-sheet` · `aged-receivables` · `aged-payables` · `profit-by-brand` · `sales-summary` | `report:finance` | Reports |

## 6. The full-cycle test, in numbers

| Step | Result checked |
|---|---|
| PO: 40 × Initio Oud for Greatness 90 ml @ EUR 130 (rate 4.0) | AED 20,800, above the limit → Manager approval |
| Goods receipt + freight AED 800 + duty AED 1,040 | Landed cost **AED 566** per bottle (520 + 46); inventory AED 22,640 |
| Supplier bill + freight bill + duty payment | Goods received not invoiced back to **0** |
| Sharjah salon, credit AED 30,000 / 30 days | Applied only after approval |
| Quotation: 20 bottles, 8% off tier C (AED 690 < minimum 700) | Waits for approval, then sent and converted |
| Second and third orders | Third blocked at AED 30,240 exposure; only the Manager can override |
| Deliveries 12 + 8 | Cost of goods sold AED 11,320 |
| Tax invoice | AED 13,800 + 690 VAT = **14,490**, signed Althaf Najeeb (Manager); 2% commission AED 276 |
| AED 10,000 transfer · credit note for 2 bottles (AED 1,449) · bounced cheque · cleared cheque AED 3,041 | Invoice PAID; statement closes at **0.00**; 2 bottles back in stock |
| Export to Kuwait, 2 bottles | Zero-rated, AED 1,500 |
| Rent AED 5,000 + 250 VAT | Expense posted |
| **VAT201** | Sharjah 12,420 / 621 · exports 1,500 · imports 22,640 / 1,132 · purchases 5,800 / 290 → **payable AED 331** |
| Books | Trial balance and balance sheet balance; receivables AED 1,500; profit and loss checked |

---

**Next: Step 3C, the advertising module in full (in-house campaigns, creatives, calendar,
social posts, broadcasts, promotions, landing pages, tracking and analytics, influencers,
agency clients, proposals, contracts, media budgets, ad slots, client reports, compliance),
plus shipping, the document vault with licence alerts, and HR.**
