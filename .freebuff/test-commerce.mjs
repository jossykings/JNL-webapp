// -----------------------------------------------------------------------------
// JNL SHOP commerce acceptance tests.
// Runs against http://localhost:3000 with a freshly seeded database.
// Stripe is not configured, so the server runs its labelled SANDBOX provider:
// every payment below goes through the same server-side state machine and a
// real HMAC-verified webhook, but no money moves.
// -----------------------------------------------------------------------------
import crypto from 'crypto';
import fs from 'fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const env = fs.readFileSync('.env', 'utf8');
const ADMIN_PASSWORD = (env.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim();
const SANDBOX_SECRET = (env.match(/^SANDBOX_WEBHOOK_SECRET=(.*)$/m) || [])[1]?.trim() || 'whsec_sandbox_dev_only';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
};

async function req(path, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let j = null;
  try { j = JSON.parse(buf.toString('utf8')); } catch { }
  return { status: r.status, j, buf, headers: r.headers, text: buf.toString('utf8') };
}

const uid = () => crypto.randomBytes(4).toString('hex');
const sign = (payload, secret = SANDBOX_SECRET, t = Math.floor(Date.now() / 1000)) => {
  const sig = crypto.createHmac('sha256', secret).update(t + '.' + payload).digest('hex');
  return `t=${t},v1=${sig}`;
};

// ---- 1. Admin + customer accounts ----
const sup = await req('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
const ST = sup.j?.token;
ok('super admin login', sup.status === 200 && !!ST);

const tag = uid();
const custA = `a${tag}@test.dev`, custB = `b${tag}@test.dev`;
const regA = await req('/api/auth/register', { method: 'POST', body: { name: 'Alice Buyer', email: custA, password: 'password123' } });
const TA = regA.j?.token;
const regB = await req('/api/auth/register', { method: 'POST', body: { name: 'Bob Buyer', email: custB, password: 'password123' } });
const TB = regB.j?.token;
ok('register two customers', regA.status === 200 && regB.status === 200 && !!TA && !!TB);

// ---- 2. Public config ----
let r = await req('/api/site');
ok('site exposes sandbox payment mode', r.j?.payment?.mode === 'sandbox' && r.j.payment.sandbox === true, JSON.stringify(r.j?.payment));
ok('site lists 13 provinces/territories', r.j?.provinces?.length === 13, String(r.j?.provinces?.length));
ok('shop carousel configured with slides', Array.isArray(r.j?.c?.carousel) && r.j.c.carousel.length >= 1, JSON.stringify(r.j?.c?.carousel?.length));

r = await req('/api/checkout/config');
ok('checkout config: provinces + shipping methods + currency cad', r.j?.provinces?.length === 13 && r.j.shippingMethods.length >= 1 && r.j.currency === 'cad', JSON.stringify(r.j));

// ---- 3. Cart ----
r = await req('/api/cart', { token: TA });
ok('new customer has empty cart', r.status === 200 && r.j.items.length === 0);
r = await req('/api/cart', { method: 'PUT', token: TA, body: { items: [{ id: 'p2', qty: 2 }, { id: 'nope', qty: 1 }] } });
ok('cart stores valid items and drops unknown products', r.status === 200 && r.j.items.length === 1 && r.j.items[0].qty === 2, JSON.stringify(r.j));
r = await req('/api/cart/merge', { method: 'POST', token: TA, body: { items: [{ id: 'p2', qty: 1 }, { id: 'p3', qty: 1 }] } });
ok('merge adds guest items into the server cart', r.j?.items?.find(i => i.id === 'p2')?.qty === 3 && r.j.items.find(i => i.id === 'p3')?.qty === 1, JSON.stringify(r.j?.items));
r = await req('/api/cart', { method: 'DELETE', token: TA });
ok('cart can be cleared', r.status === 200 && r.j.items.length === 0);

// ---- 4. Shipping + tax quote ----
const quote = (body) => req('/api/checkout/quote', { method: 'POST', body });
const base = { items: [{ id: 'p2', qty: 2 }], postalCode: 'M5V 3L9', province: 'ON' };

r = await quote(base);
const qON = r.j;
ok('ON quote: subtotal 3000, standard shipping 1500, HST 13% on 4500 = 585, total 5085',
  qON?.subtotalCents === 3000 && qON.shippingCents === 1500 && qON.taxCents === 585 && qON.taxRate === 13 && qON.totalCents === 5085,
  JSON.stringify(qON));
ok('ON quote is address-ready and serviceable', qON?.addressReady === true && qON.serviceable === true && qON.ok === true, JSON.stringify(qON));
ok('postal code normalized to "M5V 3L9"', qON?.postalCode === 'M5V 3L9', qON?.postalCode);

r = await quote({ ...base, postalCode: 'T2P 2M5', province: 'AB' });
ok('AB quote: 5% GST (no HST), different tax to ON', r.j.taxRate === 5 && r.j.taxCents === Math.round((3000 + r.j.shippingCents) * 0.05), JSON.stringify(r.j));
r = await quote({ ...base, postalCode: 'V6B 1A1', province: 'BC' });
ok('BC quote: 12% combined GST+PST', r.j.taxRate === 12, String(r.j.taxRate));

r = await quote({ ...base, postalCode: 'ZZZ 999' });
ok('invalid postal code rejected', r.j.ok === false && /postal code/i.test(r.j.error || ''), JSON.stringify(r.j));
r = await quote({ ...base, postalCode: 'M5V 3L9', province: 'AB' });
ok('province/postal-code mismatch rejected with the correct province', r.j.ok === false && /Ontario|ON/.test(r.j.error || ''), r.j.error);
r = await quote({ ...base, postalCode: '', province: 'ON' });
ok('missing postal code asks for one', r.j.ok === false && /postal code/i.test(r.j.error || ''), r.j.error);

// free shipping threshold
r = await quote({ items: [{ id: 'p1', qty: 5 }], postalCode: 'M5V 3L9', province: 'ON' });
ok('free shipping over $500 threshold applied', r.j.subtotalCents === 60000 && r.j.shippingCents === 0 && r.j.freeShipping === true, JSON.stringify(r.j));

// express method doubles the base rate
r = await quote({ ...base, shippingMethod: 'express' });
ok('express shipping doubles the standard fee', r.j.shippingCents === 3000 && r.j.shippingMethod === 'express', JSON.stringify(r.j.shippingCents));

// unserviceable destination (temporarily remove every zone)
const siteBefore = (await req('/api/site')).j;
r = await req('/api/admin/settings', { method: 'PUT', token: ST, body: { shipping: { ...siteBefore.c.shipping, zones: [] } } });
r = await quote(base);
ok('unsupported delivery destination is refused, not silently priced',
  r.j.ok === false && r.j.serviceable === false && r.j.shippingCents === 0 && /do not deliver/i.test(r.j.error || ''), JSON.stringify(r.j));
await req('/api/admin/settings', { method: 'PUT', token: ST, body: { shipping: siteBefore.c.shipping } });
r = await quote(base);
ok('zones restored after the serviceability test', r.j.ok === true && r.j.serviceable === true, JSON.stringify(r.j.error));

// discount code
const code = 'SAVE10' + tag.slice(0, 3).toUpperCase();
r = await req('/api/admin/discounts', { method: 'POST', token: ST, body: { code, type: 'percent', value: 10 } });
ok('super creates a percentage discount', r.status === 200 && r.j.code === code, JSON.stringify(r.j));
r = await quote({ ...base, discountCode: code });
const qDisc = r.j;
ok('discount applied to subtotal before tax', qDisc.discountCents === 300 && qDisc.taxCents === Math.round((3000 - 300 + qDisc.shippingCents) * 0.13), JSON.stringify(qDisc));
r = await quote({ ...base, discountCode: 'NOPE' + tag });
ok('invalid discount code reported without breaking the quote', r.status === 200 && /not valid/i.test(r.j.error || ''), r.j.error);

// ---- 5. Checkout authorisation + order creation ----
r = await req('/api/checkout', { method: 'POST', body: { ...base, name: 'Guest', email: 'g@test.dev', phone: '+1 416 555 0100', street: '1 King St W', city: 'Toronto' } });
ok('guest checkout blocked (401) — must create an account first', r.status === 401, String(r.status));

const addrA = { name: 'Alice Buyer', email: custA, phone: '+1 416 555 0134', street: '100 King St W, Unit 4', city: 'Toronto', province: 'ON', postalCode: 'M5V 3L9', shippingMethod: 'standard', paymentMethod: 'card', items: [{ id: 'p2', qty: 2 }] };
const keyA = 'test-order-' + tag;
r = await req('/api/checkout', { method: 'POST', token: TA, headers: { 'Idempotency-Key': keyA }, body: addrA });
const orderA = r.j?.order;
ok('authenticated customer creates an order + payment intent', r.status === 200 && !!orderA?.number && !!r.j.clientSecret && orderA.paymentStatus === 'requires_payment', JSON.stringify({ status: r.status, e: r.j?.error }));
ok('server-calculated total is stored on the order', orderA?.totalCents === 5085 && orderA.subtotalCents === 3000 && orderA.shippingCents === 1500 && orderA.taxCents === 585, JSON.stringify({ t: orderA?.totalCents }));
ok('order number is human readable', /^JNL-\d{4}-\d{4,}$/.test(orderA?.number || ''), orderA?.number);
ok('order snapshot records SKU, unit price and delivery address',
  orderA?.items?.[0]?.sku && orderA.items[0].unitCents === 1500 && orderA.shippingAddress.postalCode === 'M5V 3L9', JSON.stringify(orderA?.items));

// idempotency: replay the same key
r = await req('/api/checkout', { method: 'POST', token: TA, headers: { 'Idempotency-Key': keyA }, body: addrA });
ok('same Idempotency-Key returns the same order (no duplicate)', r.status === 200 && r.j.replayed === true && r.j.order.id === orderA.id, JSON.stringify(r.j?.order?.id));
const adminOrders = await req('/api/admin/orders?q=' + encodeURIComponent(orderA.number), { token: ST });
ok('only one order exists for that idempotency key', adminOrders.j?.total === 1, String(adminOrders.j?.total));

// price manipulation from the browser is ignored
const tamper = { ...addrA, items: [{ id: 'p2', qty: 2, pr: 0.01, unitCents: 1, price: 0.01, lineCents: 1 }] };
r = await req('/api/checkout', { method: 'POST', token: TA, headers: { 'Idempotency-Key': 'tamper-' + tag }, body: { ...tamper, postalCode: 'M5V 3L9' } });
ok('tampered prices cannot change the charge amount', r.status === 200 && r.j.order.totalCents === 5085, JSON.stringify(r.j?.order?.totalCents));
const orderTamper = r.j?.order;

// stock decremented at order creation
const siteAfterOrder = (await req('/api/site')).j;
ok('stock decremented by the reserved quantities', siteAfterOrder.products.find(p => p.id === 'p2').stock === 300 - 2 - 2, String(siteAfterOrder.products.find(p => p.id === 'p2').stock));

// missing Idempotency-Key rejected
r = await req('/api/checkout', { method: 'POST', token: TA, body: addrA });
ok('checkout without Idempotency-Key rejected', r.status === 400, String(r.status));

// ---- 6. Ownership ----
r = await req('/api/orders/' + orderA.id, { token: TA });
ok('owner can open their order', r.status === 200 && r.j.number === orderA.number);
r = await req('/api/orders/' + orderA.id, { token: TB });
ok("another customer cannot read someone else's order", r.status === 404, String(r.status));
r = await req('/api/payments/sandbox/confirm', { method: 'POST', token: TB, body: { orderId: orderA.id, outcome: 'succeed' } });
ok("another customer cannot pay someone else's order", r.status === 404, String(r.status));
r = await req('/api/checkout/' + orderA.id + '/cancel', { method: 'POST', token: TB });
ok("another customer cannot cancel someone else's order", r.status === 404, String(r.status));

// ---- 7. Sandbox payment: failure, then success ----
r = await req('/api/payments/sandbox/confirm', { method: 'POST', token: TA, body: { orderId: orderA.id, outcome: 'fail' } });
ok('declined sandbox card -> payment failed, order not paid', r.status === 200 && r.j.order.paymentStatus === 'failed' && r.j.order.paid !== true, JSON.stringify(r.j?.order?.paymentStatus));
r = await req('/api/orders/' + orderA.id, { token: TA });
ok('failed payment is visible with an actionable error', r.j.paymentStatus === 'failed' && /declined/i.test(r.j.lastPaymentError || ''), JSON.stringify([r.j.paymentStatus, r.j.lastPaymentError]));
const invBefore = (await req('/api/admin/invoices', { token: ST })).j.length;
r = await req('/api/payments/sandbox/confirm', { method: 'POST', token: TA, body: { orderId: orderA.id, outcome: 'succeed' } });
ok('successful sandbox payment marks the order paid', r.status === 200 && r.j.order.paymentStatus === 'paid' && r.j.order.paid === true, JSON.stringify(r.j?.order?.paymentStatus));
const orderAPaid = r.j.order;
ok('paid order has an invoice reference', !!orderAPaid.canDownloadInvoice && !!orderAPaid.invoiceId, JSON.stringify(orderAPaid.invoiceId));
const invAfter = (await req('/api/admin/invoices', { token: ST })).j;
ok('exactly one invoice was issued for the payment', invAfter.length === invBefore + 1, String(invAfter.length - invBefore));
ok('invoice number is human readable', /^JNL-INV-\d{4}-\d{4,}$/.test(invAfter[0]?.number || ''), invAfter[0]?.number);
ok('invoice total matches the order snapshot', invAfter[0]?.totalCents === 5085, String(invAfter[0]?.totalCents));

// repeating the confirmation must not duplicate the charge or invoice
r = await req('/api/payments/sandbox/confirm', { method: 'POST', token: TA, body: { orderId: orderA.id, outcome: 'succeed' } });
const invAgain = (await req('/api/admin/invoices', { token: ST })).j.length;
ok('repeat confirmation is idempotent (no second invoice)', r.status === 200 && invAgain === invAfter.length, String(invAgain - invAfter.length));

// stock is not decremented a second time on payment
const siteAfterPaid = (await req('/api/site')).j;
ok('payment does not decrement stock twice', siteAfterPaid.products.find(p => p.id === 'p2').stock === 300 - 4, String(siteAfterPaid.products.find(p => p.id === 'p2').stock));

// ---- 8. Invoices are private + correct type ----
r = await req('/api/invoices/' + orderAPaid.invoiceId + '/pdf', { token: TA });
ok('owner downloads a PDF invoice', r.status === 200 && (r.headers.get('content-type') || '').includes('application/pdf') && r.buf.slice(0, 4).toString() === '%PDF', r.buf.slice(0, 8).toString());
ok('invoice is served with no-store and a filename', /no-store/.test(r.headers.get('cache-control') || '') && /inline; filename=/.test(r.headers.get('content-disposition') || ''), r.headers.get('cache-control'));
r = await req('/api/invoices/' + orderAPaid.invoiceId + '/pdf', { token: TB });
ok("another customer cannot download someone else's invoice", r.status === 404, String(r.status));
r = await req('/api/invoices/' + orderAPaid.invoiceId + '/pdf');
ok('invoice requires authentication', r.status === 401, String(r.status));
r = await req('/api/admin/invoices/' + orderAPaid.invoiceId + '/pdf', { token: ST });
ok('admin can download any invoice', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF');

// ---- 9. Webhooks: signature, tolerance, idempotency, ordering ----
const event = (id, type, obj) => JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object: obj } });

const whBody = event('evt_bad_' + tag, 'payment_intent.succeeded', { id: 'pi_x', status: 'succeeded', metadata: { orderId: orderA.id } });
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whBody), headers: { 'stripe-signature': 't=' + Math.floor(Date.now() / 1000) + ',v1=deadbeef', 'Content-Type': 'application/json' } });
ok('webhook with an invalid signature is rejected (400)', r.status === 400, String(r.status));
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whBody), headers: { 'stripe-signature': sign(whBody, 'whsec_wrong_' + tag), 'Content-Type': 'application/json' } });
ok('webhook signed with the wrong secret is rejected', r.status === 400, String(r.status));
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whBody), headers: { 'stripe-signature': sign(whBody, SANDBOX_SECRET, Math.floor(Date.now() / 1000) - 3600), 'Content-Type': 'application/json' } });
ok('webhook outside the timestamp tolerance is rejected (replay protection)', r.status === 400, String(r.status));
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whBody), headers: { 'stripe-signature': sign(whBody), 'Content-Type': 'application/json' } });
ok('validly signed webhook accepted', r.status === 200 && r.j.received === true, JSON.stringify(r.j));

// A fresh unpaid order settles only through a signed webhook
const keyW = 'webhook-order-' + tag;
r = await req('/api/checkout', { method: 'POST', token: TB, headers: { 'Idempotency-Key': keyW }, body: { ...addrA, name: 'Bob Buyer', email: custB, items: [{ id: 'p3', qty: 1 }] } });
const orderW = r.j.order;
ok('second customer creates an unpaid order', r.status === 200 && orderW.paymentStatus === 'requires_payment', JSON.stringify(r.j?.error));
const whPaid = event('evt_paid_' + tag, 'payment_intent.succeeded', { id: 'pi_' + tag, status: 'succeeded', amount: orderW.totalCents, metadata: { orderId: orderW.id } });
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whPaid), headers: { 'stripe-signature': sign(whPaid), 'Content-Type': 'application/json' } });
ok('signed payment_intent.succeeded marks the order paid', r.status === 200 && r.j.outcome === 'order_paid', JSON.stringify(r.j));
r = await req('/api/orders/' + orderW.id, { token: TB });
ok('customer sees the paid status after the webhook', r.j.paymentStatus === 'paid', r.j.paymentStatus);
const invCountW = (await req('/api/admin/invoices', { token: ST })).j.length;
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whPaid), headers: { 'stripe-signature': sign(whPaid), 'Content-Type': 'application/json' } });
ok('duplicate webhook is acknowledged but not reprocessed', r.status === 200 && r.j.duplicate === true, JSON.stringify(r.j));
ok('duplicate webhook created no extra invoice', (await req('/api/admin/invoices', { token: ST })).j.length === invCountW);

// out-of-order failure after success must not un-pay the order
const whFailLate = event('evt_late_fail_' + tag, 'payment_intent.payment_failed', { id: 'pi_' + tag, status: 'requires_payment_method', metadata: { orderId: orderW.id }, last_payment_error: { message: 'late event' } });
r = await req('/api/stripe-webhook', { method: 'POST', body: JSON.parse(whFailLate), headers: { 'stripe-signature': sign(whFailLate), 'Content-Type': 'application/json' } });
r = await req('/api/orders/' + orderW.id, { token: TB });
ok('late failure event cannot change a paid order', r.j.paymentStatus === 'paid', r.j.paymentStatus);

// ---- 10. Saved cards (safe metadata only) ----
r = await req('/api/payments/methods', { token: TA });
ok('no saved cards initially', r.status === 200 && r.j.methods.length === 0 && r.j.mode === 'sandbox');
r = await req('/api/payments/methods/setup-intent', { method: 'POST', token: TA });
const si = r.j;
ok('setup intent created for saved-card consent', r.status === 200 && !!si.clientSecret && !!si.setupIntentId, JSON.stringify({ status: r.status, e: r.j?.error }));
r = await req('/api/payments/sandbox/setup', { method: 'POST', token: TA, body: { setupIntentId: si.setupIntentId } });
const pmId = r.j?.paymentMethodId;
ok('sandbox provider returns a tokenized payment method', r.status === 200 && /^pm_/.test(pmId || ''), JSON.stringify(r.j));
r = await req('/api/payments/methods', { method: 'POST', token: TA, body: { paymentMethodId: pmId } });
ok('card saved to the profile', r.status === 200 && r.j.methods.length === 1 && r.j.methods[0].isDefault === true, JSON.stringify(r.j));
const saved = r.j.methods[0];
ok('saved card exposes only brand/last4/expiry (no PAN or CVV)', !!saved.brand && !!saved.last4 && !('number' in saved) && !('cvc' in saved) && !('card' in saved), JSON.stringify(saved));
r = await req('/api/checkout/config', { token: TA });
ok('checkout config lists the saved card for reuse', r.j.savedCards?.length === 1 && r.j.savedCards[0].last4 === saved.last4, JSON.stringify(r.j.savedCards));
r = await req('/api/payments/methods/' + pmId + '/default', { method: 'POST', token: TB });
ok("another customer cannot set someone else's card as default", r.status === 404, String(r.status));
r = await req('/api/payments/methods/' + pmId, { method: 'DELETE', token: TB });
ok("another customer cannot remove someone else's card", r.status === 404, String(r.status));
r = await req('/api/payments/methods/' + pmId, { method: 'DELETE', token: TA });
ok('owner removes the saved card', r.status === 200 && r.j.methods.length === 0, JSON.stringify(r.j));

// ---- 11. Admin RBAC ----
const admEmail = `adm${tag}@test.dev`;
r = await req('/api/admin/staff', { method: 'POST', token: ST, body: { name: 'Order Admin', email: admEmail, password: 'password123', role: 'admin' } });
ok('super creates a plain admin', r.status === 200);
const AT = (await req('/api/admin/login', { method: 'POST', body: { email: admEmail, password: 'password123' } })).j.token;

r = await req('/api/admin/orders?limit=5', { token: AT });
ok('plain admin can search orders', r.status === 200 && r.j.orders.length >= 1 && r.j.total >= 1, JSON.stringify({ status: r.status }));
r = await req('/api/admin/invoices', { token: AT });
ok('plain admin can view invoices', r.status === 200 && r.j.length >= 1);
r = await req('/api/admin/invoices/' + orderAPaid.invoiceId + '/pdf', { token: AT });
ok('plain admin can download invoices', r.status === 200);
r = await req('/api/admin/orders/' + orderA.id + '/refund', { method: 'POST', token: AT, body: { amountCents: 100 } });
ok('plain admin cannot refund (super only)', r.status === 401, String(r.status));
r = await req('/api/admin/audit', { token: AT });
ok('plain admin cannot read the audit log', r.status === 401, String(r.status));
r = await req('/api/admin/orders', { token: TB });
ok('customer cannot list all orders', r.status === 401, String(r.status));

// ---- 12. Fulfillment & tracking (never touches payment) ----
r = await req('/api/admin/orders/' + orderW.id + '/fulfillment', { method: 'PATCH', token: AT, body: { fulfillmentStatus: 'shipped' } });
ok('shipping without a tracking number is refused', r.status === 422, String(r.status));
r = await req('/api/admin/orders/' + orderW.id + '/fulfillment', {
  method: 'PATCH', token: AT,
  body: { fulfillmentStatus: 'shipped', carrier: 'Canada Post', trackingNumber: 'CX123456789CA', trackingUrl: 'https://www.canadapost-postescanada.ca/track-reperage/en#/details/CX123456789CA' }
});
ok('admin marks the order shipped with a tracking number', r.status === 200 && r.j.order.fulfillmentStatus === 'shipped', JSON.stringify(r.j?.error));
r = await req('/api/admin/orders/' + orderW.id, { token: AT });
const shipped = r.j;
ok('shipment details stored with carrier, number and URL', shipped.shipment?.carrier === 'Canada Post' && shipped.shipment.trackingNumber === 'CX123456789CA' && /^https:/.test(shipped.shipment.trackingUrl), JSON.stringify(shipped.shipment));
ok('shipping did not change the payment status', shipped.paymentStatus === 'paid', shipped.paymentStatus);
ok('estimated delivery is labelled as an estimate, not carrier data', !!shipped.estimateDeliveryAt, String(shipped.estimateDeliveryAt));

r = await req('/api/admin/orders/' + orderW.id + '/tracking', { method: 'POST', token: AT, body: { status: 'in_transit', description: 'Arrived at sorting facility', location: 'Mississauga, ON' } });
ok('manual tracking event recorded', r.status === 200 && r.j.shipment.events.some(e => e.description === 'Arrived at sorting facility' && e.source === 'admin'), JSON.stringify(r.j?.shipment?.events?.length));
r = await req('/api/orders/' + orderW.id, { token: TB });
ok('customer timeline includes the shipment event', r.j.events.some(e => e.label === 'Shipped') && r.j.shipment.events.length >= 1, JSON.stringify(r.j.events?.map(e => e.type)));
ok('payment is still paid after tracking updates', r.j.paymentStatus === 'paid', r.j.paymentStatus);

r = await req('/api/admin/orders/' + orderW.id + '/fulfillment', { method: 'PATCH', token: AT, body: { fulfillmentStatus: 'delivered' } });
ok('admin marks it delivered', r.status === 200 && r.j.order.fulfillmentStatus === 'delivered');
r = await req('/api/admin/orders/' + orderW.id + '/fulfillment', { method: 'PATCH', token: AT, body: { fulfillmentStatus: 'shipped' } });
ok('invalid backwards transition refused', r.status === 409, String(r.status));

// ---- 13. Refunds ----
r = await req('/api/admin/orders/' + orderW.id + '/refund', { method: 'POST', token: ST, body: { amountCents: 1000, reason: 'requested_by_customer' } });
ok('super issues a partial refund through the provider', r.status === 200 && r.j.order.paymentStatus === 'partially_refunded' && r.j.refund.amountCents === 1000, JSON.stringify(r.j?.order?.paymentStatus));
r = await req('/api/admin/orders/' + orderW.id + '/refund', { method: 'POST', token: ST, body: { amountCents: orderW.totalCents } });
ok('refund above the remaining balance refused', r.status === 422, String(r.status));
r = await req('/api/admin/orders/' + orderW.id + '/refund', { method: 'POST', token: ST, body: { full: true } });
ok('full refund marks the order refunded', r.status === 200 && r.j.order.paymentStatus === 'refunded', JSON.stringify(r.j?.order?.paymentStatus));
const creditNotes = (await req('/api/admin/invoices?type=credit_note', { token: ST })).j;
ok('credit notes issued for the refunds', creditNotes.length >= 2 && /^JNL-CN-/.test(creditNotes[0].number), JSON.stringify(creditNotes.map(c => c.number)));
r = await req('/api/admin/orders/' + orderTamper.id + '/refund', { method: 'POST', token: ST, body: { amountCents: 1 } });
ok('refund of an unpaid order refused', r.status === 409, String(r.status));

// ---- 14. Historical accuracy after a price change ----
r = await req('/api/admin/products', { method: 'PUT', token: ST, body: { id: 'p2', n: 'Safety Helmet', cat: 'Safety', pr: 99, stock: 250, weightKg: 1 } });
ok('product price changed by admin', r.status === 200 && r.j.pr === 99, JSON.stringify(r.j?.pr));
r = await req('/api/orders/' + orderA.id, { token: TA });
ok('historical order keeps its purchase price snapshot', r.j.items[0].unitCents === 1500 && r.j.totalCents === 5085, JSON.stringify([r.j.items[0].unitCents, r.j.totalCents]));
r = await req('/api/invoices/' + orderAPaid.invoiceId + '/pdf', { token: TA });
ok('issued invoice is unchanged by the price change', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF', String(r.status));
r = await quote({ items: [{ id: 'p2', qty: 1 }], postalCode: 'M5V 3L9', province: 'ON' });
ok('new quotes use the new price', r.j.subtotalCents === 9900, String(r.j.subtotalCents));
await req('/api/admin/products', { method: 'PUT', token: ST, body: { id: 'p2', n: 'Safety Helmet', cat: 'Safety', pr: 15, stock: 250, weightKg: 1 } });
ok('price restored for the rest of the run', (await req('/api/site')).j.products.find(p => p.id === 'p2').pr === 15);

// ---- 15. Orders export + audit ----
r = await req('/api/admin/orders.csv', { token: ST });
ok('admin exports orders as CSV including the order number', r.status === 200 && (r.headers.get('content-type') || '').includes('text/csv') && r.text.includes(orderW.number), r.text.slice(0, 60));
r = await req('/api/admin/audit', { token: ST });
ok('audit log records refunds with actor + target', r.j.some(a => a.action === 'order.refunded' && a.targetId === orderW.id && a.actor), JSON.stringify(r.j.slice(0, 2)));
ok('audit log records fulfillment changes', r.j.some(a => a.action === 'order.fulfillment_changed' && a.targetId === orderW.id));
ok('audit log records invoice downloads', r.j.some(a => a.action === 'invoice.downloaded'));

// ---- 16. Payments overview ----
r = await req('/api/admin/payments', { token: ST });
ok('payments overview exposes provider references without card data', r.status === 200 && r.j.payments.some(p => p.orderId === orderA.id) && !JSON.stringify(r.j).includes('4242424242424242'), JSON.stringify(r.j.payments.length));

// ---- 17. Unpaid COD order is never marked paid by the browser ----
r = await req('/api/checkout', { method: 'POST', token: TB, headers: { 'Idempotency-Key': 'cod-' + tag }, body: { ...addrA, name: 'Bob Buyer', email: custB, paymentMethod: 'cod', items: [{ id: 'p1', qty: 1 }] } });
ok('pay-on-delivery order is created unpaid', r.status === 200 && r.j.order.paymentStatus === 'requires_payment' && !r.j.clientSecret, JSON.stringify(r.j?.order?.paymentStatus));
const codOrder = r.j.order;
r = await req('/api/orders/' + codOrder.id, { token: TB });
ok('COD order never reports itself paid', r.j.paymentStatus !== 'paid', r.j.paymentStatus);
r = await req('/api/invoices', { token: TB });
ok('no invoice exists for an unpaid COD order', !r.j.some(i => i.orderId === codOrder.id), JSON.stringify(r.j.map(i => i.orderId)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
