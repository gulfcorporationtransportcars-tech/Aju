# Step 3A: Backend Foundation, Catalogue & Inventory

Step 3 is in three parts:

| Part | Contents | Status |
|---|---|---|
| **3A** | Shared business rules, login & sessions, roles & permissions, audit log, document numbers, notifications, **approvals engine**, settings, **catalogue**, **inventory** | ✅ Done (this document) |
| 3B | Purchasing, sales & CRM, finance & UAE VAT | Next |
| 3C | Advertising (8A, 8B, 8C), influencers, shipping, documents & HR | After 3B |

**Tests:** 49 passing. 24 are business-rule unit tests; 25 are end-to-end API tests run
against a real PostgreSQL database.

---

## 1. What was built

```
packages/shared/        Business rules used by the API, the worker and the web apps
  money.ts              Exact decimal maths (never floats), AED conversion
  vat.ts                UAE 5% VAT per line / per document, VAT-inclusive split, TRN check
  pricing.ts            Tier A/B/C/retail prices, price-list volume breaks, minimum-price check,
                        margin, weighted-average cost
  landed-cost.ts        Spread freight / duty / clearing / insurance over received goods
  fefo.ts               First-expiry-first-out batch picking
  permissions.ts        Every permission key + what each role gets
  approvals.ts          The 11 approval types (EN/AR labels), thresholds, delegation logic
  ads.ts                ROAS, CTR, CPC, CPM, CPL, media-budget balance, ad-slot overlap,
                        8C compliance check
  dates.ts              Licence / document expiry alerts (90/60/30/7/0 days, UAE time)

packages/db/src/seed-core.ts
                        Roles, permissions, approval rules, currencies (USD pegged at 3.6725),
                        GCC + supplier countries, warehouses, company profile, Manager account

apps/api/src/
  common/auth/          Login check + permission check on every request (global guards)
  common/http/          Request validation (Zod), paging, error handling
  core/auth/            Login, refresh (rotating), logout, "me"
  core/users/           Users & roles
  core/audit/           Audit log
  core/numbering/       LUX-INV-2026-0001-style numbers, safe under concurrent saves
  core/notifications/   In-app notifications (email/WhatsApp/push are queued for the worker)
  core/approvals/       The approvals engine + Manager delegation
  core/settings/        Company profile and other settings
  trading/catalogue/    Brands, fragrance families, notes, products, variants, price lists
  trading/inventory/    Stock engine, warehouses, stock levels, movements, expiry list,
                        opening stock, adjustments, transfers, stock-takes
```

---

## 2. Security

- **Passwords** are hashed with Argon2.
- **Access tokens** last 15 minutes. **Refresh tokens** last 30 days, are stored only as a hash,
  and **rotate**: each one works once.
- **Every request re-reads the user**, so suspending someone or changing their role takes
  effect at once, and suspending also ends all their sessions.
- **Permissions are checked on the server** on every route with `@RequirePermissions(...)`.
- **Login is rate-limited** to 10 attempts per minute per IP (300 requests per minute for other
  routes). A wrong email and a wrong password give the same message.
- **Cost prices are hidden** from users without `price:read_cost` (for example sales staff).
  Changing any price needs `price:manage`.
- Helmet security headers, a CORS allow-list, and environment variables are checked at
  startup (the server refuses to start with a weak JWT secret).

---

## 3. The approvals engine

```
Module wants an action that needs approval
        │
        ▼
ApprovalsService.request(type, record, amount)
        │  rule for this type → approver role (default SUPER_ADMIN = Althaf Najeeb)
        │  active delegation? → his delegate instead
        │
        ├── approver is the requester? → recorded as APPROVED at once, action applied
        │
        └── otherwise → PENDING + notification (in-app, push, WhatsApp, email)
                    │
                    ▼
        POST /approvals/:id/approve  or  /reject
                    │  only the assigned person (or the Manager) may decide;
                    │  a requester can't approve their own request
                    ▼
        The module's handler runs in the SAME database transaction:
        the decision and the action both happen, or neither does
                    │
                    ▼
        Audit log + notification to the requester
```

Each module registers a handler for its record type. Part 3A registers `StockAdjustment`,
`StockTake` and `PriceList`. Parts 3B and 3C add `Quotation`, `PurchaseOrder`,
`CreditNote`, `Customer` (credit limit), `Campaign`, `AdCreative`, `AgencyProposal`,
`MediaBudget` and `InfluencerDeal`.

**Delegation:** the Manager calls `POST /approvals/delegations` with the person, the approval
types (or all) and the start and end dates. Requests in that window go to the delegate. He can
revoke it at any time.

---

## 4. The stock engine

All stock changes go through `StockService`, inside a database transaction:

| Method | Used for |
|---|---|
| `receive` | Purchase receipts, opening stock, customer returns, positive adjustments. Creates or updates the batch and recalculates the weighted-average cost. |
| `reserve` | Confirmed orders from any channel: picks batches **FEFO** and holds them |
| `release` | Order cancelled or changed |
| `issue` | Delivery, damage, sample, tester, influencer gift, negative adjustment |
| `transfer` | Move a batch between warehouses |

- Each call **locks the variant's stock rows** (`SELECT … FOR UPDATE`). The tests show that two
  orders for the last 8 units at the same moment cannot both succeed.
- Reserved stock cannot be written off.
- Every change appends a `StockMovement` that links back to its source document.

---

## 5. API reference (Part 3A)

All routes start with `/api/v1`. 🔓 = no login needed.

| Method & route | Permission | Purpose |
|---|---|---|
| `GET /health` 🔓 | none | Health check |
| `POST /auth/login` 🔓 | none | Email + password → access + refresh token |
| `POST /auth/refresh` 🔓 | none | New tokens (old refresh token stops working) |
| `POST /auth/logout` 🔓 | none | End the session |
| `GET /auth/me` | any logged-in user | Profile, role, permissions |
| `GET /users` · `POST /users` · `PATCH /users/:id` | `user:read` / `user:manage` | Staff and portal users |
| `GET /roles` | `user:read` | Roles with their permissions |
| `GET /audit` | `audit:read` | Audit log (filter by record or user) |
| `GET /notifications` · `POST /notifications/:id/read` | any logged-in user | Bell menu |
| `GET /settings/public/company.profile` 🔓 | none | Company details for the website footer |
| `GET /settings` · `PUT /settings/:key` | `settings:manage` | Settings |
| `GET /approvals?scope=assigned\|requested\|all&status=` | `approval:read` | Approval inbox |
| `GET /approvals/pending-count` | `approval:read` | Badge on the Manager dashboard |
| `GET /approvals/:id` | `approval:read` | One request |
| `POST /approvals/:id/approve` · `/reject` · `/cancel` | assigned person / Manager / requester | Decide |
| `GET /approvals/delegations` | `approval:read` | Delegations from or to me |
| `POST /approvals/delegations` · `DELETE /approvals/delegations/:id` | `approval:delegate` (Manager) | Delegate / revoke |
| `GET /catalogue/brands` · `POST` · `PATCH /:id` | `catalogue:read` / `catalogue:manage` | Brands (incl. ad logo permission) |
| `GET /catalogue/families` · `POST` | same | Fragrance families |
| `GET /catalogue/notes` · `POST` | same | Notes (oud, rose, bergamot...) |
| `GET /catalogue/products?q=&brandId=&gender=&kind=` | `catalogue:read` | Search products (name, Arabic name, brand, SKU, barcode) |
| `GET /catalogue/products/:id` · `POST /catalogue/products` · `PATCH /:id` | read / manage | Product with variants, notes, images |
| `POST /catalogue/products/:id/variants` · `PATCH /catalogue/variants/:id` | `catalogue:manage` (+ `price:manage` for prices) | Variants and prices |
| `GET /catalogue/variants/by-barcode/:code` | `catalogue:read` | Barcode scanner lookup (also accepts a SKU) |
| `GET /catalogue/variants/:id/price-history` | `price:manage` | Every price change |
| `GET /catalogue/price-lists` · `GET /:id` · `POST` | read / `price:manage` | Price lists |
| `POST /catalogue/price-lists/:id/items` | `price:manage` | Set prices → **PRICE_LIST_CHANGE** approval |
| `GET /inventory/warehouses` · `POST` · `PATCH /:id` | `inventory:read` / `warehouse:manage` | Warehouses |
| `GET /inventory/stock?q=&brandId=&warehouseId=&lowStock=true` | `inventory:read` | Stock per variant (on hand, reserved, available, low) |
| `GET /inventory/stock/:variantId` | `inventory:read` | By warehouse and batch, earliest expiry first |
| `GET /inventory/movements?variantId=&type=&refType=&refId=` | `inventory:read` | Movement history |
| `GET /inventory/expiring?days=90` | `inventory:read` | Batches expiring soon |
| `POST /inventory/opening-stock` | `inventory:adjust` | Opening stock (no approval) |
| `POST /inventory/adjustments` | `inventory:adjust` | Adjustment → **STOCK_WRITE_OFF** approval |
| `POST /inventory/transfers` | `inventory:move` | Move stock between warehouses |
| `POST /inventory/stock-takes` · `GET /:id` · `PATCH /:id/counts` · `POST /:id/submit` | `inventory:adjust` | Count → differences → approval → applied |

---

## 6. Running it

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL, JWT_ACCESS_SECRET, MANAGER_PASSWORD
pnpm build                    # shared rules → Prisma client → db package → API
pnpm db:migrate               # create the tables
pnpm db:seed                  # roles, permissions, company profile, Manager account
pnpm dev:api                  # http://localhost:4000/api/v1/health
pnpm test                     # needs TEST_DATABASE_URL (that database is wiped on every run)
```

---

**Next: Step 3B, purchasing (POs, goods receipts with landed cost, supplier bills), sales &
CRM (leads, quotations, orders, delivery notes, tax invoices, credit notes, commissions) and
finance & VAT (automatic journal entries, payments, PDCs, expenses, VAT201).**
