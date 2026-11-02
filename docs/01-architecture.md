# Step 1: System Architecture & Folder Structure

**Project:** LUXORA Hub for LUXORA Perfume & Cosmetics Trading LLC
**Owner / Super Admin:** Althaf Najeeb (Manager)

---

## 1. Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Repository layout | **Monorepo** (pnpm workspaces + Turborepo) | One place for all apps; shared types and business rules (VAT, pricing) are written once |
| Backend | **NestJS** (Node.js + TypeScript) as one modular API | Clear modules (sales, ads, finance, etc.), built-in guards for roles/approvals, good for a large ERP |
| Frontends | **Two Next.js apps** | `admin` for staff, and `web` for everything outside users see (storefront, B2B portal, ad-client portal). This keeps staff screens out of the public site. |
| Database | **PostgreSQL + Prisma** | Reliable transactions for stock and accounting |
| Background jobs | **BullMQ + Redis** worker | Scheduled social posts, WhatsApp/email broadcasts, PDF reports, expiry alerts, ad-platform data sync |
| File storage | **S3-compatible** (MinIO locally; AWS S3 or Cloudflare R2 in production) | Product images, ad creatives, licences, invoices |
| Search | PostgreSQL full-text search first; Meilisearch can be added later | Keeps the first version simple |
| Languages | English + Arabic (RTL) using `next-intl` | Required from day one |
| Hosting | Docker containers on one VPS (e.g. a UAE/GCC region of AWS, Azure, or Hetzner) | Low cost for the first version; can scale later |

### The 6 rules the whole system follows
1. **One stock pool.** Wholesale orders, B2B portal orders, and retail web orders all reserve from the same inventory, so nothing is sold twice.
2. **Every money or stock change leaves a record.** Stock movements and journal entries are never edited, only reversed.
3. **Approvals run through one engine.** Discounts, large purchase orders, credit limits, ad campaigns, creatives, and influencer deals all go to one approval inbox. By default the approver is the Manager (Althaf Najeeb), who can delegate.
4. **Permissions are checked on the server** for every API call (RBAC), not only hidden in the UI.
5. **Outside users only see their own data.** B2B customers, ad clients, and retail customers are locked to their own records.
6. **Integrations are adapters.** Meta, TikTok, Google Ads, WhatsApp, payment gateways, and couriers sit behind interfaces with a "mock" version, so the system works before API keys are available.

---

## 2. System diagram

```
                           ┌──────────────────────────── USERS ─────────────────────────────┐
                           │                                                                 │
   Staff (Manager, Sales, Warehouse,          B2B customers, ad clients,          Retail shoppers
   Accountant, Marketing)                     influencers (view only)
            │                                          │                                │
            ▼                                          ▼                                ▼
 ┌──────────────────────┐            ┌────────────────────────────────────────────────────────┐
 │  apps/admin          │            │  apps/web  (Next.js)                                   │
 │  Next.js staff panel │            │   /            → retail storefront (EN / AR)           │
 │  admin.luxora.ae     │            │   /b2b         → wholesale ordering portal             │
 │  (mobile friendly)   │            │   /client      → advertising client portal             │
 └──────────┬───────────┘            │   /lp/[slug]   → campaign landing pages                │
            │                        └──────────────────────────┬─────────────────────────────┘
            │        HTTPS / JSON (JWT, role checks)            │
            ▼                                                   ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 │  apps/api  (NestJS)                                                     api.luxora.ae      │
 │                                                                                            │
 │  Core:     auth · users & roles · approvals engine · audit log · settings · notifications  │
 │  Trading:  catalogue · inventory · purchasing · sales & CRM · B2B portal · storefront      │
 │  Money:    finance & VAT · payments · expenses · reports                                   │
 │  Ads:      campaigns · creatives · calendar · broadcasts · promotions · landing pages      │
 │            influencers · analytics · agency clients · ad slots · media budgets             │
 │  Company:  documents & licences · HR · shipping & export                                   │
 │                                                                                            │
 │  Integration adapters: Meta · TikTok · Google Ads · WhatsApp · SMTP · SMS                  │
 │                        Stripe / Telr / PayTabs / Network Intl · Aramex / couriers          │
 └───────┬──────────────────────┬───────────────────────────┬─────────────────────────────────┘
         │                      │                           │
         ▼                      ▼                           ▼
 ┌───────────────┐     ┌─────────────────┐        ┌────────────────────┐
 │ PostgreSQL    │     │ Redis           │◄──────►│ apps/worker        │
 │ (all data)    │     │ cache + queues  │        │ BullMQ jobs:       │
 └───────────────┘     └─────────────────┘        │ • post scheduler   │
                                                  │ • broadcasts       │
 ┌───────────────┐                                │ • PDF reports      │
 │ S3 / MinIO    │◄───────────────────────────────│ • expiry alerts    │
 │ files, images │                                │ • ads data sync    │
 └───────────────┘                                │ • payment reminders│
                                                  └────────────────────┘
```

### Example flow: an ad campaign going live
```
Marketing Manager creates campaign + creatives
        │
        ▼
Compliance checklist (8C): logo permission, authenticity proof, Arabic copy, influencer permit
        │  all ticked
        ▼
Approval request ──► Manager's approval inbox (web + phone, WhatsApp/email alert)
        │  approved (recorded in audit log)
        ▼
Worker schedules posts / broadcasts ──► Meta / TikTok / WhatsApp adapters
        │
        ▼
UTM links + pixels track visits ──► leads go to CRM, orders are linked to the campaign
        │
        ▼
Analytics dashboard: spend, leads, revenue, ROAS
```

### Example flow: a wholesale sale
```
Quotation ─► (discount below minimum price? ─► Manager approval) ─► Sales order
   ─► stock reserved (FEFO batches) ─► delivery note ─► tax invoice (5% VAT, EN/AR, signed "Manager")
   ─► payment / PDC ─► journal entries posted automatically ─► customer statement updated
```

---

## 3. Folder structure

```
luxora-hub/
├── apps/
│   ├── api/                         # NestJS backend
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/              # guards, decorators, filters, pagination, RBAC
│   │   │   ├── core/
│   │   │   │   ├── auth/            # login, JWT, OTP, refresh tokens
│   │   │   │   ├── users/           # users, roles, permissions
│   │   │   │   ├── approvals/       # approval engine + Manager delegation
│   │   │   │   ├── audit/           # audit log
│   │   │   │   ├── notifications/   # in-app, email, WhatsApp, push
│   │   │   │   └── settings/        # company profile, numbering, tax, currencies
│   │   │   ├── trading/
│   │   │   │   ├── catalogue/       # brands, products, variants, price tiers
│   │   │   │   ├── inventory/       # warehouses, batches, stock movements, stock-take
│   │   │   │   ├── purchasing/      # suppliers, POs, GRN, landed cost
│   │   │   │   ├── sales/           # quotations, orders, delivery notes, invoices
│   │   │   │   ├── crm/             # customers, leads, activities, commissions
│   │   │   │   ├── b2b-portal/      # endpoints for B2B customers
│   │   │   │   └── storefront/      # cart, checkout, coupons, reviews
│   │   │   ├── finance/
│   │   │   │   ├── accounting/      # chart of accounts, journals, auto-posting
│   │   │   │   ├── vat/             # 5% VAT, credit notes, VAT201 report
│   │   │   │   ├── payments/        # receipts, PDCs, supplier payments
│   │   │   │   ├── expenses/
│   │   │   │   └── reports/         # P&L, balance sheet, aging, profit by brand
│   │   │   ├── advertising/
│   │   │   │   ├── campaigns/       # 8A campaign manager
│   │   │   │   ├── creatives/       # creative library + approval workflow
│   │   │   │   ├── content-ai/      # AI copywriter (EN/AR)
│   │   │   │   ├── calendar/        # content calendar + UAE seasons
│   │   │   │   ├── social/          # post scheduler
│   │   │   │   ├── broadcasts/      # email / WhatsApp / SMS, segments, opt-outs
│   │   │   │   ├── promotions/      # discount codes, bundles, flash sales
│   │   │   │   ├── landing-pages/   # page builder + lead forms
│   │   │   │   ├── tracking/        # UTM links, pixels, attribution
│   │   │   │   ├── influencers/     # influencers, permits, deals
│   │   │   │   ├── analytics/       # KPIs, CSV import, platform sync
│   │   │   │   ├── agency/          # 8B clients, contracts, packages, client workflow
│   │   │   │   ├── ad-slots/        # own media inventory + bookings
│   │   │   │   ├── media-budgets/   # client top-ups and spend deductions
│   │   │   │   └── compliance/      # 8C checklist, Media Council licences
│   │   │   ├── company/
│   │   │   │   ├── documents/       # licence vault + expiry alerts
│   │   │   │   ├── hr/              # employees, visas, WPS export
│   │   │   │   └── shipping/        # deliveries, export docs, HS codes
│   │   │   └── integrations/        # adapter interfaces + real and mock versions
│   │   │       ├── meta/  tiktok/  google-ads/  whatsapp/  email/  sms/
│   │   │       ├── payments/        # stripe, telr, paytabs, network-intl
│   │   │       └── couriers/        # aramex, generic manual
│   │   └── test/
│   │
│   ├── worker/                      # BullMQ background jobs
│   │   └── src/jobs/                # post-scheduler, broadcasts, pdf-reports,
│   │                                # expiry-alerts, ads-sync, payment-reminders
│   │
│   ├── admin/                       # Next.js staff panel
│   │   └── src/app/[locale]/
│   │       ├── (auth)/login/
│   │       ├── dashboard/           # main + Manager dashboard
│   │       ├── approvals/           # Manager approval inbox
│   │       ├── catalogue/  inventory/  purchasing/  sales/  crm/
│   │       ├── finance/  reports/
│   │       ├── marketing/           # campaigns, creatives, calendar, broadcasts,
│   │       │                        # promotions, landing-pages, influencers, analytics
│   │       ├── agency/              # ad clients, packages, ad slots, budgets
│   │       ├── company/             # documents, hr, shipping
│   │       └── settings/
│   │
│   └── web/                         # Next.js public site + outside users' portals
│       └── src/app/[locale]/
│           ├── (store)/             # home, brands, product, cart, checkout, account
│           ├── b2b/                 # wholesale login, catalogue, quick order, statements
│           ├── client/              # ad client portal: campaigns, approvals, reports, invoices
│           └── lp/[slug]/           # campaign landing pages
│
├── packages/
│   ├── db/                          # Prisma schema, migrations, seed (Step 2 and Step 7)
│   ├── shared/                      # types, Zod validation, enums, role and permission list,
│   │                                # business rules: VAT, pricing tiers, landed cost, ROAS
│   ├── ui/                          # shared React components (black / gold / ivory theme)
│   ├── i18n/                        # en.json, ar.json translations
│   ├── pdf/                         # invoice, quotation, price list, ad report templates
│   └── config/                      # eslint, tsconfig, tailwind presets
│
├── infra/
│   ├── docker/                      # Dockerfiles for api, worker, admin, web
│   ├── nginx/                       # reverse proxy + HTTPS
│   └── backup/                      # daily Postgres backup script
│
├── docs/                            # these step-by-step design documents
├── docker-compose.yml               # postgres, redis, minio, api, worker, admin, web
├── .env.example
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

---

## 4. Roles and permissions (summary)

Permissions use the form `module:action`, for example `sales:create`, `vat:report`, or
`campaign:approve`. Each role gets a list of permissions; the Super Admin has all of them.

| Role | Main permissions |
|---|---|
| Super Admin / Manager (Althaf Najeeb) | `*` (all), plus being the default approver for every approval type |
| Sales Executive | `crm:*`, `quotation:*`, `sales_order:create`, `commission:read_own` |
| Warehouse | `inventory:*`, `delivery:*`, `grn:create` |
| Accountant | `invoice:*`, `payment:*`, `expense:*`, `vat:*`, `report:finance` |
| Marketing Manager | `campaign:*` (not `approve`), `creative:*`, `broadcast:*`, `influencer:*`, `agency:*` |
| Ad Client | `portal_client:*` (own records only) |
| B2B Customer | `portal_b2b:*` (own records only) |
| Retail Customer | `store:*` (own records only) |

**Approval types and default approver:** `DISCOUNT_BELOW_MIN`, `CREDIT_LIMIT_CHANGE`,
`PO_ABOVE_LIMIT`, `PRICE_LIST_CHANGE`, `STOCK_WRITE_OFF`, `CREDIT_NOTE`,
`CAMPAIGN_GO_LIVE`, `CREATIVE_PUBLISH`, `AGENCY_PROPOSAL`, `MEDIA_BUDGET`,
`INFLUENCER_DEAL`. The approver for all of them is the Manager, and he can delegate with
a start and end date.

---

## 5. Environments

| Environment | Purpose |
|---|---|
| Local | `docker compose up`: everything runs with mock integrations |
| Staging | A test copy for the team, with sandbox payment and ad accounts |
| Production | Live system, daily backups, HTTPS, monitoring |

---

**Next: Step 2, the full database schema (Prisma), with the relations explained.**
