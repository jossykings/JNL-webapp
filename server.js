// -----------------------------------------------------------------------------
// JNL SHOP — Node.js + Express backend.
//
// Data lives in data/db.json (see lib/db.js). Business logic is split into
// services: shipping/tax, orders, payments, invoices, webhooks, audit.
// -----------------------------------------------------------------------------
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { db, save, tx } = require('./lib/db');
const { toCents, dec } = require('./lib/money');
const ship = require('./lib/shipping');
const orders = require('./lib/orders');
const payments = require('./lib/payments');
const invoices = require('./lib/invoices');
const webhooks = require('./lib/webhooks');
const audit = require('./lib/audit');
const sec = require('./lib/security');
const mail = require('./lib/mail');

const { ADMIN_PASSWORD, SITE_URL, CARRIER_WEBHOOK_SECRET } = process.env;
// PORT=0/empty/non-numeric means "any free port", which breaks a fixed site URL and
// the STRIPE redirect origin, so it falls back to 3000 (also covers an ambient PORT=0).
const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
if (!ADMIN_PASSWORD) console.warn('! ADMIN_PASSWORD is not set: admin login is disabled.');
if (!process.env.SECRET) console.warn('! SECRET is not set: logins reset on every restart.');
if (payments.sandboxMode) console.warn('! STRIPE_SECRET_KEY is empty: card payments run in the local SANDBOX (no real charges).');
else if (!payments.PUBLISHABLE_KEY) console.warn('! STRIPE_PUBLISHABLE_KEY is missing: Stripe Elements cannot load.');

// ---------------------------------------------------------------------------
// Auth helpers (HMAC session tokens, scrypt password hashing)
// ---------------------------------------------------------------------------
const mac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const sign = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + mac(b); };
const verify = t => {
  try {
    const [b, s] = String(t).split('.');
    const a = Buffer.from(s), c = Buffer.from(mac(b));
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
    const o = JSON.parse(Buffer.from(b, 'base64url'));
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
};
const hashPw = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 64).toString('hex');
const checkPw = (p, h) => {
  try { const [s, k] = String(h).split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 64)); }
  catch { return false; }
};
const tokenOf = req => (req.headers.authorization || '').replace('Bearer ', '');
const ROLES = { super: ['super'], admin: ['admin', 'super'], customer: ['customer', 'user'], user: ['customer', 'user'] };

const auth = role => (req, res, next) => {
  const o = verify(tokenOf(req));
  if (!o) return res.status(401).json({ error: 'Please sign in' });
  if (o.role === 'customer' || o.role === 'user') {
    const u = db.users.find(x => x.id === o.id);
    // The account may have been removed since the token was issued; such a
    // session must be rejected outright rather than answering 200 with empty
    // per-customer data as if the customer were signed in.
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    // A session is revoked when its token version no longer matches (sign out)
    if (Number(u.tv || 0) !== Number(o.tv || 0)) return res.status(401).json({ error: 'Please sign in' });
    o.role = 'customer'; o.email = u.email; o.name = u.name;
  }
  if (o.id && (o.role === 'admin' || o.role === 'super')) {
    const s = db.staff.find(x => x.id === o.id);
    if (!s) return res.status(401).json({ error: 'Please sign in' });
    o.role = s.role; o.name = s.name;
  }
  if (role && !(ROLES[role] || [role]).includes(o.role)) return res.status(401).json({ error: 'Please sign in' });
  req.u = o;
  next();
};
const optAuth = (req, res, next) => {
  const o = verify(tokenOf(req));
  if (o && (o.role === 'customer' || o.role === 'user')) {
    const u = o.id ? db.users.find(x => x.id === o.id) : null;
    // Same rule as auth(): a removed or revoked account falls back to guest
    // rather than being treated as a signed-in customer.
    if (u && Number(u.tv || 0) === Number(o.tv || 0)) { o.role = 'customer'; o.email = u.email; o.name = u.name; }
    else o.role = '';
  }
  req.u = o;
  next();
};

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(sec.headers);
app.use(sec.sameOrigin);

// ---------------------------------------------------------------------------
// Stripe webhook — raw body, signature verified, processed idempotently
// ---------------------------------------------------------------------------
const rawParser = express.raw({ type: '*/*', limit: '1mb' });
async function stripeWebhook(req, res) {
  if (!payments.webhookSecret()) return res.sendStatus(404);
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const ev = payments.verifySignature(raw, req.headers['stripe-signature'], payments.webhookSecret());
    const out = await tx(() => webhooks.processEvent(ev));
    res.json({ received: true, duplicate: out.duplicate, outcome: out.outcome || null });
  } catch (e) {
    // Never echo the signature or payload back
    res.status(400).json({ error: 'Invalid webhook' });
  }
}
app.post('/api/stripe-webhook', rawParser, stripeWebhook);
app.post('/api/webhooks/stripe', rawParser, stripeWebhook);

// Carrier tracking webhook (optional integration; disabled until a secret is set)
app.post('/api/webhooks/carrier', rawParser, async (req, res) => {
  if (!CARRIER_WEBHOOK_SECRET) return res.sendStatus(404);
  let ev;
  try {
    ev = payments.verifySignature(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''),
      req.headers['x-carrier-signature'], CARRIER_WEBHOOK_SECRET);
  } catch { return res.status(400).json({ error: 'Invalid webhook' }); }
  const id = 'carrier:' + String(ev.id).slice(0, 100);
  if (db.webhookEvents.some(e => e.id === id)) return res.json({ received: true, duplicate: true });
  db.webhookEvents.push({ id, type: 'carrier.' + (ev.status || 'update'), receivedAt: new Date().toISOString(), processed: false });

  const o = db.orders.find(x => x.shipment && x.shipment.trackingNumber && x.shipment.trackingNumber === ev.trackingNumber);
  if (!o) { save(); return json(res, { received: true, matched: false }); }
  o.shipment.events = o.shipment.events || [];
  const exists = o.shipment.events.some(e => e.providerEventId === ev.id);
  if (!exists) {
    o.shipment.events.push({
      at: ev.at || new Date().toISOString(), status: sec.str(ev.status, 40), description: sec.str(ev.description, 200),
      location: sec.str(ev.location, 80), source: 'carrier', providerEventId: String(ev.id).slice(0, 100)
    });
    o.shipment.lastEvent = o.shipment.events[o.shipment.events.length - 1];
  }
  const map = { shipped: 'shipped', in_transit: 'shipped', out_for_delivery: 'out_for_delivery', delivered: 'delivered' };
  const nextStatus = map[String(ev.status || '').toLowerCase()];
  if (nextStatus && orders.canFulfillment(o.fulfillmentStatus, nextStatus)) orders.applyFulfillmentStatus(o, nextStatus, 'carrier', ev.description || '');
  orders.syncLegacy(o);
  webhooks.notify(o, 'Shipment update', `Your order ${o.number} is now ${String(ev.status || 'updated').replace(/_/g, ' ')}.`);
  const rec = db.webhookEvents.find(e => e.id === id);
  if (rec) rec.processed = true;
  save();
  res.json({ received: true, matched: true });
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, setHeaders: (res, p) => {
  // Images and fonts are immutable; HTML/JS/CSS always revalidate so a deploy
  // is picked up immediately (and never serves a stale checkout).
  if (/\.(woff2?|jpe?g|png|webp|svg)$/i.test(p)) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  else res.setHeader('Cache-Control', 'no-cache');
} }));

const json = (res, body, status = 200) => res.status(status).json(body);
const fail = (res, msg, status = 400) => res.status(status).json({ error: msg });

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------
const rlAuth = sec.rateLimit({ name: 'auth', windowMs: 60_000, max: 12 });
const rlRegister = sec.rateLimit({ name: 'register', windowMs: 60_000, max: 8 });
const rlQuote = sec.rateLimit({ name: 'quote', windowMs: 60_000, max: 90 });
const rlCheckout = sec.rateLimit({ name: 'checkout', windowMs: 60_000, max: 15 });
const rlPay = sec.rateLimit({ name: 'pay', windowMs: 60_000, max: 25 });
const rlPublicForm = sec.rateLimit({ name: 'form', windowMs: 60_000, max: 20 });

// ---------------------------------------------------------------------------
// Public site + legacy forms
// ---------------------------------------------------------------------------
app.get('/api/site', (req, res) => json(res, {
  c: {
    ...db.settings,
    card: payments.enabled,
    freeShippingOverCents: db.settings.shipping.freeOverCents
  },
  products: db.products.filter(p => p.active !== false),
  projects: db.projects,
  provinces: ship.PROVINCES,
  payment: { mode: payments.MODE, sandbox: payments.sandboxMode, enabled: payments.enabled }
}));

app.post('/api/track', (req, res) => {
  const p = sec.str(req.body.path, 40);
  if (p && /^[\w/-]+$/.test(p) && (db.views[p] || Object.keys(db.views).length < 200)) {
    db.views[p] = (db.views[p] || 0) + 1; save();
  }
  res.json({ ok: 1 });
});

app.post('/api/messages', rlPublicForm, (req, res) => {
  const b = req.body;
  if (b.website) return json(res, { ok: 1 });
  if (!b.name || !b.email || !b.body) return fail(res, 'Name, email and message are required');
  if (!sec.isEmail(b.email)) return fail(res, 'Enter a valid email address');
  db.messages.push({ id: crypto.randomBytes(6).toString('hex'), date: new Date().toISOString(),
    name: sec.str(b.name, 100), email: sec.str(b.email, 150), body: sec.str(b.body) });
  save(); json(res, { ok: 1 });
});

app.post('/api/quotes', rlPublicForm, (req, res) => {
  const b = req.body;
  if (b.website) return json(res, { ok: 1 });
  if (!b.name || !(b.email || b.phone) || !b.details) return fail(res, 'Name, a contact and project details are required');
  db.quotes.push({ id: crypto.randomBytes(6).toString('hex'), date: new Date().toISOString(),
    name: sec.str(b.name, 100), email: sec.str(b.email, 150), phone: sec.str(b.phone, 40),
    service: sec.str(b.service, 80), details: sec.str(b.details), status: 'new' });
  save(); json(res, { ok: 1 });
});

// ---------------------------------------------------------------------------
// Customer accounts
// ---------------------------------------------------------------------------
const userOut = u => ({ id: u.id, name: u.name, email: u.email, role: 'customer', hasSavedCards: (u.paymentMethods || []).length });
const userTok = u => sign({ role: 'customer', id: u.id, tv: Number(u.tv || 0), exp: Date.now() + 30 * 864e5 });

app.post('/api/auth/register', rlRegister, async (req, res) => {
  const name = sec.str(req.body.name, 100), email = sec.str(req.body.email, 150).toLowerCase(), pw = String(req.body.password || '');
  if (!name || !sec.isEmail(email) || pw.length < 8) return fail(res, 'Name, valid email and a password of 8+ characters are required');
  if (db.users.find(u => u.email === email) || db.staff.find(s => s.email === email)) return fail(res, 'That email is already registered');
  const u = { id: crypto.randomBytes(6).toString('hex'), name, email, pw: hashPw(pw.slice(0, 200)), role: 'customer', date: new Date().toISOString(), paymentMethods: [], addresses: [], notifications: [], tv: 0 };
  db.users.push(u); save();
  json(res, { token: userTok(u), user: userOut(u) });
});

app.post('/api/auth/login', rlAuth, (req, res) => {
  const email = sec.str(req.body.email, 150).toLowerCase();
  const u = db.users.find(x => x.email === email);
  if (!u || !checkPw(String(req.body.password || '').slice(0, 200), u.pw)) return fail(res, 'Wrong email or password', 401);
  json(res, { token: userTok(u), user: userOut(u) });
});

app.get('/api/auth/me', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  json(res, { user: { ...userOut(u), created: u.date } });
});

app.post('/api/auth/logout', auth(), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (u) { u.tv = Number(u.tv || 0) + 1; save(); }
  json(res, { ok: 1 });
});

app.post('/api/auth/password', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  const cur = String(req.body.currentPassword || ''), next = String(req.body.newPassword || '');
  if (!checkPw(cur, u.pw)) return fail(res, 'Current password is incorrect', 401);
  if (next.length < 8) return fail(res, 'New password must be at least 8 characters');
  u.pw = hashPw(next.slice(0, 200)); u.tv = Number(u.tv || 0) + 1; save();
  audit.log({ actor: u.email, actorId: u.id, role: 'customer', action: 'account.password_changed', target: 'user', targetId: u.id, ip: sec.ipOf(req) });
  json(res, { ok: 1 });
});

app.post('/api/auth/reset-request', rlAuth, (req, res) => {
  if (!mail.configured()) return fail(res, 'Password reset email is not configured on this shop yet. Please contact us.', 503);
  const email = sec.str(req.body.email, 150).toLowerCase();
  const u = db.users.find(x => x.email === email);
  if (u) {
    const token = crypto.randomBytes(24).toString('hex');
    u.reset = { hash: crypto.createHash('sha256').update(token).digest('hex'), exp: Date.now() + 30 * 60_000 };
    save();
    mail.send(u.email, 'Reset your password', `Use this code within 30 minutes: ${token}`);
  }
  json(res, { ok: 1 }); // never reveal whether the address exists
});

// ---------------------------------------------------------------------------
// Cart (database backed for signed-in customers, localStorage for guests)
// ---------------------------------------------------------------------------
const cartOf = u => db.carts.find(c => c.userId === u.id);

function cleanCartItems(items) {
  const out = [], seen = new Set();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 100)) {
    const id = sec.str(it && it.id, 40);
    if (!id || seen.has(id) || !db.products.find(p => p.id === id && p.active !== false)) continue;
    seen.add(id);
    const qty = sec.int(it.qty, 1, 99, 1);
    out.push({ id, qty });
  }
  return out;
}

app.get('/api/cart', auth('customer'), (req, res) => {
  const c = cartOf(req.u);
  json(res, { items: c ? c.items : [], updated: c ? c.updated : null });
});

app.put('/api/cart', auth('customer'), (req, res) => {
  const items = cleanCartItems(req.body.items);
  const c = cartOf(req.u);
  if (c) { c.items = items; c.updated = new Date().toISOString(); }
  else db.carts.push({ userId: req.u.id, items, updated: new Date().toISOString() });
  save();
  json(res, { items });
});

// Guest cart is merged (not replaced) when a customer signs in or registers.
app.post('/api/cart/merge', auth('customer'), (req, res) => {
  const incoming = cleanCartItems(req.body.items);
  const c = cartOf(req.u);
  const merged = new Map((c ? c.items : []).map(i => [i.id, i.qty]));
  for (const i of incoming) merged.set(i.id, Math.min(99, (merged.get(i.id) || 0) + i.qty));
  const items = [...merged].map(([id, qty]) => ({ id, qty }));
  if (c) { c.items = items; c.updated = new Date().toISOString(); }
  else db.carts.push({ userId: req.u.id, items, updated: new Date().toISOString() });
  save();
  json(res, { items });
});

app.delete('/api/cart', auth('customer'), (req, res) => {
  const c = cartOf(req.u);
  if (c) { c.items = []; c.updated = new Date().toISOString(); save(); }
  json(res, { items: [] });
});

// ---------------------------------------------------------------------------
// Checkout: quote, create order + PaymentIntent, reconcile, sandbox confirm
// ---------------------------------------------------------------------------
const checkoutConfig = () => ({
  mode: payments.MODE,
  sandbox: payments.sandboxMode,
  publishableKey: payments.MODE === 'stripe' ? payments.PUBLISHABLE_KEY : '',
  enabled: payments.enabled,
  currency: db.settings.currencyCode || 'cad',
  freeShippingOverCents: db.settings.shipping.freeOverCents,
  shippingMethods: (db.settings.shipping.methods || []).map(m => ({ id: m.id, label: m.label, days: m.days })),
  provinces: ship.PROVINCES
});

app.get('/api/checkout/config', optAuth, (req, res) => {
  const out = checkoutConfig();
  if (req.u && req.u.role === 'customer' && req.u.id) {
    const u = db.users.find(x => x.id === req.u.id);
    if (u) {
      out.savedCards = (u.paymentMethods || []).map(p => ({ id: p.id, brand: p.brand, last4: p.last4, expMonth: p.expMonth, expYear: p.expYear, isDefault: p.id === u.defaultPaymentMethodId || p.isDefault, sandbox: !!p.sandbox }));
      out.contact = { name: u.name, email: u.email, phone: u.phone || '' };
    }
  }
  json(res, out);
});

function quoteBody(b) {
  return {
    items: b.items,
    postalCode: sec.str(b.postalCode, 10),
    province: sec.str(b.province, 2).toUpperCase(),
    method: sec.str(b.shippingMethod, 30) || 'standard',
    discountCode: sec.str(b.discountCode, 40),
    contact: { name: sec.str(b.name, 100), email: sec.str(b.email, 150), phone: sec.str(b.phone, 40) }
  };
}

app.post('/api/checkout/quote', rlQuote, (req, res) => {
  const q = orders.quote(quoteBody(req.body || {}));
  json(res, {
    ok: q.ok, subtotalCents: q.subtotalCents, discountCents: q.discountCents, discountCode: q.discountCode,
    shippingCents: q.shippingCents, shippingMethods: q.shippingMethods, shippingMethod: q.shippingMethod,
    shippingLabel: q.shippingLabel, taxCents: q.taxCents, taxLabel: q.taxLabel, taxRate: q.taxRate,
    taxLines: q.taxLines, totalCents: q.totalCents, currency: q.currency, lines: q.lines,
    freeShipping: q.freeShipping, zone: q.zone, postalCode: q.postalCode, province: q.province,
    serviceable: q.serviceable !== false, addressReady: !!q.addressReady,
    issues: q.issues, error: q.error
  });
});

// Reusable server-side validation of the delivery address + contact details
function checkoutAddress(b) {
  const a = {
    street: sec.str(b.street, 200),
    city: sec.str(b.city, 100),
    province: sec.str(b.province, 2).toUpperCase(),
    postalCode: ship.normalizePostal(b.postalCode),
    country: 'CA'
  };
  const contact = { name: sec.str(b.name, 100), email: sec.str(b.email, 150).toLowerCase(), phone: sec.str(b.phone, 40) };
  const errors = [];
  if (!contact.name) errors.push('Enter the recipient name.');
  if (!sec.isEmail(contact.email)) errors.push('Enter a valid email address.');
  if (!/^[+()0-9 \-.]{7,20}$/.test(contact.phone)) errors.push('Enter a valid phone number.');
  if (a.street.length < 4) errors.push('Enter the street address.');
  if (a.city.length < 2) errors.push('Enter the city or town.');
  const dest = ship.checkDestination({ postalCode: a.postalCode, province: a.province });
  if (!dest.ok) errors.push(dest.reason);
  else { a.postalCode = dest.postalCode; a.province = dest.province; }
  return { address: a, contact, errors };
}

const orderIsMine = (o, u) => !!o && !!u && o.userId && o.userId === u.id;

app.post('/api/checkout', rlCheckout, auth('customer'), async (req, res) => {
  const b = req.body || {};
  const idem = sec.str(req.headers['idempotency-key'] || b.idempotencyKey, 100);
  if (!idem) return fail(res, 'Missing Idempotency-Key header', 400);
  const method = sec.oneOf(b.paymentMethod, ['card', 'cod', 'bank'], 'card');
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);

  // Replay protection: the same key always returns the same order
  const prior = db.orders.find(o => o.userId === u.id && o.idempotencyKey === idem);
  if (prior) return json(res, { order: orders.publicOrder(prior), clientSecret: prior.providerClientSecret || '', replayed: true, mode: payments.MODE });

  const { address, contact, errors: addrErrors } = checkoutAddress(b);
  if (addrErrors.length) return fail(res, addrErrors[0], 422);

  const q = orders.quote({ items: b.items, postalCode: address.postalCode, province: address.province, method: sec.str(b.shippingMethod, 30) || 'standard', discountCode: sec.str(b.discountCode, 40) });
  if (q.issues.length) return json(res, { error: q.issues[0], issues: q.issues }, 422);
  if (!q.addressReady) return fail(res, q.error || 'Delivery address incomplete', 422);
  if (!q.serviceable) return fail(res, q.error || 'We do not deliver to that address', 422);
  if (!q.lines.length) return fail(res, 'Your cart is empty', 422);

  let created;
  try {
    created = await tx(() => {
      const dup = db.orders.find(o => o.userId === u.id && o.idempotencyKey === idem);
      if (dup) return { order: dup, replayed: true };
      const order = orders.makeOrder({ quote: q, user: u, contact, address, method });
      order.idempotencyKey = idem;
      order.savedCard = sec.bool(b.saveCard);
      order.providerCustomerId = u.stripeCustomerId || '';
      orders.reserveStock(q.lines);
      if (q.discount) { const d = db.discounts.find(x => x.code === q.discountCode); if (d) d.used = (d.used || 0) + 1; }
      db.orders.push(order);
      const c = cartOf(u); if (c) { c.items = []; c.updated = new Date().toISOString(); }
      return { order, replayed: false };
    });
  } catch (e) {
    return fail(res, 'Could not create the order. Please try again.', 500);
  }
  const order = created.order;
  if (created.replayed) return json(res, { order: orders.publicOrder(order), clientSecret: order.providerClientSecret || '', replayed: true, mode: payments.MODE });

  // Payment setup happens outside the write lock (network / provider)
  try {
    if (method === 'card') {
      if (!payments.enabled) throw new Error('Card payments are not available yet');
      if (!u.stripeCustomerId) {
        const c = await payments.provider.createCustomer({ email: u.email, name: u.name, userId: u.id });
        await tx(() => { u.stripeCustomerId = c.id; order.providerCustomerId = c.id; });
      }
      let pmId = '';
      if (b.savedPaymentMethodId) {
        const saved = (u.paymentMethods || []).find(p => p.id === b.savedPaymentMethodId);
        if (!saved) throw new Error('That saved card does not belong to your account');
        pmId = saved.id;
      }
      const pi = await payments.provider.createIntent({
        amountCents: order.totalCents,
        currency: order.currency,
        customerId: order.providerCustomerId || u.stripeCustomerId || '',
        metadata: { orderId: order.id, orderNumber: order.number, userId: u.id, saveCard: String(!!b.saveCard) },
        saveCard: sec.bool(b.saveCard),
        paymentMethodId: pmId,
        receiptEmail: contact.email,
        description: `Order ${order.number}`,
        idempotencyKey: 'pi_' + order.id
      });
      await tx(() => {
        order.paymentIntentId = pi.id;
        order.providerClientSecret = pi.clientSecret || '';
        order.paymentMethodId = pmId || '';
        db.payments.push({ id: crypto.randomBytes(6).toString('hex'), orderId: order.id, provider: payments.MODE, intentId: pi.id,
          amountCents: order.totalCents, currency: order.currency, status: pi.status || 'requires_payment_method',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      });
      if (pi.status === 'succeeded') {
        await tx(() => webhooks.processEvent({ id: 'evt_reconcile_' + pi.id + '_succeeded', type: 'payment_intent.succeeded',
          data: { object: { id: pi.id, status: 'succeeded', amount: order.totalCents, metadata: { orderId: order.id } } } }));
      }
    } else {
      // Pay on delivery / bank transfer: unpaid until an admin confirms settlement
      await tx(() => orders.addEvent(order, { type: 'payment_deferred', label: method === 'bank' ? 'Bank transfer selected' : 'Pay on delivery selected' }));
    }
  } catch (e) {
    await tx(() => {
      orders.applyPaymentStatus(order, 'failed', 'checkout', 'Could not start the payment');
      orders.releaseStock(order.lines.map(l => ({ id: l.id, qty: l.qty })));
      orders.applyFulfillmentStatus(order, 'cancelled', 'checkout', 'Payment could not be started');
    });
    return fail(res, e.message || 'Could not start the payment', 502);
  }

  json(res, { order: orders.publicOrder(order), clientSecret: order.providerClientSecret || '', mode: payments.MODE, publishableKey: checkoutConfig().publishableKey });
});

// Server-to-server reconciliation: never trusts a browser "success" redirect
app.post('/api/checkout/:id/sync', rlPay, auth('customer'), async (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!orderIsMine(order, req.u)) return fail(res, 'Order not found', 404);
  if (!order.paymentIntentId) return json(res, { order: orders.publicOrder(order) });
  try {
    const pi = await payments.provider.retrieveIntent(order.paymentIntentId);
    if (pi.status === 'succeeded' && order.paymentStatus !== 'paid') {
      await tx(() => webhooks.processEvent({ id: 'evt_reconcile_' + pi.id + '_succeeded', type: 'payment_intent.succeeded',
        data: { object: { id: pi.id, status: 'succeeded', amount: pi.amountCents, metadata: { orderId: order.id }, payment_method: pi.paymentMethodId } } }));
    } else if (pi.status === 'processing' && orders.canPayment(order.paymentStatus, 'processing')) {
      await tx(() => { orders.applyPaymentStatus(order, 'processing', 'reconcile', 'Provider is processing'); orders.providerStatus = pi.status; });
    } else if (['requires_payment_method', 'canceled'].includes(pi.status) && order.paymentStatus === 'failed') {
      order.lastPaymentError = pi.lastError || order.lastPaymentError;
      save();
    }
  } catch { /* provider hiccup: the webhook will settle it */ }
  const fresh = db.orders.find(o => o.id === order.id);
  json(res, { order: orders.publicOrder(fresh) });
});

app.post('/api/checkout/:id/cancel', rlPay, auth('customer'), async (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!orderIsMine(order, req.u)) return fail(res, 'Order not found', 404);
  if (['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) return fail(res, 'A paid order cannot be cancelled here. Please contact support.', 409);
  try { if (order.paymentIntentId) await payments.provider.cancelIntent(order.paymentIntentId); } catch { /* already settled */ }
  await tx(() => {
    if (orders.canPayment(order.paymentStatus, 'cancelled')) orders.applyPaymentStatus(order, 'cancelled', 'customer', 'Cancelled before payment');
    if (orders.canFulfillment(order.fulfillmentStatus, 'cancelled')) orders.applyFulfillmentStatus(order, 'cancelled', 'customer', 'Cancelled before payment');
    orders.releaseStock(order.lines.map(l => ({ id: l.id, qty: l.qty })));
  });
  json(res, { order: orders.publicOrder(order) });
});

// Sandbox-only provider confirmation (no card data, no real charge)
app.post('/api/payments/sandbox/confirm', rlPay, auth('customer'), async (req, res) => {
  if (!payments.sandboxMode) return fail(res, 'Not available', 404);
  const intentId = sec.str(req.body.paymentIntentId, 100);
  const order = intentId
    ? db.orders.find(o => o.paymentIntentId === intentId)
    : db.orders.find(o => o.id === sec.str(req.body.orderId, 60));
  if (!order) return fail(res, 'Payment not found', 404);
  if (!orderIsMine(order, req.u)) return fail(res, 'Payment not found', 404);
  if (!order.paymentIntentId) return fail(res, 'This order has no card payment to confirm', 409);
  if (order.paymentStatus === 'paid') return json(res, { order: orders.publicOrder(order), duplicate: true });
  const outcome = sec.oneOf(req.body.outcome, ['succeed', 'fail', 'auth', 'cancel'], 'succeed');
  try {
    const { event, duplicate } = await payments.sandboxConfirm(intentId || order.paymentIntentId, outcome);
    if (event) await tx(() => webhooks.processEvent(event));
    json(res, { order: orders.publicOrder(db.orders.find(o => o.id === order.id)), duplicate: !!duplicate, outcome });
  } catch (e) { fail(res, e.message || 'Sandbox payment failed', 400); }
});

// Retry an unpaid order with a fresh PaymentIntent (same order, no duplicate)
app.post('/api/checkout/:id/retry', rlPay, auth('customer'), async (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!orderIsMine(order, req.u)) return fail(res, 'Order not found', 404);
  if (!['requires_payment', 'failed', 'processing'].includes(order.paymentStatus)) return fail(res, 'This order does not need another payment', 409);
  if (order.method !== 'card') return fail(res, 'This order is not paid by card', 409);
  if (!payments.enabled) return fail(res, 'Card payments are not configured', 503);
  const u = db.users.find(x => x.id === req.u.id);
  try {
    const customerId = await ensureProviderCustomer(u);
    const attempt = (order.paymentAttempts || 0) + 1;
    const pi = await payments.provider.createIntent({
      amountCents: order.totalCents, currency: order.currency, customerId,
      metadata: { orderId: order.id, orderNumber: order.number, userId: u.id },
      receiptEmail: order.customer?.email, description: `Order ${order.number} (attempt ${attempt})`,
      idempotencyKey: `pi_retry_${order.id}_${attempt}`
    });
    await tx(() => {
      order.paymentAttempts = attempt;
      order.paymentIntentId = pi.id;
      order.providerClientSecret = pi.clientSecret || '';
      if (orders.canPayment(order.paymentStatus, 'requires_payment')) orders.applyPaymentStatus(order, 'requires_payment', 'customer', 'New payment attempt');
      db.payments.push({ id: crypto.randomBytes(6).toString('hex'), orderId: order.id, provider: payments.MODE, intentId: pi.id,
        amountCents: order.totalCents, currency: order.currency, status: pi.status || 'requires_payment_method', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    json(res, { clientSecret: pi.clientSecret || '', mode: payments.MODE, publishableKey: checkoutConfig().publishableKey });
  } catch { fail(res, 'Could not start a new payment attempt', 502); }
});

// ---------------------------------------------------------------------------
// Saved payment methods (Stripe SetupIntents; safe metadata only)
// ---------------------------------------------------------------------------
const safeCard = (p, u) => ({ id: p.id, brand: p.brand, last4: p.last4, expMonth: p.expMonth, expYear: p.expYear, isDefault: p.id === u.defaultPaymentMethodId || !!p.isDefault, sandbox: !!p.sandbox });

app.get('/api/payments/methods', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  json(res, { methods: (u.paymentMethods || []).map(p => safeCard(p, u)), mode: payments.MODE, enabled: payments.enabled });
});

async function ensureProviderCustomer(u) {
  if (u.stripeCustomerId) return u.stripeCustomerId;
  const c = await payments.provider.createCustomer({ email: u.email, name: u.name, userId: u.id });
  await tx(() => { u.stripeCustomerId = c.id; });
  return c.id;
}

app.post('/api/payments/methods/setup-intent', rlPay, auth('customer'), async (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  if (!payments.enabled) return fail(res, 'Card payments are not configured', 503);
  try {
    const customerId = await ensureProviderCustomer(u);
    const si = await payments.provider.createSetupIntent({ customerId, metadata: { userId: u.id } });
    json(res, { clientSecret: si.clientSecret, setupIntentId: si.id || '', publishableKey: checkoutConfig().publishableKey, mode: payments.MODE });
  } catch { fail(res, 'Could not start card setup', 502); }
});

// Sandbox-only: finish a saved-card setup without any card data
app.post('/api/payments/sandbox/setup', rlPay, auth('customer'), (req, res) => {
  if (!payments.sandboxMode) return fail(res, 'Not available', 404);
  const u = db.users.find(x => x.id === req.u.id);
  const si = (db.setupIntents || []).find(x => x.id === sec.str(req.body.setupIntentId, 100) && x.customerId === (u && u.stripeCustomerId));
  if (!si) return fail(res, 'Setup session not found', 404);
  si.status = 'succeeded';
  const pmId = 'pm_sbx_' + crypto.randomBytes(8).toString('hex');
  save();
  json(res, { paymentMethodId: pmId, sandbox: true });
});

app.post('/api/payments/methods', rlPay, auth('customer'), async (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  const pmId = sec.str(req.body.paymentMethodId, 100);
  if (!pmId) return fail(res, 'A payment method is required');
  if ((u.paymentMethods || []).length >= 10) return fail(res, 'You can save up to 10 cards');
  try {
    const customerId = await ensureProviderCustomer(u);
    const meta = await payments.provider.attachPaymentMethod(customerId, pmId);
    const card = { id: meta.id || pmId, brand: meta.brand || 'card', last4: meta.last4 || '', expMonth: meta.expMonth || 0, expYear: meta.expYear || 0, sandbox: payments.sandboxMode, created: new Date().toISOString() };
    await tx(() => {
      u.paymentMethods = (u.paymentMethods || []).filter(p => p.id !== card.id);
      card.isDefault = u.paymentMethods.length === 0;
      u.paymentMethods.push(card);
      if (!u.defaultPaymentMethodId) u.defaultPaymentMethodId = card.id;
    });
    audit.log({ actor: u.email, actorId: u.id, role: 'customer', action: 'card.saved', target: 'user', targetId: u.id, meta: { card: card.brand, last4: card.last4 } });
    json(res, { methods: u.paymentMethods.map(p => safeCard(p, u)) });
  } catch (e) { fail(res, 'That card could not be saved. Please try again.', 502); }
});

app.post('/api/payments/methods/:id/default', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u || !(u.paymentMethods || []).some(p => p.id === req.params.id)) return fail(res, 'Card not found', 404);
  u.defaultPaymentMethodId = req.params.id;
  u.paymentMethods.forEach(p => { p.isDefault = p.id === req.params.id; });
  save();
  json(res, { methods: u.paymentMethods.map(p => safeCard(p, u)) });
});

app.delete('/api/payments/methods/:id', auth('customer'), async (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u || !(u.paymentMethods || []).some(p => p.id === req.params.id)) return fail(res, 'Card not found', 404);
  try { await payments.provider.detachPaymentMethod(req.params.id); } catch { /* already gone at the provider */ }
  await tx(() => {
    u.paymentMethods = u.paymentMethods.filter(p => p.id !== req.params.id);
    if (u.defaultPaymentMethodId === req.params.id) u.defaultPaymentMethodId = u.paymentMethods[0]?.id || '';
    u.paymentMethods.forEach(p => { p.isDefault = p.id === u.defaultPaymentMethodId; });
  });
  audit.log({ actor: u.email, actorId: u.id, role: 'customer', action: 'card.removed', target: 'user', targetId: u.id });
  json(res, { methods: u.paymentMethods.map(p => safeCard(p, u)) });
});

// ---------------------------------------------------------------------------
// Customer orders, tracking, invoices, notifications
// ---------------------------------------------------------------------------
app.get('/api/me/orders', auth('customer'), (req, res) => {
  json(res, db.orders.filter(o => o.userId === req.u.id).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(orders.publicOrder));
});

app.get('/api/orders/:id', auth('customer'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!orderIsMine(o, req.u)) return fail(res, 'Order not found', 404);
  json(res, orders.publicOrder(o));
});

app.get('/api/invoices', auth('customer'), (req, res) => {
  json(res, db.invoices.filter(i => i.userId === req.u.id).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .map(i => ({ id: i.id, number: i.number, type: i.type, date: i.date, orderNumber: i.orderNumber, totalCents: i.totalCents, currency: i.currency, paymentStatus: i.paymentStatus })));
});

function sendInvoice(res, inv, actor) {
  const file = invoices.invoicePath(inv);
  if (!require('fs').existsSync(file)) return fail(res, 'Invoice file missing', 404);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(file)}"`);
  require('fs').createReadStream(file).pipe(res);
  if (actor) audit.log(actor);
}

app.get('/api/invoices/:id/pdf', auth('customer'), (req, res) => {
  const inv = db.invoices.find(i => i.id === req.params.id);
  // Ownership check before anything is read from disk
  if (!inv || inv.userId !== req.u.id) return fail(res, 'Invoice not found', 404);
  sendInvoice(res, inv);
});

app.get('/api/me/notifications', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  json(res, { notifications: u.notifications || [], unread: (u.notifications || []).filter(n => !n.read).length });
});

app.post('/api/me/notifications/read', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (u) { (u.notifications || []).forEach(n => { n.read = true; }); save(); }
  json(res, { ok: 1 });
});

app.patch('/api/me/profile', auth('customer'), (req, res) => {
  const u = db.users.find(x => x.id === req.u.id);
  if (!u) return fail(res, 'Please sign in', 401);
  if (req.body.name) u.name = sec.str(req.body.name, 100);
  if (req.body.phone !== undefined) u.phone = sec.str(req.body.phone, 40);
  save();
  json(res, { user: userOut(u) });
});

// ---------------------------------------------------------------------------
// Legacy order endpoint (kept for existing clients): server-priced, no tax
// ---------------------------------------------------------------------------
app.post('/api/orders', optAuth, rlQuote, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.phone || !Array.isArray(b.items) || !b.items.length) return fail(res, 'Name, phone and items are required');
  const priced = orders.priceLines(b.items);
  if (!priced.lines.length) return fail(res, 'No valid items');
  const subtotalCents = priced.lines.reduce((a, l) => a + l.unitCents * l.qty, 0);
  const q = {
    lines: priced.lines, subtotalCents, discountCents: 0, discountCode: '', shippingCents: 0,
    shippingMethod: 'legacy', shippingLabel: '', taxCents: 0, taxLabel: '', taxRate: 0, taxLines: [],
    totalCents: subtotalCents, currency: (db.settings.currencyCode || 'cad').toLowerCase()
  };
  const order = await tx(() => {
    const o = orders.makeOrder({
      quote: q,
      user: req.u && req.u.role === 'customer' ? { id: req.u.id } : null,
      contact: { name: b.name, phone: b.phone, email: b.email },
      address: { street: b.address, city: '', province: '', postalCode: '' },
      method: sec.oneOf(b.method, ['cod', 'bank', 'card'], 'cod'),
      channel: 'legacy'
    });
    orders.reserveStock(priced.lines);
    db.orders.push(o);
    return o;
  });
  json(res, { ok: 1, id: order.id, number: order.number });
});

// ---------------------------------------------------------------------------
// Admin auth + shared dashboard data
// ---------------------------------------------------------------------------
const tries = {};
const staffOut = s => ({ id: s.id, name: s.name, email: s.email, role: s.role });

app.post('/api/admin/login', (req, res) => {
  const t = tries[req.ip] = (tries[req.ip] || []).filter(x => Date.now() - x < 9e5);
  if (t.length >= 8) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  t.push(Date.now());
  const pw = String(req.body.password || '').slice(0, 200);
  const email = sec.str(req.body.email, 150).toLowerCase();
  if (email) {
    const s = db.staff.find(x => x.email === email);
    if (!s || !checkPw(pw, s.pw)) return fail(res, 'Wrong email or password', 401);
    tries[req.ip] = [];
    return json(res, { token: sign({ role: s.role, id: s.id, name: s.name, exp: Date.now() + 864e5 }), role: s.role, name: s.name });
  }
  const a = Buffer.from(pw), b = Buffer.from(ADMIN_PASSWORD || '');
  const ok = !!ADMIN_PASSWORD && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return fail(res, 'Wrong password', 401);
  tries[req.ip] = [];
  json(res, { token: sign({ role: 'super', exp: Date.now() + 864e5 }), role: 'super', name: 'Super admin' });
});

const A = auth('admin');
const AS = auth('super');
const customerOut = u => {
  const os = db.orders.filter(o => o.userId === u.id || (u.email && o.email && String(o.email).toLowerCase() === u.email));
  return { id: u.id, name: u.name, email: u.email, date: u.date || '', status: 'active',
    orders: os.length, spent: Math.round(os.reduce((a, o) => a + (+o.total || 0), 0) * 100) / 100 };
};

app.get('/api/admin/data', A, (req, res) => json(res, {
  role: req.u.role,
  orders: [...db.orders].reverse(),
  quotes: [...db.quotes].reverse(),
  messages: [...db.messages].reverse(),
  views: db.views,
  users: db.users.length,
  staff: db.staff.map(staffOut),
  metrics: {
    awaitingPayment: db.orders.filter(o => o.paymentStatus === 'requires_payment').length,
    failedPayments: db.orders.filter(o => o.paymentStatus === 'failed').length,
    toFulfill: db.orders.filter(o => ['paid', 'partially_refunded'].includes(o.paymentStatus) && ['unfulfilled', 'processing'].includes(o.fulfillmentStatus)).length,
    refunds: db.orders.filter(o => (o.refunds || []).length).length,
    invoices: db.invoices.length
  },
  paymentMode: payments.MODE,
  ...(req.u.role === 'super' ? { customers: db.users.map(customerOut) } : {})
}));

// ---------------------------------------------------------------------------
// Staff (super only)
// ---------------------------------------------------------------------------
const superCount = () => db.staff.filter(x => x.role === 'super').length + (ADMIN_PASSWORD ? 1 : 0);
app.get('/api/admin/staff', AS, (req, res) => json(res, db.staff.map(staffOut)));
app.post('/api/admin/staff', AS, (req, res) => {
  const b = req.body; const e = sec.str(b.email, 150).toLowerCase();
  if (!b.name || !sec.isEmail(e) || String(b.password || '').length < 8) return fail(res, 'Name, valid email and a password of 8+ characters are required');
  if (db.staff.find(x => x.email === e) || db.users.find(x => x.email === e)) return fail(res, 'That email is already registered');
  const s = { id: crypto.randomBytes(6).toString('hex'), name: sec.str(b.name, 100), email: e, pw: hashPw(String(b.password).slice(0, 200)), role: b.role === 'super' ? 'super' : 'admin' };
  db.staff.push(s); save();
  audit.log({ actor: req.u.name || 'super', actorId: req.u.id, role: req.u.role, action: 'staff.created', target: 'staff', targetId: s.id, meta: { email: e, role: s.role }, ip: sec.ipOf(req) });
  json(res, staffOut(s));
});
app.patch('/api/admin/staff/:id', AS, (req, res) => {
  const s = db.staff.find(x => x.id === req.params.id); if (!s) return res.sendStatus(404);
  const role = req.body.role;
  if (role !== 'admin' && role !== 'super') return fail(res, 'Role must be admin or super');
  if (s.role === 'super' && role === 'admin' && superCount() <= 1) return fail(res, 'At least one super admin must remain');
  const before = s.role; s.role = role; save();
  audit.log({ actor: req.u.name || 'super', actorId: req.u.id, role: req.u.role, action: 'staff.role_changed', target: 'staff', targetId: s.id, meta: { before, after: role }, ip: sec.ipOf(req) });
  json(res, staffOut(s));
});
app.delete('/api/admin/staff/:id', AS, (req, res) => {
  const s = db.staff.find(x => x.id === req.params.id); if (!s) return res.sendStatus(404);
  if (s.role === 'super' && superCount() <= 1) return fail(res, 'At least one super admin must remain');
  db.staff = db.staff.filter(x => x.id !== s.id); save();
  audit.log({ actor: req.u.name || 'super', actorId: req.u.id, role: req.u.role, action: 'staff.removed', target: 'staff', targetId: s.id, meta: { email: s.email }, ip: sec.ipOf(req) });
  json(res, { ok: 1 });
});
app.get('/api/admin/customers', AS, (req, res) => json(res, db.users.map(customerOut)));

// ---------------------------------------------------------------------------
// Admin: orders / payments / refunds / invoices / audit
// ---------------------------------------------------------------------------
const orderFilters = q => {
  let list = [...db.orders];
  const term = sec.str(q.q, 80).toLowerCase();
  if (term) list = list.filter(o => [o.number, o.id, o.customer?.name, o.customer?.email, o.email, o.phone].filter(Boolean).join(' ').toLowerCase().includes(term));
  if (q.paymentStatus) list = list.filter(o => o.paymentStatus === q.paymentStatus);
  if (q.fulfillmentStatus) list = list.filter(o => o.fulfillmentStatus === q.fulfillmentStatus);
  if (q.refundStatus === 'any') list = list.filter(o => (o.refunds || []).length);
  if (q.refundStatus === 'full') list = list.filter(o => o.paymentStatus === 'refunded');
  if (q.refundStatus === 'partial') list = list.filter(o => o.paymentStatus === 'partially_refunded');
  const from = q.from ? Date.parse(q.from.length === 10 ? q.from + 'T00:00:00' : q.from) : null;
  const to = q.to ? Date.parse(q.to.length === 10 ? q.to + 'T23:59:59' : q.to) : null;
  if (Number.isFinite(from)) list = list.filter(o => Date.parse(o.date) >= from);
  if (Number.isFinite(to)) list = list.filter(o => Date.parse(o.date) <= to);
  return list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
};

const adminOrderRow = o => ({
  id: o.id, number: o.number, date: o.date, updatedAt: o.updatedAt,
  customer: o.customer && (o.customer.name || o.customer.email)
    ? o.customer
    : { name: o.name || '', email: o.email || '', phone: o.phone || '' },
  totalCents: o.totalCents, currency: o.currency,
  paymentStatus: o.paymentStatus, fulfillmentStatus: o.fulfillmentStatus,
  refundedCents: o.refundedCents || 0, invoiceId: o.invoiceId || '',
  method: o.method, items: (o.items || []).length,
  shipment: o.shipment ? { carrier: o.shipment.carrier, trackingNumber: o.shipment.trackingNumber, trackingUrl: o.shipment.trackingUrl } : null,
  lastPaymentError: o.lastPaymentError || ''
});

app.get('/api/admin/orders', A, (req, res) => {
  const list = orderFilters(req.query);
  const limit = sec.int(req.query.limit, 1, 500, 100);
  const offset = sec.int(req.query.offset, 0, 1e6, 0);
  json(res, { total: list.length, orders: list.slice(offset, offset + limit).map(adminOrderRow) });
});

app.get('/api/admin/orders.csv', A, (req, res) => {
  const list = orderFilters(req.query);
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Order number', 'Date', 'Customer', 'Email', 'Phone', 'Payment status', 'Fulfillment status', 'Subtotal', 'Discount', 'Shipping', 'Tax', 'Total', 'Currency', 'Refunded', 'Payment intent', 'Invoice'];
  const rows = list.map(o => [o.number, o.date, o.customer?.name, o.customer?.email, o.customer?.phone,
    o.paymentStatus, o.fulfillmentStatus, dec(o.subtotalCents), dec(o.discountCents), dec(o.shippingCents), dec(o.taxCents),
    dec(o.totalCents), String(o.currency).toUpperCase(), dec(o.refundedCents || 0), o.paymentIntentId || '', o.invoiceNumber || '']);
  const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="jnl-orders_${new Date().toISOString().slice(0, 10)}.csv"`);
  audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: 'orders.exported', target: 'orders', meta: { rows: rows.length }, ip: sec.ipOf(req) });
  save();
  res.send(csv);
});

app.get('/api/admin/orders/:id', A, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id || x.number === req.params.id);
  if (!o) return fail(res, 'Order not found', 404);
  json(res, {
    ...o,
    providerMode: payments.MODE,
    audit: db.audit.filter(a => a.target === 'order' && a.targetId === o.id).slice(-50).reverse(),
    invoice: db.invoices.find(i => i.id === o.invoiceId) || null,
    customerAccount: o.userId ? (() => { const u = db.users.find(x => x.id === o.userId); return u ? { id: u.id, name: u.name, email: u.email, date: u.date } : null; })() : null
  });
});

app.patch('/api/admin/orders/:id/fulfillment', A, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return fail(res, 'Order not found', 404);
  const to = sec.str(req.body.fulfillmentStatus, 30);
  if (!orders.FULFILLMENT_STATUSES.includes(to)) return fail(res, 'Unknown fulfillment status');
  if (!orders.canFulfillment(o.fulfillmentStatus, to)) return fail(res, `Cannot move fulfillment from ${o.fulfillmentStatus} to ${to}`, 409);

  const carrier = sec.str(req.body.carrier, 60);
  const trackingNumber = sec.str(req.body.trackingNumber, 80);
  const trackingUrl = sec.str(req.body.trackingUrl, 300);
  if (['shipped', 'out_for_delivery', 'delivered'].includes(to) && !trackingNumber && !(o.shipment && o.shipment.trackingNumber)) {
    return fail(res, 'A tracking number is required to mark an order shipped.', 422);
  }
  if (trackingUrl && !/^https?:\/\//i.test(trackingUrl)) return fail(res, 'Tracking URL must start with http(s)://');

  const note = sec.str(req.body.note, 300);
  orders.applyFulfillmentStatus(o, to, req.u.name || 'admin', note);
  if (trackingNumber) {
    o.shipment = {
      carrier, trackingNumber, trackingUrl, source: 'admin',
      shippedAt: o.shipment?.shippedAt || (to === 'shipped' ? new Date().toISOString() : ''),
      events: o.shipment?.events || []
    };
    if (to === 'shipped') o.shipment.events.push({ at: new Date().toISOString(), status: 'shipped', description: `Handed to ${carrier || 'carrier'}`, source: 'admin', by: req.u.name || 'admin' });
  } else if (o.shipment && (carrier || trackingUrl)) {
    o.shipment.carrier = carrier || o.shipment.carrier;
    o.shipment.trackingUrl = trackingUrl || o.shipment.trackingUrl;
  }
  if (to === 'shipped' && !o.estimateDeliveryAt) {
    const days = Number(String(o.shippingLabel).match(/(\d+)/)?.[1]) || 5;
    // Clearly an estimate, never presented as carrier-confirmed
    o.estimateDeliveryAt = new Date(Date.now() + days * 864e5).toISOString();
  }
  o.paymentStatusChangedByFulfillment = false; // fulfilment never touches payment
  orders.syncLegacy(o);
  save();
  webhooks.notify(o, 'Order update', to === 'shipped' ? `Order ${o.number} has shipped${trackingNumber ? ' (tracking ' + trackingNumber + ')' : ''}.` : `Order ${o.number} is now ${orders.FULFILLMENT_LABEL[to].toLowerCase()}.`);
  audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: 'order.fulfillment_changed', target: 'order', targetId: o.id, meta: { to, trackingNumber, carrier }, ip: sec.ipOf(req) });
  json(res, { order: adminOrderRow(o) });
});

// Manual tracking events (used when no carrier integration is configured)
app.post('/api/admin/orders/:id/tracking', A, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return fail(res, 'Order not found', 404);
  if (!o.shipment) return fail(res, 'Add a tracking number before adding tracking events', 409);
  const description = sec.str(req.body.description, 200);
  const status = sec.str(req.body.status, 40);
  if (!description && !status) return fail(res, 'Enter a tracking description');
  o.shipment.events = o.shipment.events || [];
  const ev = {
    at: req.body.at && !isNaN(Date.parse(req.body.at)) ? new Date(req.body.at).toISOString() : new Date().toISOString(),
    status, description, location: sec.str(req.body.location, 80), source: 'admin', by: req.u.name || 'admin'
  };
  o.shipment.events.push(ev);
  o.shipment.lastEvent = ev;
  orders.addEvent(o, { type: 'tracking', label: description || status, actor: req.u.name || 'admin', note: 'Entered manually (not a carrier event)' });
  orders.syncLegacy(o);
  save();
  audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: 'order.tracking_added', target: 'order', targetId: o.id, meta: ev, ip: sec.ipOf(req) });
  json(res, { shipment: o.shipment });
});

app.get('/api/admin/payments', A, (req, res) => {
  const rows = db.orders.filter(o => o.paymentIntentId || ['failed', 'requires_payment', 'processing'].includes(o.paymentStatus))
    .map(o => ({
      orderId: o.id, orderNumber: o.number, date: o.date, customer: o.customer?.name || o.name,
      amountCents: o.totalCents, currency: o.currency, paymentStatus: o.paymentStatus,
      provider: payments.MODE, intentId: o.paymentIntentId || '', lastError: o.lastPaymentError || '',
      refundedCents: o.refundedCents || 0, refunds: (o.refunds || []).length,
      requiresAction: !!o.requiresAction
    }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const filter = sec.str(req.query.status, 20);
  json(res, { payments: filter ? rows.filter(r => r.paymentStatus === filter) : rows, mode: payments.MODE });
});

app.post('/api/admin/orders/:id/refund', AS, rlPay, async (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return fail(res, 'Order not found', 404);
  if (!['paid', 'partially_refunded', 'refund_pending'].includes(o.paymentStatus)) return fail(res, 'Only paid orders can be refunded', 409);
  const remaining = o.totalCents - (o.refundedCents || 0);
  const requested = req.body.full === true ? remaining : Math.round(Number(req.body.amountCents));
  if (!Number.isFinite(requested) || requested < 1) return fail(res, 'Enter a refund amount', 422);
  if (requested > remaining) return fail(res, 'Refund exceeds the amount still refundable', 422);
  const amountCents = requested;
  if (payments.MODE === 'stripe' && !o.paymentIntentId) return fail(res, 'This order has no provider payment to refund', 409);

  const reason = sec.oneOf(req.body.reason, ['duplicate', 'fraudulent', 'requested_by_customer'], 'requested_by_customer');
  let refund;
  try {
    refund = await payments.provider.refund({
      paymentIntentId: o.paymentIntentId,
      amountCents,
      reason,
      idempotencyKey: 'refund_' + o.id + '_' + (o.refunds?.length || 0)
    });
  } catch (e) {
    return fail(res, 'The payment provider rejected the refund: ' + (e.message || 'unknown error'), 502);
  }

  const entry = {
    id: crypto.randomBytes(6).toString('hex'), providerRefundId: refund.id, amountCents: refund.amountCents || amountCents,
    status: refund.status || 'pending', reason, date: new Date().toISOString(), source: 'admin', by: req.u.name || 'admin'
  };
  await tx(async () => {
    o.refunds.push(entry);
    o.refundedCents = (o.refundedCents || 0) + entry.amountCents;
    const target = o.refundedCents >= o.totalCents ? 'refunded' : 'partially_refunded';
    if (orders.canPayment(o.paymentStatus, target)) orders.applyPaymentStatus(o, target, req.u.name || 'admin', `Refund ${refund.id}`);
    orders.syncLegacy(o);
    if (['succeeded', 'pending'].includes(entry.status)) await invoices.createCreditNote(o, entry, { actor: req.u.name || 'admin' });
    webhooks.notify(o, 'Refund issued', `A refund of ${dec(entry.amountCents)} ${String(o.currency).toUpperCase()} was issued for order ${o.number}.`);
  });
  // The admin refund path does not travel through a provider webhook, so keep
  // the local payment ledger in step here too.
  if (o.paymentIntentId) {
    webhooks.syncPaymentRecord(o.paymentIntentId, o.refundedCents >= o.totalCents ? 'refunded' : 'partially_refunded',
      { refundedCents: o.refundedCents, outcome: 'refunded_by_admin' });
  }
  audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: 'order.refunded', target: 'order', targetId: o.id,
    meta: { amountCents: entry.amountCents, refundId: refund.id, reason }, ip: sec.ipOf(req) });
  mail.send(o.customer?.email, `Refund issued - ${o.number}`, `A refund of ${dec(entry.amountCents)} ${String(o.currency).toUpperCase()} has been issued for order ${o.number}.`);
  save();
  json(res, { order: orders.publicOrder(o), refund: entry });
});

app.get('/api/admin/invoices', A, (req, res) => {
  const term = sec.str(req.query.q, 80).toLowerCase();
  let list = [...db.invoices];
  if (term) list = list.filter(i => [i.number, i.orderNumber, i.snapshot?.customer?.name, i.snapshot?.customer?.email].filter(Boolean).join(' ').toLowerCase().includes(term));
  if (req.query.type) list = list.filter(i => i.type === req.query.type);
  json(res, list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(i => ({
    id: i.id, number: i.number, type: i.type, date: i.date, orderId: i.orderId, orderNumber: i.orderNumber,
    customer: i.snapshot?.customer?.name || '', email: i.snapshot?.customer?.email || '',
    totalCents: i.totalCents, currency: i.currency, paymentStatus: i.paymentStatus, bytes: i.bytes || 0
  })));
});

app.get('/api/admin/invoices/:id/pdf', A, (req, res) => {
  const inv = db.invoices.find(i => i.id === req.params.id);
  if (!inv) return fail(res, 'Invoice not found', 404);
  audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: 'invoice.downloaded', target: 'invoice', targetId: inv.id, ip: sec.ipOf(req) });
  save();
  sendInvoice(res, inv);
});

app.get('/api/admin/audit', AS, (req, res) => json(res, audit.list({
  limit: sec.int(req.query.limit, 1, 500, 100),
  action: sec.str(req.query.action, 60),
  actor: sec.str(req.query.actor, 40)
})));

// Legacy admin order patch (existing dashboard clients)
app.patch('/api/admin/orders/:id', A, async (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.sendStatus(404);
  if (req.body.status) {
    const s = sec.str(req.body.status, 20);
    const map = { shipped: 'shipped', delivered: 'delivered', cancelled: 'cancelled', confirmed: 'processing', paid: 'processing', new: 'unfulfilled' };
    if (map[s]) {
      const target = map[s];
      if (target === 'unfulfilled') o.fulfillmentStatus = 'unfulfilled';
      else if (orders.canFulfillment(o.fulfillmentStatus, target)) orders.applyFulfillmentStatus(o, target, req.u.name || 'admin', 'Updated from dashboard');
      if (s === 'paid' && o.paymentStatus !== 'paid') await tx(() => webhooks.processEvent({ id: 'evt_admin_' + o.id + '_paid', type: 'payment_intent.succeeded', data: { object: { id: o.paymentIntentId || 'manual_' + o.id, metadata: { orderId: o.id }, status: 'succeeded' } } }));
      if (s === 'cancelled' && o.paymentStatus === 'requires_payment') { orders.applyPaymentStatus(o, 'cancelled', req.u.name || 'admin', 'Cancelled'); orders.releaseStock(o.lines.map(l => ({ id: l.id, qty: l.qty }))); }
    }
  }
  if ('paid' in req.body) {
    const want = sec.bool(req.body.paid);
    if (want && o.paymentStatus !== 'paid') {
      await tx(() => webhooks.processEvent({ id: 'evt_admin_' + o.id + '_paid', type: 'payment_intent.succeeded', data: { object: { id: o.paymentIntentId || 'manual_' + o.id, metadata: { orderId: o.id }, status: 'succeeded' } } }));
    } else if (!want && o.paymentStatus === 'paid') {
      o.paymentStatus = 'requires_payment'; orders.addEvent(o, { type: 'payment_reopened', label: 'Marked unpaid by admin', actor: req.u.name || 'admin' });
    }
  }
  orders.syncLegacy(o); save();
  audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: 'order.legacy_patch', target: 'order', targetId: o.id, meta: req.body, ip: sec.ipOf(req) });
  json(res, o);
});

// ---------------------------------------------------------------------------
// Products, projects, settings
// ---------------------------------------------------------------------------
const pick = {
  products: o => ({
    id: sec.str(o.id, 20) || crypto.randomBytes(6).toString('hex'),
    n: sec.str(o.n, 150), cat: sec.str(o.cat, 60) || 'General',
    pr: Number(o.pr), ic: sec.str(o.ic, 24) || 'package', img: String(o.img || '').slice(0, 2e6),
    d: sec.str(o.d, 500), stock: Math.max(0, parseInt(o.stock, 10) || 0),
    sku: sec.str(o.sku, 40).toUpperCase(), weightKg: Math.max(0, Number(o.weightKg) || 0),
    active: o.active === undefined ? true : sec.bool(o.active)
  }),
  projects: o => ({ id: sec.str(o.id, 20) || crypto.randomBytes(6).toString('hex'), t: sec.str(o.t, 150), d: sec.str(o.d, 500), img: String(o.img || '').slice(0, 2e6) })
};
for (const k of Object.keys(pick)) {
  app.put('/api/admin/' + k, A, (req, res) => {
    const o = pick[k](req.body);
    if (!o.n && !o.t) return fail(res, 'Title is required');
    if (k === 'products' && !(o.pr >= 0)) return fail(res, 'Valid price required');
    const i = db[k].findIndex(x => x.id === o.id);
    i < 0 ? db[k].push(o) : (db[k][i] = o);
    save();
    audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: k + '.saved', target: k, targetId: o.id, ip: sec.ipOf(req) });
    json(res, o);
  });
  app.delete('/api/admin/' + k + '/:id', A, (req, res) => {
    db[k] = db[k].filter(x => x.id !== req.params.id); save();
    audit.log({ actor: req.u.name || 'admin', actorId: req.u.id, role: req.u.role, action: k + '.deleted', target: k, targetId: req.params.id, ip: sec.ipOf(req) });
    json(res, { ok: 1 });
  });
}

const TEXT_SETTING_KEYS = ['name', 'logo', 'heroImg', 'hero', 'tag', 'about', 'email', 'phone', 'shopEmail', 'shopPhone',
  'addr', 'hours', 'cur', 'currencyCode', 'whatsapp', 'gaId', 'bank', 'legalName', 'legalAddr', 'gstNumber', 'invoicePrefix'];

app.put('/api/admin/settings', AS, (req, res) => {
  for (const k of TEXT_SETTING_KEYS) if (k in req.body) db.settings[k] = sec.str(req.body[k], k === 'logo' || k === 'heroImg' ? 2e6 : 2000);
  if (db.settings.currencyCode !== 'cad' && db.settings.currencyCode !== 'usd') db.settings.currencyCode = 'cad';
  if (req.body.invoiceRetentionYears !== undefined) db.settings.invoiceRetentionYears = sec.int(req.body.invoiceRetentionYears, 1, 30, 7);

  if (req.body.shipping && typeof req.body.shipping === 'object') {
    const s = req.body.shipping;
    if (s.freeOverCents !== undefined) db.settings.shipping.freeOverCents = Math.max(0, sec.int(s.freeOverCents, 0, 10_000_000, 0));
    if (s.perKgCents !== undefined) db.settings.shipping.perKgCents = Math.max(0, sec.int(s.perKgCents, 0, 1_000_000, 0));
    if (s.maxWeightKg !== undefined) db.settings.shipping.maxWeightKg = sec.int(s.maxWeightKg, 1, 5000, 500);
    if (Array.isArray(s.zones)) db.settings.shipping.zones = s.zones.slice(0, 20).map(z => ({
      id: sec.str(z.id, 30) || crypto.randomBytes(4).toString('hex'),
      label: sec.str(z.label, 60),
      prefixes: (Array.isArray(z.prefixes) ? z.prefixes : String(z.prefixes || '').split(',')).map(p => sec.str(p, 7).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 40),
      cents: Math.max(0, sec.int(z.cents, 0, 1_000_000, 0))
    }));
    if (Array.isArray(s.methods)) db.settings.shipping.methods = s.methods.slice(0, 5).map(m => ({
      id: sec.str(m.id, 20) || crypto.randomBytes(3).toString('hex'),
      label: sec.str(m.label, 60), days: sec.str(m.days, 40),
      multiplier: Math.min(10, Math.max(0, Number(m.multiplier) || 1))
    }));
  }
  if (req.body.tax && typeof req.body.tax === 'object') {
    if (req.body.tax.onShipping !== undefined) db.settings.tax.onShipping = sec.bool(req.body.tax.onShipping);
    if (req.body.tax.rates && typeof req.body.tax.rates === 'object') {
      for (const [prov, v] of Object.entries(req.body.tax.rates)) {
        if (!ship.PROVINCE_CODES.includes(prov)) continue;
        db.settings.tax.rates[prov] = { label: sec.str(v.label, 30) || prov, rate: Math.min(30, Math.max(0, Number(v.rate) || 0)) };
      }
    }
  }
  if (Array.isArray(req.body.carousel)) db.settings.carousel = req.body.carousel.slice(0, 6).map(s => ({ img: String(s.img || '').slice(0, 2e6), title: sec.str(s.title, 120), text: sec.str(s.text, 200) }));
  save();
  audit.log({ actor: req.u.name || 'super', actorId: req.u.id, role: req.u.role, action: 'settings.updated', target: 'settings', meta: { keys: Object.keys(req.body) }, ip: sec.ipOf(req) });
  json(res, { ok: 1 });
});

// Discount codes (super only)
app.get('/api/admin/discounts', AS, (req, res) => json(res, db.discounts));
app.post('/api/admin/discounts', AS, (req, res) => {
  const b = req.body || {};
  const code = sec.str(b.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = sec.oneOf(b.type, ['percent', 'fixed'], 'percent');
  const value = Number(b.value);
  if (!code || !(value > 0)) return fail(res, 'A code and a positive value are required');
  if (db.discounts.some(d => d.code === code)) return fail(res, 'That code already exists');
  const d = {
    id: crypto.randomBytes(5).toString('hex'), code, type,
    value: type === 'percent' ? Math.min(100, value) : Math.round(value * 100),
    minSubtotalCents: Math.max(0, toCents(b.minSubtotalCents ? b.minSubtotalCents / 100 : b.minSubtotal || 0)),
    usageLimit: b.usageLimit ? sec.int(b.usageLimit, 1, 1e6, 100) : null,
    used: 0, active: true, created: new Date().toISOString(),
    expiresAt: b.expiresAt && !isNaN(Date.parse(b.expiresAt)) ? new Date(b.expiresAt).toISOString() : ''
  };
  db.discounts.push(d); save();
  audit.log({ actor: req.u.name || 'super', actorId: req.u.id, role: req.u.role, action: 'discount.created', target: 'discount', targetId: d.id, meta: { code, type }, ip: sec.ipOf(req) });
  json(res, d);
});
app.delete('/api/admin/discounts/:id', AS, (req, res) => {
  db.discounts = db.discounts.filter(d => d.id !== req.params.id); save(); json(res, { ok: 1 });
});

// ---------------------------------------------------------------------------
// Sales overview + CSV (unchanged behaviour, still dollar-based for the report)
// ---------------------------------------------------------------------------
const dayMs = 864e5;
const RANGES = {
  '7d': ['Past 7 days', 7], '30d': ['Past 30 days', 30], '90d': ['Past 3 months', 90],
  '180d': ['Past 6 months', 180], '365d': ['Past 12 months', 365]
};
const dayStr = t => new Date(t).toISOString().slice(0, 10);

function salesRange(q) {
  let from = null, to = Date.now(), label = 'All time', key = 'all';
  if (q.from || q.to) {
    let f = q.from ? Date.parse(q.from.length === 10 ? q.from + 'T00:00:00' : q.from) : null;
    let t = q.to ? Date.parse(q.to.length === 10 ? q.to + 'T23:59:59' : q.to) : Date.now();
    if (isNaN(t)) t = Date.now();
    if (f !== null && isNaN(f)) f = null;
    if (f !== null && f > t) { const x = f; f = t; t = x; }
    from = f; to = t;
    label = (from !== null ? dayStr(from) : 'start') + ' to ' + dayStr(to);
    key = 'custom';
  } else if (q.range && RANGES[q.range]) {
    label = RANGES[q.range][0];
    from = Date.now() - RANGES[q.range][1] * dayMs;
    key = q.range;
  }
  return { from, to, label, key };
}

function salesData(from, to, label) {
  const inRange = o => { const t = Date.parse(o.date); return !isNaN(t) && (from === null || t >= from) && t <= to; };
  const ordersInRange = db.orders.filter(inRange);
  const revenue = ordersInRange.reduce((a, o) => a + (+o.total || 0), 0);
  const paid = ordersInRange.filter(o => o.paid).reduce((a, o) => a + (+o.total || 0), 0);
  const units = ordersInRange.reduce((a, o) => a + (o.lines || []).reduce((x, l) => x + (l.qty || 0), 0), 0);
  const byStatus = {}, byMethod = {};
  ordersInRange.forEach(o => {
    const st = o.status || 'new', m = o.method || 'cod';
    byStatus[st] = (byStatus[st] || 0) + 1;
    byMethod[m] = (byMethod[m] || 0) + 1;
  });

  const sold = {};
  ordersInRange.forEach(o => (o.lines || []).forEach(l => {
    sold[l.id] = sold[l.id] || { qty: 0, revenue: 0 };
    sold[l.id].qty += l.qty || 0;
    sold[l.id].revenue += (l.pr || 0) * (l.qty || 0);
  }));
  const products = db.products.map(p => {
    const s = sold[p.id] || { qty: 0, revenue: 0 };
    const stock = Number.isFinite(p.stock) ? p.stock : 0;
    return { id: p.id, name: p.n, cat: p.cat, price: p.pr, qty: s.qty, revenue: s.revenue, stock, stockValue: stock * p.pr };
  }).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name));

  const first = from !== null ? from : (ordersInRange.length ? Math.min(...ordersInRange.map(o => Date.parse(o.date))) : to);
  const spanDays = Math.max(1, Math.ceil((to - first) / dayMs));
  const bucket = spanDays <= 45 ? 1 : spanDays <= 320 ? 7 : 30;
  const step = bucket * dayMs;
  const series = [], idx = new Map();
  for (let t = Math.floor(first / step) * step; t <= to && series.length < 400; t += step) {
    const e = { label: dayStr(t), orders: 0, revenue: 0, units: 0 };
    idx.set(t, e); series.push(e);
  }
  ordersInRange.forEach(o => {
    const t = Date.parse(o.date);
    const e = idx.get(Math.floor(t / step) * step);
    if (e) { e.orders++; e.revenue += +o.total || 0; e.units += (o.lines || []).reduce((x, l) => x + (l.qty || 0), 0); }
  });

  const rows = [];
  ordersInRange.forEach(o => {
    const base = { id: o.id, date: o.date, name: o.name, email: o.email, phone: o.phone,
      method: o.method, paid: o.paid ? 'yes' : 'no', status: o.status, total: o.total };
    const ls = o.lines || [];
    if (!ls.length) rows.push({ ...base, product: '', qty: '', pr: '', lineTotal: '' });
    ls.forEach(l => rows.push({ ...base, product: l.n, qty: l.qty, pr: l.pr, lineTotal: (l.pr || 0) * (l.qty || 0) }));
  });

  const recent = [...ordersInRange].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 10)
    .map(o => ({ id: o.id, date: o.date, name: o.name, total: o.total, paid: !!o.paid, status: o.status, method: o.method,
      items: (o.lines || []).reduce((a, l) => a + (l.qty || 0), 0) }));

  return {
    label, from: from !== null ? dayStr(from) : '', to: dayStr(to),
    kpis: {
      orders: ordersInRange.length, revenue, paid, outstanding: revenue - paid, units,
      avg: ordersInRange.length ? revenue / ordersInRange.length : 0,
      customers: new Set(ordersInRange.map(o => (o.email || o.name || '').toLowerCase()).filter(Boolean)).size,
      stockUnits: products.reduce((a, p) => a + p.stock, 0),
      stockValue: products.reduce((a, p) => a + p.stockValue, 0)
    },
    byStatus, byMethod, products, series, recent, rows
  };
}

app.get('/api/admin/sales', A, (req, res) => {
  const r = salesRange(req.query);
  const d = salesData(r.from, r.to, r.label);
  delete d.rows;
  json(res, { ...d, range: r.key });
});

const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
app.get('/api/admin/sales.csv', A, (req, res) => {
  const r = salesRange(req.query);
  const d = salesData(r.from, r.to, r.label);
  const head = ['Order ID', 'Date', 'Customer', 'Email', 'Phone', 'Method', 'Paid', 'Status', 'Product', 'Qty', 'Unit price', 'Line total', 'Order total'];
  const lines = [head];
  d.rows.forEach(x => lines.push([x.id, x.date, x.name, x.email, x.phone, x.method, x.paid, x.status, x.product, x.qty, x.pr, x.lineTotal, x.total]));
  lines.push([], ['SUMMARY', '', r.label]);
  lines.push(['Orders', d.kpis.orders]);
  lines.push(['Units sold', d.kpis.units]);
  lines.push(['Gross revenue', d.kpis.revenue]);
  lines.push(['Paid', d.kpis.paid]);
  lines.push(['Outstanding (amount left)', d.kpis.outstanding]);
  lines.push(['Average order value', Math.round(d.kpis.avg * 100) / 100]);
  lines.push(['Products in stock (units)', d.kpis.stockUnits]);
  lines.push(['Stock value', d.kpis.stockValue]);
  Object.entries(d.byStatus).forEach(([k, n]) => lines.push(['Orders: ' + k, n]));
  const csv = lines.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  const fname = 'sales-report_' + String(r.key).replace(/[^\w-]/g, '') + '_' + (r.from !== null ? dayStr(r.from) : 'all') + '_' + dayStr(r.to) + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.send(csv);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.type === 'entity.parse.failed' ? 400 : (err.status || 500);
  if (status >= 500) console.error('[error]', err.message);
  res.status(status).json({ error: status === 400 ? 'Bad request' : 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log('Site running on http://localhost:' + PORT);
  console.log('Payments: ' + (payments.sandboxMode ? 'SANDBOX (no real charges)' : 'Stripe ' + (process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'test')));
});
