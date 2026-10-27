# JNL SHOP — e-commerce site

Node.js + Express backend, atomic JSON-file database, vanilla JS storefront (`public/`).
No build step, no framework migration: the original site architecture, design and data
were kept and extended.

## Run it

1. Install Node.js 20.6+ (https://nodejs.org)
2. `npm install`
3. `cp .env.example .env` and set at least `ADMIN_PASSWORD` and `SECRET`
   (`openssl rand -hex 32`). Add Stripe keys when you are ready to take real payments.
4. `npm start` → http://localhost:3000
5. Admin dashboard: http://localhost:3000/#/admin (blank email + `ADMIN_PASSWORD` = super admin)

`npm run dev` restarts on file changes.

## What is included

**Storefront**
- Shop page titled **JNL SHOP** with an automatic hero carousel: configurable interval,
  arrows, dots, pause on hover/focus, touch swipe, `prefers-reduced-motion` support.
- Cart button sits immediately after the product search field with a live count (and a
  matching accessible name). No cart link in the global navbar.
- Light/dark theme toggle in the navbar; the choice is stored and applied before first
  paint, so pages, forms, modals, cards and dashboards never flash the wrong theme.
- Every hero with a background image gets the same legibility gradient (clear at the top,
  progressively darker toward the bottom).
- Responsive at 390 px / tablet / desktop with no horizontal overflow.

**Cart and checkout**
- Guests can browse and add to a temporary cart; the cart survives registration and login.
- Checkout requires an account: guests are sent to Create Account and returned to checkout.
- Address validation (street, city, province/territory, Canadian postal code, phone, email)
  with province ⇄ postal-code matching; an unserviceable or invalid destination is refused
  rather than quoted.
- The server recalculates every price, quantity, discount, shipping fee and tax. Browser
  totals are ignored, and the order is snapshotted so later price changes cannot alter it.
- Confirmation appears only after the server has verified the payment (provider response
  and/or signed webhook).

**Payments (Stripe)**
- Primary integration: **PaymentIntents + Stripe Elements** (card fields are Stripe-hosted;
  card data never reaches this server) with 3-D Secure support, retry, cancel and failure
  states, and separate payment vs. fulfillment status.
- Amounts are integer minor units (cents) in CAD.
- Idempotency keys on payment and order creation; replaying one returns the same order.
- Webhooks are signature-verified, timestamp-tolerant, replay-protected and idempotent;
  duplicate and out-of-order events cannot change a settled order.
- With no `STRIPE_SECRET_KEY` the app runs a clearly-labelled **local sandbox** provider
  (same server-side state machine, same HMAC webhook, no money). It exists for development
  and is never a substitute for the real provider — the UI says so on every payment screen.

**Saved cards**
- Optional, consent-based ("Save this card for faster checkout") via SetupIntents.
- Only the provider's customer/payment-method ids plus brand, last four digits and expiry
  are stored. No PAN, CVV or PIN is stored, logged or sent to the browser; customers can
  add, make default and remove cards, and only their owner can touch them.

**Canadian shipping and tax**
- Postal codes are normalised and validated (Canada Post FSA rules) and matched to the
  selected province; FSA prefixes map to configurable delivery zones with per-zone rates,
  per-kg pricing, a maximum weight and a free-shipping threshold.
- Delivery methods (Standard / Express) multiply or override the zone rate.
- GST/HST/PST rates are per province/territory and configurable, with a tax-on-shipping
  switch. No single hardcoded "Canadian tax" exists.
- If a rate cannot be determined the UI shows an em dash and asks for the address instead
  of inventing a fee.

**Orders, tracking, invoices**
- Human-readable numbers (`JNL-2026-0001`, invoices `JNL-INV-…`, credit notes `JNL-CN-…`)
  and explicit lifecycles: payment (`requires_payment`, `processing`, `paid`, `failed`,
  `cancelled`, `partially_refunded`, `refunded`) tracked separately from fulfillment
  (`unfulfilled`, `processing`, `shipped`, `out_for_delivery`, `delivered`, `cancelled`).
  Fulfillment updates never change payment status.
- Customers get a dashboard with order history, a chronological event timeline, shipment
  details with a carrier link, PDF invoices and payment status.
- Tracking is only ever what a carrier webhook or an administrator recorded, labelled with
  its source ("Shipment entered by our team"), never simulated.
- PDF invoices are generated server-side (PDFKit), stored privately and served through
  authorised endpoints with `Cache-Control: private, no-store`.

**Administration**
- Tabs: Sales, Products, Orders, Invoices, Payments, Quotes, Messages, Projects, Staff,
  Customers, Settings, Stats, Audit.
- Roles: `admin` (day-to-day operations) and `super` (financials). Refunds, the audit log,
  staff/customer management and settings are super-only, enforced on the server, not just
  hidden in the UI.
- Orders and invoices are searchable and filterable by date, customer, number, payment,
  fulfillment and refund state; card data is never displayed because it is never stored.
- Refunds go through the provider, issue credit notes and are recorded in the audit log
  with actor, target and time, as are fulfillment changes and invoice downloads.

## Configuration (admin → Settings)

Stored in `data/db.json` and editable in the dashboard: business/legal name, address, email,
phones, hours, logo and hero images, carousel slides + interval, low-stock threshold,
invoice prefix and retention, per-province tax rates, tax-on-shipping, shipping zones
(FSA prefixes → rate), delivery methods, free-shipping threshold, per-kg rate, maximum
weight, bank details, discount codes.

## Environment variables

See [.env.example](.env.example) — core (`PORT`, `ADMIN_PASSWORD`, `SECRET`, `SITE_URL`,
`TRUST_PROXY`), Stripe (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
`STRIPE_WEBHOOK_SECRET`, `SANDBOX_WEBHOOK_SECRET`, `SHOP_CURRENCY`), carrier
(`CARRIER_WEBHOOK_SECRET`) and email (`MAIL_WEBHOOK_URL`, `MAIL_WEBHOOK_TOKEN`,
`MAIL_FROM`). Secrets live only in `.env` (git-ignored) and on the server; nothing is read
from the browser.

### Stripe setup

1. In the Stripe Dashboard create/verify the account, enable the currencies, methods and
   payouts you need for Canadian settlement.
2. Copy the **test** keys into `.env`: `STRIPE_SECRET_KEY=sk_test_…` and
   `STRIPE_PUBLISHABLE_KEY=pk_test_…`. The UI switches out of sandbox mode automatically.
3. Add an endpoint at `https://YOUR-DOMAIN/api/stripe-webhook` and subscribe to
   `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `payment_intent.canceled`, `payment_intent.requires_action`,
   `charge.refunded` and `charge.dispute.created`. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.
4. Test the failure, 3-D Secure, cancel and retry paths with Stripe test cards, then swap
   in live keys on the server only.

### Carrier tracking

Set `CARRIER_WEBHOOK_SECRET` and POST shipment updates to `/api/webhooks/carrier` signed
with the same `t=…,v1=…` HMAC scheme (header `x-carrier-signature`). Duplicate provider
event ids are ignored. Without it, administrators add carrier, tracking number, tracking URL
and manual tracking events from the order panel.

## Data, backups and migrations

- Database: `data/db.json`, written atomically (temp file + rename) and mutated inside a
  serialised transaction, so critical order/payment operations cannot interleave. Existing
  data is migrated in place on boot (`lib/db.js`); back up before upgrades — previous
  copies are kept as `data/db.json.pre-ecom` / `data/db.json.orig`.
- Invoice PDFs: `data/invoices/` (private; downloaded through authorised endpoints only).
- Set `DB_FILE` to point a server at another database file (used by the test suites and for
  restore drills) — e.g. `DB_FILE=/tmp/drill.json PORT=3201 npm start`.
- Back up `data/` (database + invoices) on a schedule and test a restore. Retain invoices
  for the period in Settings (default 7 years).

## Tests

Start the server, then:

```bash
node .freebuff/test-commerce.mjs   # commerce acceptance: cart, checkout, payments, webhooks,
                                   # orders, tracking, invoices, refunds, RBAC  (107 checks)
node .freebuff/test-api.mjs        # admin roles, sales ranges, CSV exports      (68 checks)
```

Both suites assert absolute figures, so run each against its own throwaway database rather
than the live one:

```bash
# commerce suite on a fresh database
rm -f /tmp/db-commerce.json
DB_FILE=/tmp/db-commerce.json PORT=3201 node --env-file=.env server.js &
BASE=http://127.0.0.1:3201 node .freebuff/test-commerce.mjs

# legacy/admin suite on its seeded dataset
DB_FILE=/tmp/db-legacy.json node .freebuff/mkdb.js
DB_FILE=/tmp/db-legacy.json PORT=3202 node --env-file=.env server.js &
BASE=http://127.0.0.1:3202 node .freebuff/test-api.mjs
```

The suites exercise real server-side flows and a real HMAC-signed webhook; no real card is
ever used, and the sandbox provider moves no money. Stop each test server afterwards
(`taskkill //PID <pid> //F` on Windows, `kill <pid>` elsewhere).

## Before going live

- Host on a Node host (Render, Railway, Fly.io, a VPS) **with HTTPS** and set `SITE_URL` and
  `TRUST_PROXY=1`; never serve card forms over plain HTTP.
- Use strong `ADMIN_PASSWORD` and `SECRET`, keep `.env` private and out of git, rotate keys
  and enable the provider's fraud/3-D Secure tooling.
- Keep test and live Stripe keys separate; only live keys belong on the production server.
- Turn on backups (see above) and error visibility; the app logs structured errors without
  passwords, secrets, tokens or card data.
- Apply your privacy obligations (PIPEDA/provincial): the store keeps only the data needed
  to fulfil orders, per-account access is enforced, and retention is configurable.
- The JSON database is suitable for a single small shop on one process and one disk. Behind
  a load balancer or for heavy traffic, move the collections to PostgreSQL first — the
  commerce logic already lives in `lib/` services rather than in the routes.
