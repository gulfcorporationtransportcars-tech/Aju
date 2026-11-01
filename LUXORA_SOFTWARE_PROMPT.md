# Build Prompt: LUXORA Business Management & Advertising Software

> Copy everything below the line into ChatGPT, Claude, or another AI coding assistant.
> It is written so the AI builds the software one step at a time instead of producing
> one unusable answer.

---

## ROLE

You are a senior full-stack software architect and developer with experience building
ERP, CRM, and marketing software for wholesale trading companies in the UAE. Build a
complete, production-ready web application for the company described below. Write
clean, well-structured code with comments. Explain each step briefly.

## COMPANY CONTEXT

**LUXORA Perfume & Cosmetics Trading LLC** is a UAE wholesale trading company. It sells
international branded and niche perfumes and cosmetics to retailers, salons, online
sellers, and other businesses (B2B) in the UAE and abroad.

- **Legal name:** LUXORA Perfume & Cosmetics Trading LLC
- **Company type:** Limited Liability Company
- **Registration authority:** Sharjah Media City Free Zone Authority (SHAMS)
- **Formation number:** 2541889 | **Licence number:** 2541889.01
- **Licence issued:** 28 October 2025 | **Licence expiry:** 27 October 2026
- **Manager:** Althaf Najeeb, the company's Manager as named on the SHAMS licence. He is the main decision-maker, authorised signatory, and final approver for business, finance, and advertising decisions.
- **Registered address:** Shams Business Center, Sharjah Media City Free Zone, Al Messaned, Sharjah, UAE (Flexi Desk)
- **Business address:** 44-12 Al Daghaya Street, Al Daghaya, Deira, Dubai, UAE
- **Phone:** +971 55 389 4353

**Brands handled:** Parfums de Marly, Initio, Amouage, Byredo, Ex Nihilo, Kilian Paris,
Tom Ford, Chanel, Dior, Louis Vuitton, Hermès, Creed, Nishane, Memo Paris, Mizensir,
Penhaligon's.

**Licensed activities:** wholesale of perfumery, cosmetics, beauty products and soaps;
non-specialized wholesale trade; general trading; retail sale of watches, clocks and
jewellery; retail sale over the internet; online advertising; advertising agency.

**Business values:** lasting relationships, reliable service, competitive pricing, a passion for fragrance.

## GOAL

Build one web platform, **"LUXORA Hub"**, that covers:
1. Wholesale trading operations (inventory, purchasing, sales, invoicing, CRM)
2. A B2B online ordering portal for customers
3. A retail e-commerce storefront (the internet retail licence)
4. An **Advertising & Marketing module**, covering LUXORA's own promotion and paid advertising services for outside clients (the advertising agency licence)
5. Company compliance, finance, and reporting

## TECH STACK

Use the following unless you have a strong reason to change it, and explain any change:
- **Frontend:** Next.js (React) + TypeScript + Tailwind CSS, responsive and mobile-friendly
- **Backend:** Node.js (NestJS or Next.js API routes) + TypeScript
- **Database:** PostgreSQL with Prisma ORM
- **Auth:** email/password + optional OTP via WhatsApp/SMS, role-based access control
- **File storage:** S3-compatible storage for product images, ad creatives, and documents
- **PDF generation:** for invoices, quotations, delivery notes, and price lists
- **Deployment:** Docker + docker-compose, with `.env.example` and seed data
- **Languages:** English and Arabic (RTL support) from day one
- **Currency:** AED as base currency, with multi-currency support (USD, EUR, SAR, etc.) and exchange rates

## USER ROLES

| Role | Access |
|---|---|
| Super Admin / Manager (Althaf Najeeb) | Everything: settings, users, finance, pricing, and all final approvals |
| Sales Executive | Customers, quotations, sales orders, own commissions |
| Warehouse / Logistics | Stock, receiving, picking, packing, dispatch |
| Accountant | Invoices, payments, VAT reports, expenses |
| Marketing Manager | Advertising module, campaigns, content, analytics |
| Ad Client (external) | Their own campaigns, reports, and invoices only |
| B2B Customer (external) | Portal: catalogue, wholesale prices, orders, statements |
| Retail Customer (external) | Storefront account, orders, wishlist |

### Manager's Role in the Software (Althaf Najeeb)
- **Owner of the system:** the only Super Admin by default; creates users, assigns roles, and can switch off any user's access
- **Final approver for:**
  - discounts below the minimum selling price and changes to customer credit limits
  - purchase orders above a set amount (configurable, e.g. AED 20,000)
  - new price lists and wholesale price-tier changes
  - write-offs, stock adjustments, and credit notes
  - every advertising campaign and ad creative before it goes live (8A and 8C)
  - client advertising proposals, contracts, and media budgets (8B)
  - influencer deals and payments
- **Authorised signatory:** his name, title "Manager", and digital signature/stamp appear on tax invoices, quotations, client advertising contracts, and monthly agency reports
- **Manager Dashboard:** a one-screen daily view with sales, profit, cash position, receivables, stock value, ad spend vs. ROAS, items waiting for his approval, and licence and document expiry alerts
- **Mobile approvals:** approve or reject requests from his phone, with push, email, and WhatsApp notifications
- **Delegation:** he can hand approval rights to another user for a set period (e.g. while travelling), with every action recorded in the audit log

## MODULES & FEATURES

### 1. Dashboard
- KPIs: today's/this month's sales, gross profit, outstanding receivables, low-stock items, top brands, top customers, active ad campaigns, ad spend vs. ROAS
- Alerts: licence expiry, low stock, overdue invoices, expiring batches, campaign budget limits
- Charts by brand, by customer type (retailer/salon/online seller/export), and by country

### 2. Product & Brand Catalogue
- Brands (logo, origin country, category: designer / niche)
- Products: name, brand, SKU, EAN/barcode, concentration (EDP/EDT/Parfum/Extrait), size (ml), gender, fragrance family, top/heart/base notes, tester vs. retail box, sealed/unsealed, gift sets
- Multiple images, description in English and Arabic
- Price tiers: cost, wholesale tier A/B/C, export price, retail price, minimum allowed selling price
- Batch/lot number, manufacturing and expiry date, country of origin
- Authenticity records: supplier invoice and proof of purchase attached to each batch

### 3. Inventory & Warehouse
- Multiple locations (Deira office/warehouse, third-party storage, in-transit)
- Stock in/out, transfers, adjustments with reasons (damage, sample, tester use)
- Barcode scanning (camera on mobile + USB scanner)
- FIFO/FEFO batch picking, reorder levels, stock valuation (weighted average)
- Stock-take/cycle-count feature

### 4. Purchasing & Suppliers
- Supplier database (local distributors, international suppliers)
- Purchase requests → purchase orders → goods received note → supplier invoice
- Landed cost calculation: freight, customs duty, clearing, insurance spread across items
- Supplier payments, outstanding payables, supplier price history

### 5. Sales & CRM
- Customer types: retailer, salon, online seller, distributor, export buyer
- Customer profile: trade licence copy, TRN (VAT number), credit limit, payment terms, assigned salesperson, price tier
- Lead pipeline (New → Contacted → Sample Sent → Negotiation → Won/Lost)
- Quotations → sales orders → delivery notes → tax invoices → payments
- Credit-limit checks and approval workflow for discounts below minimum price
- Sales commissions per salesperson
- Customer statement of account and payment reminders (email + WhatsApp)
- Activity log: calls, meetings, WhatsApp messages, follow-up tasks

### 6. B2B Customer Portal
- Approved business customers log in and see their own wholesale prices
- Live stock availability, quick order by SKU/barcode, bulk order upload via Excel
- Order history, invoices, statements, re-order button
- Downloadable price list (PDF/Excel) generated per customer tier

### 7. Retail E-commerce Storefront
- Public website: shop by brand, gender, fragrance family, notes, price
- Product pages with notes pyramid, size options, reviews
- Cart, checkout, cash on delivery and online payment (Stripe, Telr, PayTabs, or Network International)
- Delivery integration with UAE couriers (Aramex, Quiq, Jeebly, etc. via API or manual)
- Coupons, gift wrapping, loyalty points
- SEO: meta tags, sitemap, structured product data, Arabic and English URLs
- Must share the same inventory as wholesale (no double-selling)

### 8. ADVERTISING & MARKETING MODULE (core requirement, build it in full)

This module has two parts: **(A)** in-house marketing for LUXORA, and **(B)** an
advertising agency service that LUXORA sells to outside clients (salons, retailers,
online sellers) under its *Online Advertising* and *Advertising Agency* licences.

#### 8A. In-House Marketing (LUXORA's own promotion)
- **Campaign Manager:** create campaigns with name, objective (awareness, leads, sales, B2B sign-ups), brands/products promoted, target market (UAE, GCC, international), audience (B2B/retail), start/end date, budget, channels
- **Channels:** Instagram, Facebook, TikTok, Snapchat, Google Ads, YouTube, WhatsApp Business broadcasts, email newsletters, SMS, influencer partnerships, website banners
- **Ad Creative Library:** upload images/videos, ad copy in English and Arabic, tag by brand/product/campaign, version history, approval workflow (Draft → Review → Approved → Live → Archived)
- **AI Content Assistant:** generate ad copy, captions, hashtags, and product descriptions in English and Arabic from product data (fragrance notes, brand, occasion). Include tone presets: luxury, Ramadan/Eid, National Day, Valentine's, Dubai Shopping Festival, White Friday
- **Content Calendar:** monthly/weekly calendar of posts and campaigns, with UAE seasonal events pre-loaded (Ramadan, Eid al-Fitr, Eid al-Adha, UAE National Day on 2 December, DSF, Mother's Day on 21 March, White Friday, back-to-school)
- **Social Media Scheduler:** schedule posts to Meta (Facebook/Instagram) and TikTok through their official APIs (design the integration layer; use mocks if API keys are unavailable)
- **Email & WhatsApp Marketing:** customer segments (e.g. "salons in Dubai", "online sellers who bought Initio"), templates, broadcast scheduling, opt-in/opt-out management, open/click tracking
- **Promotions Engine:** discount codes, bundle offers, "buy X get tester", wholesale volume discounts, flash sales on the storefront linked to campaigns
- **Landing Page Builder:** simple drag-and-drop landing pages per campaign with lead-capture forms (fields: business name, trade licence, contact, interested brands) that flow straight into the CRM
- **Tracking & Attribution:** UTM link generator, Meta Pixel / Google Analytics / TikTok Pixel installation settings, attribution of orders and leads to campaigns
- **Influencer Management:** influencer database (handle, platform, followers, engagement rate, rates, UAE Media Council advertiser permit number and expiry), gifted product tracking, deliverables, payments, performance per influencer
- **Marketing Analytics Dashboard:** spend, impressions, clicks, CTR, CPC, CPM, leads, conversions, cost per lead, revenue, ROAS, broken down by campaign/channel/brand; manual entry or import (CSV) of ad platform data, plus an API sync design for Meta Ads and Google Ads

#### 8B. Advertising Agency Services (selling ads to outside clients)
- **Ad Client Management:** client profiles (company, trade licence, TRN, contact, industry), contracts, retainer or per-campaign billing
- **Service Packages:** configurable packages, e.g. "Social Media Management – Basic/Pro", "Paid Ads Management", "Content Creation", "Influencer Campaign", "Website Banner Placement", with prices in AED
- **Client Campaign Workflow:** brief → proposal/quotation → client approval → creative production → client creative approval (client can comment and approve in their portal) → launch → reporting → invoice
- **Ad Space Inventory (own media):** sell banner slots on the LUXORA storefront, newsletter sponsorships, and WhatsApp broadcast slots; booking calendar to prevent overlapping bookings, with price per day/week/impression
- **Media Budget Handling:** track the client's ad spend budget separately from the agency fee; record prepaid top-ups and spend deductions; alerts when the budget is low
- **Client Portal:** clients log in to see their campaigns, approve creatives, view live performance reports, download monthly PDF reports, and see/pay invoices
- **Automated Client Reports:** branded monthly PDF performance report (LUXORA logo, KPIs, charts, recommendations)
- **Agency Billing:** retainer invoices, media spend recharges, VAT-compliant tax invoices, payment tracking
- **Team & Task Management:** assign tasks to designers/marketers, deadlines, time tracking per client for profitability
- **Agency Profitability Report:** revenue vs. cost per client and per service

#### 8C. Advertising Compliance Controls
- Checklist before any campaign goes live: brand trademark/logo usage permission noted, no false "original/authentic" claims without supporting batch documents, no misleading pricing, Arabic copy reviewed, influencer permit verified
- Store the UAE Media Council advertiser/advertising licence details for the company and for influencers, with expiry alerts
- Audit log of who approved each ad and when

### 9. Finance & UAE VAT
- Chart of accounts, journal entries, and automatic postings from sales, purchases, and expenses
- **UAE VAT at 5%:** company TRN in settings, VAT-compliant tax invoices (English and Arabic, with "Tax Invoice" title, TRN, and VAT amount in AED), credit notes, zero-rated exports, VAT return report (FTA VAT201 layout)
- Corporate tax readiness: profit & loss and balance sheet exports (note free-zone status in settings)
- Bank accounts, cash, PDC (post-dated cheque) management, which is very common in UAE trade
- Expenses with receipt upload
- Reports: P&L, balance sheet, trial balance, aged receivables/payables, profit by brand/product/customer, cash flow

### 10. Shipping & Export
- Local delivery tracking (own driver or courier)
- Export documents: commercial invoice, packing list, certificate of origin request details, HS codes per product
- Shipment status tracking and attach AWB/BL documents

### 11. Company Compliance & Documents
- Store the company profile, licence, formation details, and manager details (pre-fill with the data above)
- **Document vault with expiry alerts:** trade licence (expires 27 October 2026; show renewal alerts 90/60/30/7 days before), establishment card, VAT certificate, Media Council licence, insurance, tenancy/Flexi Desk agreement, employee visas and Emirates IDs
- Show on the dashboard which licensed activities each module uses (e.g. advertising agency → Module 8B)

### 12. HR (lightweight)
- Employees, visa/Emirates ID expiry, salaries, commissions, leave
- Export of salary data for WPS processing

### 13. Settings
- Company details, logo, invoice templates, numbering formats (e.g. LUX-INV-2026-0001)
- Tax settings, currencies, price tiers, user roles and permissions
- Integrations: payment gateways, couriers, WhatsApp Business API, Meta, Google, TikTok, email (SMTP)
- Backup and data export

## BRANDING / UI
- Luxury feel: black, gold (#C9A646), and ivory palette; elegant serif for headings and a clean sans-serif for body text
- Company name "LUXORA" as the wordmark
- Clean, fast admin panel; beautiful, image-led storefront
- Fully responsive; the admin panel must work well on a phone for salespeople in the field
- Arabic RTL layout toggle everywhere

## NON-FUNCTIONAL REQUIREMENTS
- Security: hashed passwords, RBAC on every API route, audit logs, rate limiting, HTTPS, daily database backups
- Performance: pagination, search with filters, image optimization
- Data import: Excel/CSV import for products, customers, and opening stock
- Exports to Excel/PDF on every list and report
- Unit tests for core business logic (pricing, VAT, stock movements, ad budget deductions)
- Clear README with setup, environment variables, and deployment steps

## DATABASE
Design the complete PostgreSQL schema (Prisma) first, including at minimum: users, roles,
brands, products, product_variants, batches, warehouses, stock_movements, suppliers,
purchase_orders, customers, leads, quotations, sales_orders, invoices, payments,
credit_notes, expenses, accounts, journal_entries, shipments, documents, employees,
ad_clients, ad_contracts, service_packages, campaigns, campaign_channels, ad_creatives,
creative_approvals, content_calendar_items, ad_slots, ad_slot_bookings, media_budgets,
ad_spend_entries, influencers, influencer_deals, marketing_segments, broadcasts,
promotions, coupons, landing_pages, leads_sources, utm_links, campaign_metrics, tasks,
audit_logs, settings.

## HOW TO DELIVER (follow this order and pause after each step)
1. **System architecture & folder structure:** short explanation plus a diagram in text
2. **Full database schema** (Prisma), with relations explained
3. **Backend:** auth & RBAC, then each module's API (catalogue → inventory → purchasing → sales/CRM → finance/VAT → advertising → compliance)
4. **Frontend admin panel:** layout, dashboard, then each module's screens
5. **Advertising module in full** (8A, 8B, 8C), including the client portal and PDF reports
6. **B2B portal and retail storefront**
7. **Seed data:** the company details above, the 16 brands, 30 sample products, sample customers, 2 sample ad clients, 3 sample campaigns
8. **Tests, Docker setup, README, and deployment guide**

After each step, ask me: *"Continue to the next step?"* Do not skip code or write
"// rest of code here". Give complete files. If the response is too long, stop at a
clean file boundary and continue in the next message.

## START NOW
Start with **Step 1: System architecture & folder structure**.
