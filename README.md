# Company website: full-stack version
Node.js + Express backend, JSON-file database, vanilla JS frontend (public/).

## Run it
1. Install Node.js 20.6+ (https://nodejs.org)
2. In this folder: `npm install`
3. Copy `.env.example` to `.env` and set ADMIN_PASSWORD and SECRET (long random text)
4. `npm start`  ->  open http://localhost:3000
5. Admin dashboard: http://localhost:3000/#/admin

## What is included
- Cart, checkout (pay on delivery / bank transfer / Stripe card), order tracking
- Customer accounts with order history
- Admin dashboard: products (with photos), orders, quote requests, messages, project gallery, settings, page-view stats
- Quote request form + contact form (saved on the server, read in the dashboard)
- WhatsApp button and per-product WhatsApp ordering, Google Analytics ID field
- Responsive, dark-mode aware design

## Card payments (optional)
Set STRIPE_SECRET_KEY in .env. For automatic "paid" status, add a Stripe webhook
(event: checkout.session.completed) pointing to https://YOUR-DOMAIN/api/stripe-webhook
and set STRIPE_WEBHOOK_SECRET.

## Before going live
- Host on a Node host (Render, Railway, Fly.io, a VPS) with HTTPS. The database is the file data/db.json,
  so use a persistent disk and back it up. For heavy traffic move to PostgreSQL.
- Use a strong ADMIN_PASSWORD and SECRET. Keep .env private.
- Order/quote emails are not sent automatically; they appear in the dashboard. Add nodemailer if you want email alerts.
