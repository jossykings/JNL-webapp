// -----------------------------------------------------------------------------
// Payment provider adapter.
//
// Primary integration: Stripe PaymentIntents (+ Stripe Elements on the client,
// + authenticated webhooks on the server).
//
// When no Stripe secret key is configured the same interface runs against a
// clearly-labelled local SANDBOX provider. It performs no network calls and
// charges nothing; it exists so checkout, webhook verification, idempotency and
// order state can be exercised before merchant credentials are added. The UI
// shows a permanent "sandbox" banner and sandbox payments are never recorded as
// real money.
//
// Card data never reaches this server in either mode: Stripe.js/Elements talks
// directly to Stripe and only a payment-method token is returned.
// -----------------------------------------------------------------------------
const crypto = require('crypto');
const { db, tx } = require('./db');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SANDBOX_SECRET = process.env.SANDBOX_WEBHOOK_SECRET || 'whsec_sandbox_dev_only';
const CURRENCY = (process.env.SHOP_CURRENCY || 'cad').toLowerCase();

const MODE = SECRET_KEY ? 'stripe' : 'sandbox';
let stripe = null;
if (MODE === 'stripe') {
  // eslint-disable-next-line global-require
  stripe = require('stripe')(SECRET_KEY);
}

const randomId = prefix => prefix + crypto.randomBytes(12).toString('hex');

// ---------------------------------------------------------------------------
// Webhook signature (Stripe scheme: t=timestamp,v1=hex HMAC-SHA256 of "t.body")
// ---------------------------------------------------------------------------
function verifySignature(payload, header, secret, toleranceSec = 300) {
  if (!header) throw new Error('Missing signature');
  const parts = String(header).split(',').reduce((a, p) => {
    const i = p.indexOf('=');
    if (i > 0) { const k = p.slice(0, i).trim(); (a[k] = a[k] || []).push(p.slice(i + 1).trim()); }
    return a;
  }, {});
  const t = Number(parts.t?.[0]);
  if (!Number.isFinite(t)) throw new Error('Bad signature header');
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error('Signature timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret || SANDBOX_SECRET).update(`${t}.${payload}`).digest('hex');
  const candidates = parts.v1 || [];
  const ok = candidates.some(sig => {
    const a = Buffer.from(sig, 'utf8'), b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!ok) throw new Error('Invalid signature');
  const event = JSON.parse(payload);
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw new Error('Bad event payload');
  return event;
}

const webhookSecret = () => MODE === 'stripe' ? WEBHOOK_SECRET : SANDBOX_SECRET;

// Shape of webhook event ids differs by provider but both are unique strings
function eventId(ev) { return String(ev.id).slice(0, 120); }

// ---------------------------------------------------------------------------
// Sandbox provider (no network, no money)
// ---------------------------------------------------------------------------
function sandboxIntent({ amountCents, currency, customerId, metadata, saveCard, paymentMethodId }) {
  const id = randomId('pi_sbx_');
  const secret = randomId('pi_sbx_secret_');
  return {
    id, clientSecret: `${secret}`, amountCents, currency: currency || CURRENCY,
    status: 'requires_payment_method', customerId: customerId || '', metadata: metadata || {},
    saveCard: !!saveCard, paymentMethodId: paymentMethodId || '', created: Date.now(),
    sandbox: true, lastError: ''
  };
}

// Simulated provider-side confirmation. The browser can only *request* an
// outcome; the provider record and the resulting event are produced here.
async function sandboxConfirm(intentId, outcome = 'succeed', card = {}) {
  const intent = db.paymentIntents.find(i => i.id === intentId);
  if (!intent) throw new Error('Unknown payment intent');
  if (intent.status === 'succeeded') return { intent, event: null, duplicate: true };
  if (intent.status === 'canceled') throw new Error('This payment was cancelled');

  let eventType, status;
  if (outcome === 'fail') { status = 'requires_payment_method'; eventType = 'payment_intent.payment_failed'; intent.lastError = 'Your card was declined (sandbox test card).'; }
  else if (outcome === 'auth') { status = 'requires_action'; eventType = 'payment_intent.requires_action'; intent.lastError = ''; }
  else if (outcome === 'cancel') { status = 'canceled'; eventType = 'payment_intent.canceled'; intent.lastError = ''; }
  else { status = 'succeeded'; eventType = 'payment_intent.succeeded'; intent.lastError = ''; }

  intent.status = status;
  intent.updated = Date.now();
  if (status === 'succeeded') {
    // Mirror the provider: record the payment method checkout actually chose
    // (a saved card, when one was selected) rather than inventing a new one.
    const chosenId = card.paymentMethodId || intent.paymentMethodId || '';
    const fallback = { brand: 'test', last4: card.last4 || '4242', expMonth: 12, expYear: new Date().getFullYear() + 3 };
    const owner = chosenId ? db.users.find(u => (u.paymentMethods || []).some(p => p.id === chosenId)) : null;
    const saved = owner ? owner.paymentMethods.find(p => p.id === chosenId) : null;
    const meta = saved ? { brand: saved.brand, last4: saved.last4, expMonth: saved.expMonth, expYear: saved.expYear } : fallback;
    const pm = chosenId
      ? { id: chosenId, ...meta, sandbox: true }
      : { id: randomId('pm_sbx_'), ...fallback, sandbox: true };
    intent.paymentMethod = pm;
    intent.savedPaymentMethod = intent.saveCard ? pm : null;
  }
  const event = {
    id: randomId('evt_sbx_'),
    type: eventType,
    created: Math.floor(Date.now() / 1000),
    data: { object: {
      id: intent.id, object: 'payment_intent', status, amount: intent.amountCents, currency: intent.currency,
      customer: intent.customerId || null, metadata: intent.metadata,
      payment_method: intent.paymentMethod?.id || null,
      last_payment_error: intent.lastError ? { message: intent.lastError } : null
    } }
  };
  return { intent, event };
}

// ---------------------------------------------------------------------------
// Stripe provider
// ---------------------------------------------------------------------------
const s = {
  async createCustomer({ email, name, userId }) {
    const c = await stripe.customers.create({ email, name, metadata: { userId } });
    return { id: c.id };
  },
  async createIntent({ amountCents, currency, customerId, metadata, saveCard, paymentMethodId, receiptEmail, description, idempotencyKey }) {
    const params = {
      amount: amountCents,
      currency: currency || CURRENCY,
      automatic_payment_methods: { enabled: true },
      metadata: metadata || {},
      description,
      receipt_email: receiptEmail || undefined,
      customer: customerId || undefined
    };
    if (saveCard && customerId) params.setup_future_usage = 'off_session';
    if (paymentMethodId) { params.payment_method = paymentMethodId; params.confirm = true; }
    const pi = await stripe.paymentIntents.create(params, idempotencyKey ? { idempotencyKey } : undefined);
    return { id: pi.id, clientSecret: pi.client_secret, status: pi.status, amountCents: pi.amount, currency: pi.currency, customerId: pi.customer, paymentMethodId: pi.payment_method, lastError: pi.last_payment_error?.message || '' };
  },
  async retrieveIntent(id) {
    const pi = await stripe.paymentIntents.retrieve(id);
    return { id: pi.id, status: pi.status, amountCents: pi.amount, currency: pi.currency, customerId: pi.customer, paymentMethodId: pi.payment_method, metadata: pi.metadata, lastError: pi.last_payment_error?.message || '' };
  },
  async cancelIntent(id) { return stripe.paymentIntents.cancel(id); },
  async createSetupIntent({ customerId, metadata }) {
    const si = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'], usage: 'off_session', metadata });
    return { id: si.id, clientSecret: si.client_secret };
  },
  async retrievePaymentMethod(id) {
    const pm = await stripe.paymentMethods.retrieve(id);
    return { id: pm.id, brand: pm.card?.brand || 'card', last4: pm.card?.last4 || '', expMonth: pm.card?.exp_month || 0, expYear: pm.card?.exp_year || 0 };
  },
  async attachPaymentMethod(customerId, pmId) {
    const pm = await stripe.paymentMethods.attach(pmId, { customer: customerId });
    return { id: pm.id, brand: pm.card?.brand, last4: pm.card?.last4, expMonth: pm.card?.exp_month, expYear: pm.card?.exp_year };
  },
  async detachPaymentMethod(pmId) { return stripe.paymentMethods.detach(pmId); },
  async setDefault(customerId, pmId) { return stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } }); },
  async refund({ paymentIntentId, amountCents, reason, idempotencyKey }) {
    const r = await stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountCents, reason }, idempotencyKey ? { idempotencyKey } : undefined);
    return { id: r.id, status: r.status, amountCents: r.amount };
  }
};

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------
const sandbox = {
  async createCustomer() { return { id: randomId('cus_sbx_') }; },
  async createIntent(p) {
    const intent = sandboxIntent(p);
    db.paymentIntents.push(intent);
    return { id: intent.id, clientSecret: intent.clientSecret, status: intent.status, amountCents: intent.amountCents, currency: intent.currency, customerId: intent.customerId, sandbox: true };
  },
  async retrieveIntent(id) {
    const i = db.paymentIntents.find(x => x.id === id);
    if (!i) throw new Error('Unknown payment intent');
    return { id: i.id, status: i.status, amountCents: i.amountCents, currency: i.currency, customerId: i.customerId, paymentMethodId: i.paymentMethod?.id || '', metadata: i.metadata, lastError: i.lastError };
  },
  async cancelIntent(id) {
    const i = db.paymentIntents.find(x => x.id === id);
    if (i && i.status !== 'succeeded') { i.status = 'canceled'; i.updated = Date.now(); }
    return { id, status: i?.status || 'canceled' };
  },
  async createSetupIntent({ customerId, metadata }) {
    const si = { id: randomId('seti_sbx_'), clientSecret: randomId('seti_sbx_secret_'), customerId, metadata, status: 'requires_payment_method', sandbox: true, created: Date.now() };
    db.setupIntents = db.setupIntents || [];
    db.setupIntents.push(si);
    return { id: si.id, clientSecret: si.clientSecret, sandbox: true };
  },
  async retrievePaymentMethod() { return { id: randomId('pm_sbx_'), brand: 'test', last4: '4242', expMonth: 12, expYear: new Date().getFullYear() + 2 }; },
  async attachPaymentMethod(_c, pmId) { return { id: pmId, brand: 'test', last4: '4242', expMonth: 12, expYear: new Date().getFullYear() + 2 }; },
  async detachPaymentMethod(pmId) { return { id: pmId, deleted: true }; },
  async setDefault() { return { ok: true }; },
  async refund({ paymentIntentId, amountCents }) {
    return { id: randomId('re_sbx_'), status: 'succeeded', amountCents };
  }
};

const provider = MODE === 'stripe' ? s : sandbox;

module.exports = {
  MODE, provider, stripe, verifySignature, webhookSecret, eventId,
  sandboxConfirm, PUBLISHABLE_KEY, SECRET_KEY,
  enabled: MODE === 'stripe' ? !!(SECRET_KEY && PUBLISHABLE_KEY) : true,
  sandboxMode: MODE !== 'stripe',
  CURRENCY
};
