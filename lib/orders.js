// -----------------------------------------------------------------------------
// Order domain: server-side pricing, totals, stock, numbering and lifecycle.
// The browser never supplies a price, a total, a tax or a shipping fee.
// -----------------------------------------------------------------------------
const crypto = require('crypto');
const { db, next } = require('./db');
const { toCents } = require('./money');
const ship = require('./shipping');

const PAYMENT_STATUSES = ['requires_payment', 'processing', 'paid', 'failed', 'cancelled',
  'refund_pending', 'partially_refunded', 'refunded'];
const FULFILLMENT_STATUSES = ['unfulfilled', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];

const PAYMENT_NEXT = {
  requires_payment: ['processing', 'paid', 'failed', 'cancelled'],
  processing: ['paid', 'failed', 'cancelled'],
  paid: ['refund_pending', 'partially_refunded', 'refunded'],
  refund_pending: ['refunded', 'partially_refunded', 'paid'],
  partially_refunded: ['refunded', 'partially_refunded'],
  failed: ['requires_payment', 'processing', 'paid', 'cancelled'],
  cancelled: [],
  refunded: []
};
const FULFILLMENT_NEXT = {
  unfulfilled: ['processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  processing: ['shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered', 'shipped'],
  delivered: [],
  cancelled: []
};

const PAYMENT_LABEL = {
  requires_payment: 'Awaiting payment', processing: 'Payment processing', paid: 'Paid',
  failed: 'Payment failed', cancelled: 'Payment cancelled', refund_pending: 'Refund pending',
  partially_refunded: 'Partially refunded', refunded: 'Refunded'
};
const FULFILLMENT_LABEL = {
  unfulfilled: 'Not fulfilled', processing: 'Preparing', shipped: 'Shipped',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled'
};

const canPayment = (from, to) => from === to || (PAYMENT_NEXT[from] || []).includes(to);
const canFulfillment = (from, to) => from === to || (FULFILLMENT_NEXT[from] || []).includes(to);

const moneyCfg = () => ({ cur: db.settings.cur || '$', currency: (db.settings.currencyCode || 'cad').toLowerCase() });

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

// Server-side line pricing. Prices, stock and weights come from the database.
function priceLines(rawItems) {
  const lines = [], errors = [], seen = new Set();
  if (!Array.isArray(rawItems) || !rawItems.length) return { lines, errors: ['Your cart is empty.'] };

  for (const item of rawItems.slice(0, 100)) {
    const id = String(item && item.id || '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = db.products.find(x => x.id === id);
    if (!p || p.active === false) { errors.push('An item in your cart is no longer available.'); continue; }
    const qty = Math.floor(Number(item.qty));
    if (!Number.isFinite(qty) || qty < 1) { errors.push('Quantities must be at least 1.'); continue; }
    const stock = Number.isFinite(p.stock) ? p.stock : 0;
    if (qty > stock) errors.push(`Only ${stock} × ${p.n} left in stock.`);
    lines.push({
      id: p.id, n: p.n, sku: p.sku || String(p.id).toUpperCase(), pr: p.pr,
      unitCents: toCents(p.pr), qty: Math.min(qty, 999), weightKg: Number(p.weightKg) || 1,
      ic: p.ic || 'package', img: p.img || '', cat: p.cat || ''
    });
  }
  return { lines, errors };
}

// Full server-computed quote. Used for the live checkout summary, and again
// inside order creation so the amount charged is always this number.
// The shop has no discount/promo codes: the price is the product price plus
// shipping and destination tax, nothing else.
function quote({ items, postalCode, province, method, contact }) {
  const { lines, errors } = priceLines(items);
  const subtotalCents = lines.reduce((a, l) => a + l.unitCents * l.qty, 0);
  const weightKg = lines.reduce((a, l) => a + l.weightKg * l.qty, 0);
  const issues = [...errors];

  const rates = db.settings.tax || {};
  const base = {
    ok: false, lines, subtotalCents, weightKg, discountCents: 0, discountCode: '',
    currency: moneyCfg().currency, issues
  };

  if (!lines.length) return { ...base, error: issues[0] || 'Your cart is empty.' };

  const dest = String(postalCode || '').trim() || String(province || '').trim()
    ? ship.checkDestination({ postalCode, province }) : { ok: false, reason: '' };
  const quoteAddressReady = !!(dest.ok);
  const prov = dest.ok ? dest.province : String(province || '').toUpperCase();
  const shipRes = quoteAddressReady
    ? ship.shippingOptions({ subtotalCents, weightKg, postalCode: dest.postalCode, province: prov })
    : { ok: false, options: [], error: '', free: false };

  const chosen = (shipRes.options || []).find(o => o.id === method) || (shipRes.options || [])[0] || null;
  const shippingCents = chosen ? chosen.cents : 0;
  const taxable = Math.max(0, subtotalCents + (rates.onShipping === false ? 0 : shippingCents));
  // No tax estimate until we have a verified delivery destination
  const tax = quoteAddressReady ? ship.taxFor({ province: prov, taxableCents: taxable }) : { cents: 0, label: '', rate: 0, lines: [] };
  const totalCents = Math.max(0, subtotalCents + shippingCents + tax.cents);

  return {
    ...base,
    ok: quoteAddressReady && shipRes.ok && issues.length === 0,
    addressReady: quoteAddressReady,
    serviceable: quoteAddressReady && shipRes.serviceable !== false,
    postalCode: dest.ok ? dest.postalCode : '',
    province: prov,
    zone: shipRes.zone || '',
    shippingMethods: shipRes.options || [],
    shippingMethod: chosen ? chosen.id : '',
    shippingLabel: chosen ? chosen.label : '',
    shippingCents,
    freeShipping: !!shipRes.free,
    taxCents: tax.cents,
    taxLabel: tax.label,
    taxRate: tax.rate,
    taxLines: tax.lines,
    totalCents,
    error: issues[0] || shipRes.error || dest.reason || ''
  };
}

// ---------------------------------------------------------------------------
// Lifetime helpers
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();

function nextOrderNumber() {
  const year = new Date().getFullYear();
  const n = next('order');
  return `${db.settings.invoicePrefix || 'JNL'}-${year}-${String(n).padStart(4, '0')}`;
}

function addEvent(order, { type, label, actor = 'system', note = '', meta = null }) {
  order.events = order.events || [];
  const ev = { at: now(), type, label, actor, ...(note ? { note: String(note).slice(0, 500) } : {}), ...(meta ? { meta } : {}) };
  order.events.push(ev);
  order.updatedAt = ev.at;
  return ev;
}

// Keep the legacy `paid` / `status` fields in step with the two real lifecycles
// so the existing sales dashboard, CSV export and old clients keep working.
function syncLegacy(order) {
  order.paid = ['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus);
  order.status = order.fulfillmentStatus === 'delivered' ? 'delivered'
    : order.fulfillmentStatus === 'shipped' || order.fulfillmentStatus === 'out_for_delivery' ? 'shipped'
    : order.fulfillmentStatus === 'cancelled' ? 'cancelled'
    : order.paymentStatus === 'paid' ? 'paid'
    : order.paymentStatus === 'refunded' ? 'refunded'
    : order.paymentStatus === 'failed' ? 'failed'
    : order.paymentStatus === 'processing' ? 'processing'
    : 'new';
  return order;
}

function applyPaymentStatus(order, to, actor = 'system', note = '') {
  const from = order.paymentStatus || 'requires_payment';
  if (!PAYMENT_STATUSES.includes(to)) throw new Error('Unknown payment status');
  if (!canPayment(from, to)) throw new Error(`Cannot move payment from ${from} to ${to}`);
  order.paymentStatus = to;
  addEvent(order, { type: 'payment_' + to, label: PAYMENT_LABEL[to], actor, note });
  return syncLegacy(order);
}

function applyFulfillmentStatus(order, to, actor = 'system', note = '') {
  const from = order.fulfillmentStatus || 'unfulfilled';
  if (!FULFILLMENT_STATUSES.includes(to)) throw new Error('Unknown fulfillment status');
  if (!canFulfillment(from, to)) throw new Error(`Cannot move fulfillment from ${from} to ${to}`);
  order.fulfillmentStatus = to;
  addEvent(order, { type: 'fulfillment_' + to, label: FULFILLMENT_LABEL[to], actor, note });
  return syncLegacy(order);
}

function reserveStock(lines) {
  for (const l of lines) {
    const p = db.products.find(x => x.id === l.id);
    if (!p) continue;
    p.stock = Math.max(0, (Number.isFinite(p.stock) ? p.stock : 0) - l.qty);
  }
}

function releaseStock(lines) {
  for (const l of lines) {
    const p = db.products.find(x => x.id === l.id);
    if (!p) continue;
    p.stock = (Number.isFinite(p.stock) ? p.stock : 0) + l.qty;
  }
}

// Immutable snapshot of what was actually bought, at purchase prices.
function itemSnapshot(lines) {
  return lines.map(l => ({
    id: l.id, name: l.n, sku: l.sku, qty: l.qty,
    unitCents: l.unitCents, unitPrice: l.unitCents / 100, lineCents: l.unitCents * l.qty,
    weightKg: l.weightKg, cat: l.cat
  }));
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
function makeOrder({ quote: q, user, contact, address, method, paymentStatus = 'requires_payment', channel = 'online', actor = 'customer' }) {
  const t = now();
  const number = nextOrderNumber();
  const order = {
    id: crypto.randomBytes(8).toString('hex'),
    number,
    date: t,
    updatedAt: t,
    userId: user ? user.id : null,
    customer: { id: user ? user.id : null, name: String(contact.name || '').slice(0, 100), email: String(contact.email || '').slice(0, 150), phone: String(contact.phone || '').slice(0, 40) },
    // legacy flattened fields, still used by the existing sales report / CSV
    name: String(contact.name || '').slice(0, 100),
    email: String(contact.email || '').slice(0, 150),
    phone: String(contact.phone || '').slice(0, 40),
    address: [address.street, address.city, address.province, address.postalCode].filter(Boolean).join(', ').slice(0, 300),
    items: itemSnapshot(q.lines),
    lines: itemSnapshot(q.lines).map(i => ({ id: i.id, n: i.name, pr: i.unitPrice, qty: i.qty, sku: i.sku, unitCents: i.unitCents })),
    subtotalCents: q.subtotalCents,
    discountCents: q.discountCents,
    discountCode: q.discountCode || '',
    shippingCents: q.shippingCents,
    shippingMethod: q.shippingMethod || 'standard',
    shippingLabel: q.shippingLabel || '',
    taxCents: q.taxCents,
    taxLabel: q.taxLabel || '',
    taxRate: q.taxRate || 0,
    taxLines: q.taxLines || [],
    totalCents: q.totalCents,
    total: q.totalCents / 100,
    currency: q.currency || 'cad',
    shippingAddress: {
      name: String(contact.name || '').slice(0, 100),
      street: String(address.street || '').slice(0, 200),
      city: String(address.city || '').slice(0, 100),
      province: String(address.province || '').toUpperCase().slice(0, 2),
      postalCode: ship.normalizePostal(address.postalCode),
      country: 'CA',
      phone: String(contact.phone || '').slice(0, 40),
      email: String(contact.email || '').slice(0, 150)
    },
    billingAddress: address.billingSame === false ? { ...address.billing, country: 'CA' } : null,
    method: ['card', 'cod', 'bank'].includes(method) ? method : 'card',
    channel,
    paymentStatus,
    fulfillmentStatus: 'unfulfilled',
    paid: false,
    status: 'new',
    paymentIntentId: '',
    providerCustomerId: '',
    events: [],
    refunds: [],
    shipment: null,
    invoiceId: '',
    estimateDeliveryAt: '',
    idempotencyKey: ''
  };
  addEvent(order, { type: 'created', label: 'Order placed', actor });
  if (paymentStatus === 'requires_payment') addEvent(order, { type: 'payment_pending', label: 'Awaiting payment' });
  return syncLegacy(order);
}

// ---------------------------------------------------------------------------
// Customer-safe projection
// ---------------------------------------------------------------------------
function publicOrder(o) {
  return {
    id: o.id, number: o.number, date: o.date, updatedAt: o.updatedAt,
    items: o.items, lines: o.lines,
    subtotalCents: o.subtotalCents, discountCents: o.discountCents, discountCode: o.discountCode,
    shippingCents: o.shippingCents, shippingLabel: o.shippingLabel, shippingMethod: o.shippingMethod,
    taxCents: o.taxCents, taxLabel: o.taxLabel, taxLines: o.taxLines,
    totalCents: o.totalCents, currency: o.currency,
    paymentStatus: o.paymentStatus, paymentStatusLabel: PAYMENT_LABEL[o.paymentStatus] || o.paymentStatus,
    paid: ['paid', 'partially_refunded', 'refunded'].includes(o.paymentStatus),
    fulfillmentStatus: o.fulfillmentStatus, fulfillmentStatusLabel: FULFILLMENT_LABEL[o.fulfillmentStatus] || o.fulfillmentStatus,
    method: o.method,
    lastPaymentError: o.lastPaymentError || '',
    shippingAddress: o.shippingAddress,
    events: o.events,
    shipment: o.shipment,
    refunds: (o.refunds || []).map(r => ({ amountCents: r.amountCents, status: r.status, date: r.date })),
    estimateDeliveryAt: o.estimateDeliveryAt,
    invoiceId: o.invoiceId,
    canDownloadInvoice: !!o.invoiceId,
    email: o.customer?.email || o.email
  };
}

module.exports = {
  PAYMENT_STATUSES, FULFILLMENT_STATUSES, PAYMENT_LABEL, FULFILLMENT_LABEL,
  canPayment, canFulfillment, priceLines, quote, makeOrder,
  addEvent, applyPaymentStatus, applyFulfillmentStatus, syncLegacy,
  reserveStock, releaseStock, nextOrderNumber, publicOrder, moneyCfg, now
};
