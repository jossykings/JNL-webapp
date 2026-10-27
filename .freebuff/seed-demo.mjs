#!/usr/bin/env node
// -----------------------------------------------------------------------------
// JNL SHOP — demo dataset.
//
// Everything here is created by driving the shop's own HTTP API, so each record
// (payment intent, webhook event, invoice and credit note, tracking timeline,
// notification, audit entry) is produced by the real server code paths instead
// of being hand-written into data/db.json. That is what makes the demo faithful:
// it exercises the same validation, pricing, idempotency and state machines a
// real customer would hit.
//
// Payments run against the sandbox provider (no STRIPE_SECRET_KEY configured):
// no network calls, no money moves, and no card data exists anywhere. Every
// sandbox payment is stored as pi_sbx_* and the UI badges it as sandbox. All
// demo people use @demo.jnl.shop addresses and the accounts below.
//
//   node .freebuff/seed-demo.mjs --seed      (server must be running)
//   node .freebuff/seed-demo.mjs --history   (stop the server first)
//   node .freebuff/seed-demo.mjs --wipe      (stop the server first)
//
// --seed     creates the dataset through the API. Re-runnable: it signs in
//            existing demo accounts instead of failing on duplicates, and skips
//            any order it has already created.
// --history  rewrites dates in data/db.json so orders, invoices and delivery
//            timelines are spread over the past four months (the API can only
//            stamp "now"). Run with the server stopped, then start it again.
// --wipe     removes every demo record and restores reserved stock.
// -----------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';

const PHASE = (process.argv.find(a => a.startsWith('--')) || '--seed').slice(2);
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const DB_FILE = process.env.DB_FILE || path.join('data', 'db.json');

const DEMO_DOMAIN = 'demo.jnl.shop';
const DEMO_PW = 'Jnldemo!2026';
const mail = e => `${e}@${DEMO_DOMAIN}`;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function api(route, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (CSV/PDF) */ }
  return { status: r.status, json, text };
}

let failures = 0;
const step = (label, detail = '') => console.log(`  ${label}${detail ? '  —  ' + detail : ''}`);
function must(label, r, check = j => !!j) {
  if (r.status >= 200 && r.status < 300 && check(r.json)) return r.json;
  failures += 1;
  console.log(`  FAIL  ${label}  [${r.status}] ${String(r.text).slice(0, 240)}`);
  return null;
}

const adminPassword = () => {
  const env = fs.readFileSync('.env', 'utf8');
  return (env.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim() || '';
};

// ---------------------------------------------------------------------------
// The demo people and their delivery addresses
// ---------------------------------------------------------------------------
const PEOPLE = {
  amara: {
    name: 'Amara Okafor', email: mail('amara.okafor'), phone: '416-555-0142',
    street: '120 Harbourfront Ave, Unit 903', city: 'Toronto', province: 'ON', postalCode: 'M5V 3L9'
  },
  marcus: {
    name: 'Marcus Tremblay', email: mail('marcus.tremblay'), phone: '438-555-0117',
    street: '455 Rue Saint-Antoine O', city: 'Montréal', province: 'QC', postalCode: 'H2Y 1C6'
  },
  priya: {
    name: 'Priya Sandhu', email: mail('priya.sandhu'), phone: '403-555-0163',
    street: '888 4 Ave SW', city: 'Calgary', province: 'AB', postalCode: 'T2P 2M5'
  }
};

const CP = 'https://www.canadapost-postescanada.ca/track-reparc/en?trackNumber=';

// Oldest first: invoice and order numbers stay in chronological order.
// outcome: sandbox card result — succeed | fail | auth (needs authentication) | cancel
// refund:  'full' | amount in cents
const PLAN = [
  {
    key: 'A1', who: 'amara', days: 108, items: [{ id: 'p3', qty: 3 }, { id: 'p2', qty: 2 }],
    discountCode: 'WELCOME10',
    fulfil: [
      ['shipped', { carrier: 'Canada Post', trackingNumber: 'CX200118456CA', trackingUrl: CP + 'CX200118456CA' }],
      ['out_for_delivery', {}],
      ['delivered', {}]
    ],
    tracking: [
      { status: 'in_transit', description: 'Item processed at the Mississauga sorting facility', location: 'Mississauga, ON' },
      { status: 'out_for_delivery', description: 'Out for delivery', location: 'Toronto, ON' }
    ]
  },
  {
    key: 'P1', who: 'priya', days: 88, items: [{ id: 'p1', qty: 4 }, { id: 'p3', qty: 1 }],
    fulfil: [
      ['shipped', { carrier: 'Purolator', trackingNumber: 'PU7741220398', trackingUrl: 'https://www.purolator.com/en/shipping/tracker?pin=PU7741220398' }],
      ['delivered', {}]
    ],
    tracking: [{ status: 'in_transit', description: 'Departed the Calgary sort facility', location: 'Calgary, AB' }]
  },
  { key: 'A2', who: 'amara', days: 74, items: [{ id: 'p2', qty: 2 }], refund: 1000, fulfil: [['processing', {}]] },
  { key: 'M1', who: 'marcus', days: 63, items: [{ id: 'p1', qty: 1 }], outcome: 'fail' },
  { key: 'A3', who: 'amara', days: 41, items: [{ id: 'p1', qty: 1 }], useSavedCard: true, fulfil: [['processing', {}]] },
  { key: 'M2', who: 'marcus', days: 34, items: [{ id: 'p2', qty: 4 }], method: 'bank' },
  { key: 'M3', who: 'marcus', days: 20, items: [{ id: 'p2', qty: 1 }], outcome: 'cancel' },
  { key: 'M4', who: 'marcus', days: 12, items: [{ id: 'p3', qty: 2 }], refund: 'full' },
  {
    key: 'A4', who: 'amara', days: 9, items: [{ id: 'p1', qty: 2 }, { id: 'p3', qty: 1 }], shippingMethod: 'express',
    fulfil: [[
      'shipped',
      { carrier: 'FedEx', trackingNumber: '771244558890', trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr=771244558890' }
    ]],
    tracking: [{ status: 'label_created', description: 'Shipping label created; awaiting carrier pickup', location: 'Toronto, ON' }]
  },
  { key: 'P2', who: 'priya', days: 4, items: [{ id: 'p1', qty: 1 }], outcome: 'auth' },
  { key: 'P3', who: 'priya', days: 1, items: [{ id: 'p2', qty: 6 }] }
];

// Left in the cart so the checkout journey can be walked live in the browser.
const OPEN_CART = { who: 'amara', items: [{ id: 'p1', qty: 1 }, { id: 'p2', qty: 3 }] };

// ---------------------------------------------------------------------------
// Phase: seed
// ---------------------------------------------------------------------------
async function authFor(p) {
  let r = await api('/api/auth/register', { method: 'POST', body: { name: p.name, email: p.email, password: DEMO_PW } });
  if (!r.json?.token) r = await api('/api/auth/login', { method: 'POST', body: { email: p.email, password: DEMO_PW } });
  const token = r.json?.token;
  if (!token) throw new Error(`could not sign in ${p.email}: ${r.status} ${r.text}`);
  await api('/api/me/profile', { method: 'PATCH', token, body: { phone: p.phone } });
  return { ...p, token, id: r.json.user.id };
}

async function addCard(c) {
  const si = must('setup intent', await api('/api/payments/methods/setup-intent', { method: 'POST', token: c.token, body: {} }));
  if (!si) return null;
  const done = must('sandbox card setup', await api('/api/payments/sandbox/setup', { method: 'POST', token: c.token, body: { setupIntentId: si.setupIntentId } }));
  if (!done) return null;
  const saved = must('save card', await api('/api/payments/methods', { method: 'POST', token: c.token, body: { paymentMethodId: done.paymentMethodId } }));
  return saved ? saved.methods : null;
}

async function placeOrder(c, o, savedCardId) {
  await api('/api/cart', { method: 'PUT', token: c.token, body: { items: o.items } });
  const body = {
    items: o.items,
    street: c.street, city: c.city, province: c.province, postalCode: c.postalCode,
    name: c.name, email: c.email, phone: c.phone,
    shippingMethod: o.shippingMethod || 'standard',
    paymentMethod: o.method || 'card',
    discountCode: o.discountCode || '',
    savedPaymentMethodId: o.useSavedCard && savedCardId ? savedCardId : ''
  };
  const co = must(`checkout ${o.key}`, await api('/api/checkout', {
    method: 'POST', token: c.token, headers: { 'Idempotency-Key': 'demo:' + o.key }, body
  }), j => j && j.order);
  if (!co) return null;
  if (co.replayed) return { ...co.order, replayed: true };
  let order = co.order;
  if ((o.method || 'card') === 'card') {
    const conf = must(`payment ${o.key} (${o.outcome || 'succeed'})`, await api('/api/payments/sandbox/confirm', {
      method: 'POST', token: c.token, body: { orderId: order.id, outcome: o.outcome || 'succeed' }
    }), j => j && j.order);
    if (conf) order = conf.order;
  }
  return order;
}

async function seed() {
  console.log(`Seeding JNL SHOP demo data via ${BASE}\n`);

  const admin = must('admin sign-in', await api('/api/admin/login', { method: 'POST', body: { password: adminPassword() } }));
  if (!admin) throw new Error('Admin sign-in failed — is the server running and .env ADMIN_PASSWORD set?');
  const at = admin.token;

  // --- housekeeping: retire the discarded test staff account -----------------
  const staff = (await api('/api/admin/staff', { token: at })).json || [];
  for (const s of staff.filter(s => /@test\.dev$/i.test(s.email))) {
    await api(`/api/admin/staff/${s.id}`, { method: 'DELETE', token: at });
    step('removed leftover test staff account', s.email);
  }
  const staffList = (await api('/api/admin/staff', { token: at })).json || [];
  if (!staffList.some(s => s.email === mail('shop.ops'))) {
    must('create limited staff account', await api('/api/admin/staff', {
      method: 'POST', token: at,
      body: { name: 'Shop Ops (admin role)', email: mail('shop.ops'), password: DEMO_PW, role: 'admin' }
    }));
    step('created staff account', `${mail('shop.ops')} (role admin)`);
  }

  // --- discount -------------------------------------------------------------
  const discounts = (await api('/api/admin/discounts', { token: at })).json || [];
  if (!discounts.some(d => d.code === 'WELCOME10')) {
    must('create discount', await api('/api/admin/discounts', {
      method: 'POST', token: at,
      body: { code: 'WELCOME10', type: 'percent', value: 10, minSubtotal: 100, usageLimit: 200 }
    }));
    step('created discount code', 'WELCOME10 — 10% off, min $100 subtotal');
  }

  // --- customers, with saved cards -----------------------------------------
  const customers = {};
  for (const [key, p] of Object.entries(PEOPLE)) {
    const c = await authFor(p);
    customers[key] = c;
    const cards = await addCard(c);
    if (cards) {
      c.cardId = cards[0].id;
      step(`saved card for ${c.name}`, `brand "${cards[0].brand}" ••••${cards[0].last4} (sandbox test card)`);
    }
    if (key === 'amara') {
      const second = await addCard(c);
      if (second && second[1]) await api(`/api/payments/methods/${second[1].id}/default`, { method: 'POST', token: c.token, body: {} });
    }
  }

  // --- orders across every lifecycle state ---------------------------------
  for (const o of PLAN) {
    const c = customers[o.who];
    const order = await placeOrder(c, o, c.cardId);
    if (!order) continue;
    if (order.replayed) {
      step(`order ${o.key} already seeded`, order.number);
      continue;
    }
    step(`order ${o.key}`, `${order.number}  ${order.paymentStatus || 'requires_payment'}  ${(order.totalCents / 100).toFixed(2)} ${String(order.currency).toUpperCase()}`);

    for (const [status, extra] of o.fulfil || []) {
      const r = must(`fulfilment ${o.key} -> ${status}`, await api(`/api/admin/orders/${order.id}/fulfillment`, {
        method: 'PATCH', token: at, body: { fulfillmentStatus: status, ...extra }
      }));
      if (r) step(`  fulfilment ${status}`, r.order.fulfillmentStatus);
    }
    for (const ev of o.tracking || []) {
      const r = await api(`/api/admin/orders/${order.id}/tracking`, { method: 'POST', token: at, body: ev });
      if (r.status === 200) step('  tracking event', ev.description);
      else { failures += 1; console.log(`  FAIL  tracking ${o.key} [${r.status}] ${r.text.slice(0, 160)}`); }
    }
    if (o.refund) {
      const body = o.refund === 'full' ? { full: true, reason: 'requested_by_customer' } : { amountCents: o.refund, reason: 'requested_by_customer' };
      const r = must(`refund ${o.key}`, await api(`/api/admin/orders/${order.id}/refund`, { method: 'POST', token: at, body }));
      if (r) step('  refund issued', `${(r.refund.amountCents / 100).toFixed(2)} ${String(order.currency).toUpperCase()} -> ${r.order.paymentStatus}`);
    }
  }

  // --- an open cart to walk the checkout journey with ------------------------
  const amara = customers.amara;
  if (OPEN_CART.items.length) {
    await api('/api/cart', { method: 'PUT', token: amara.token, body: { items: OPEN_CART.items } });
    step('cart left open for', amara.email);
  }

  // --- existing site features, so their admin tabs are not empty -------------
  await api('/api/quotes', { method: 'POST', body: {
    name: 'Derek Whitfield', email: mail('derek.whitfield'), phone: '905-555-0188', service: 'Turnkey project engineering',
    details: 'We need a 4,000 sq ft warehouse fit-out quoted: electrical distribution, ventilation and safety equipment. Target start next quarter.'
  } });
  await api('/api/messages', { method: 'POST', body: {
    name: 'Lena Chen', email: mail('lena.chen'), body: 'Do you stock replacement actuators for the 2-inch gate valves, and can you ship to Vancouver?'
  } });
  step('added one quote request and one contact message');

  console.log(`\nSeed complete. ${failures ? failures + ' failure(s) above.' : 'No failures.'}`);
  console.log(`Customer logins: <name>@${DEMO_DOMAIN}  password  ${DEMO_PW}`);
  console.log('Next: stop the server, run --history to spread the dates, then start it again.');
  return failures;
}

// ---------------------------------------------------------------------------
// Phase: history (dates are rewritten directly in the JSON database)
// ---------------------------------------------------------------------------
const HOUR = 3600e3, DAY = 864e5;

// Plausible spacing between consecutive timeline events, per event type.
const GAP = {
  created: 0,
  payment_pending: 2 * HOUR,
  payment_processing: 2 * HOUR,
  payment_paid: 2 * HOUR,
  payment_failed: 2 * HOUR,
  payment_cancelled: 2 * HOUR,
  payment_partially_refunded: 2 * DAY,
  payment_refunded: 2 * DAY,
  invoice_created: 0,
  fulfillment_processing: DAY,
  fulfillment_shipped: 3 * DAY,
  tracking: DAY,
  fulfillment_out_for_delivery: DAY,
  fulfillment_delivered: DAY,
  fulfillment_cancelled: HOUR,
  default: HOUR
};

function isDemoOrder(o, demoIds) {
  return demoIds.has(o.userId) || /@demo\.jnl\.shop$/i.test(o.customer?.email || o.email || '');
}

function history() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const demoIds = new Set((db.users || []).filter(u => /@demo\.jnl\.shop$/i.test(u.email)).map(u => u.id));
  const orders = (db.orders || []).filter(o => isDemoOrder(o, demoIds));
  if (!orders.length) throw new Error('No demo orders found — run --seed first.');

  // The seeding plan is the source of truth for how far back each order goes;
  // its stable idempotency key links the plan entry to the stored order.
  const planDays = new Map(PLAN.map(p => ['demo:' + p.key, p.days]));

  const seedTime = Date.now();
  let invoices = 0, audits = 0, notes = 0, payments = 0;

  for (const o of orders) {
    const target = seedTime - (planDays.get(o.idempotencyKey) || 30) * DAY;
    const shift = target - Date.parse(o.date);

    // Timeline: keep the recorded order, space the events out plausibly.
    let cursor = target;
    for (const ev of o.events || []) {
      ev.at = new Date(cursor).toISOString();
      cursor += GAP[ev.type] ?? GAP.default;
    }
    o.date = new Date(target).toISOString();
    o.updatedAt = (o.events?.length ? o.events[o.events.length - 1].at : o.date);

    // Shipment timeline follows the shipment itself.
    if (o.shipment) {
      const shipped = (o.events || []).find(e => e.type === 'fulfillment_shipped');
      let sc = shipped ? Date.parse(shipped.at) : target + 3 * DAY;
      if (o.shipment.shippedAt) o.shipment.shippedAt = new Date(sc).toISOString();
      for (const ev of o.shipment.events || []) {
        ev.at = new Date(sc).toISOString();
        sc += DAY;
      }
      if (o.shipment.lastEvent) {
        const last = (o.shipment.events || [])[o.shipment.events.length - 1];
        o.shipment.lastEvent.at = last ? last.at : new Date(sc).toISOString();
      }
      if (o.estimateDeliveryAt) {
        const days = Number((String(o.shippingLabel).match(/(\d+)/) || [])[1]) || 5;
        o.estimateDeliveryAt = new Date(Date.parse(shipped?.at || o.date) + days * DAY).toISOString();
      }
    }

    // Related invoices and credit notes keep the order's dates.
    for (const inv of (db.invoices || []).filter(i => i.orderId === o.id)) {
      inv.date = o.date;
      invoices += 1;
    }
    // Payments, refunds and notifications.
    for (const p of (db.payments || []).filter(p => p.orderId === o.id)) {
      const paid = (o.events || []).find(e => e.type === 'payment_paid' || e.type === 'payment_failed' || e.type === 'payment_cancelled');
      p.createdAt = new Date(target + 5 * 60e3).toISOString();
      p.updatedAt = paid ? paid.at : p.createdAt;
      payments += 1;
    }
    for (const r of o.refunds || []) {
      const ev = (o.events || []).find(e => String(e.type).includes('refund'));
      r.date = ev ? ev.at : new Date(target + DAY).toISOString();
    }
    for (const n of (db.users.find(u => u.id === o.userId)?.notifications || []).filter(n => n.orderId === o.id)) {
      n.at = o.updatedAt;
      notes += 1;
    }
    for (const a of (db.audit || []).filter(a => a.target === 'order' && a.targetId === o.id)) {
      a.at = o.updatedAt;
      audits += 1;
    }
    o.demo = true;
  }

  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  console.log(`Backdated ${orders.length} demo orders (${invoices} invoices, ${audits} audit entries, ${notes} notifications, ${payments} payment records).`);
  return 0;
}

// ---------------------------------------------------------------------------
// Phase: wipe
// ---------------------------------------------------------------------------
function wipe() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const demoUsers = (db.users || []).filter(u => /@demo\.jnl\.shop$/i.test(u.email));
  const demoIds = new Set(demoUsers.map(u => u.id));
  const demoOrders = (db.orders || []).filter(o => isDemoOrder(o, demoIds));
  const orderIds = new Set(demoOrders.map(o => o.id));
  const invoiceIds = new Set((db.invoices || []).filter(i => orderIds.has(i.orderId)).map(i => i.id));
  const invoiceFiles = (db.invoices || []).filter(i => invoiceIds.has(i.id)).map(i => i.file).filter(Boolean);
  const staffIds = new Set((db.staff || []).filter(s => /@demo\.jnl\.shop$/i.test(s.email)).map(s => s.id));
  const discountIds = new Set((db.discounts || []).filter(d => d.code === 'WELCOME10').map(d => d.id));
  // Match on the actor/target metadata as well as the ids, so a second wipe
  // still clears entries whose user, staff or discount row is already gone.
  const demoEmail = /@demo\.jnl\.shop$/i;
  const auditIsDemo = a =>
    (a.target === 'order' && orderIds.has(a.targetId)) ||
    (a.target === 'user' && (demoIds.has(a.actorId) || demoEmail.test(a.actor))) ||
    (a.target === 'staff' && (staffIds.has(a.targetId) || demoEmail.test(a.meta?.email || ''))) ||
    (a.target === 'discount' && (discountIds.has(a.targetId) || a.meta?.code === 'WELCOME10'));

  // Stock was reserved when each order was created, and released again only for
  // orders whose payment was cancelled.
  for (const o of demoOrders.filter(o => o.paymentStatus !== 'cancelled')) {
    for (const it of o.items || []) {
      const p = (db.products || []).find(p => p.id === it.id);
      if (p) p.stock = (Number(p.stock) || 0) + it.qty;
    }
  }

  const before = {
    users: (db.users || []).length, orders: (db.orders || []).length, invoices: (db.invoices || []).length
  };
  db.users = (db.users || []).filter(u => !demoIds.has(u.id));
  db.orders = (db.orders || []).filter(o => !orderIds.has(o.id));
  db.invoices = (db.invoices || []).filter(i => !invoiceIds.has(i.id));
  db.carts = (db.carts || []).filter(c => !demoIds.has(c.userId));
  db.payments = (db.payments || []).filter(p => !orderIds.has(p.orderId));
  db.trackingEvents = (db.trackingEvents || []).filter(t => !orderIds.has(t.orderId));
  db.notifications = (db.notifications || []).filter(n => !demoIds.has(n.userId));
  db.audit = (db.audit || []).filter(a => !auditIsDemo(a));
  db.staff = (db.staff || []).filter(s => !/@demo\.jnl\.shop$/i.test(s.email));
  db.discounts = (db.discounts || []).filter(d => d.code !== 'WELCOME10');
  db.quotes = (db.quotes || []).filter(q => !/@demo\.jnl\.shop$/i.test(q.email || ''));
  db.messages = (db.messages || []).filter(m => !/@demo\.jnl\.shop$/i.test(m.email || ''));
  // Sandbox intents and provider records that belonged to the demo orders
  const intentIds = new Set(demoOrders.map(o => o.paymentIntentId).filter(Boolean));
  db.paymentIntents = (db.paymentIntents || []).filter(i => !intentIds.has(i.id));
  const customerIds = new Set(demoUsers.map(u => u.stripeCustomerId).filter(Boolean));
  db.setupIntents = (db.setupIntents || []).filter(s => !customerIds.has(s.customerId));

  // With no orders or invoices left, restart the human-readable numbering so a
  // fresh demo dataset begins at 0001. Guarded: counters are only reset when
  // nothing still refers to them.
  if (!db.orders.length) db.counters.order = 0;
  if (!db.invoices.length) { db.counters.invoice = 0; db.counters.credit = 0; }

  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  for (const f of invoiceFiles) {
    const abs = path.join('data', 'invoices', path.basename(f));
    if (fs.existsSync(abs)) fs.rmSync(abs);
  }
  console.log(`Removed ${before.orders - (db.orders.length)} demo orders, ${before.users - db.users.length} demo customers, ` +
    `${before.invoices - db.invoices.length} invoices/credit notes, and ${invoiceFiles.length} PDF file(s). Reserved stock restored.`);
  return 0;
}

// ---------------------------------------------------------------------------
const phase = { seed, history, wipe }[PHASE];
if (!phase) {
  console.log(`Unknown phase "${PHASE}". Use --seed, --history or --wipe.`);
  process.exit(2);
}
try {
  const code = await phase();
  process.exit(code || 0);
} catch (e) {
  console.error('FAILED: ' + e.message);
  process.exit(1);
}
