// -----------------------------------------------------------------------------
// Invoice, credit-note and receipt generation (server-side PDF, private files).
//
// PDFs live in data/invoices/ which is NOT served by express.static. They are
// only reachable through an authenticated download endpoint after an
// ownership/RBAC check. Every document stores an immutable snapshot of the
// prices and customer details it was issued with.
//
// Invoices come from two places:
//   * paid orders  -> created automatically by the payment webhook
//   * admin entry  -> created from the admin dashboard against a registered user
// Both use the same numbering series, PDF layout and JNL logo.
// -----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { db, next, FILE } = require('./db');
const { dec } = require('./money');

// Documents live beside the database they belong to, so a throwaway test
// database writes into its own directory instead of the live invoice store.
const INVOICE_DIR = path.join(path.dirname(FILE), 'invoices');
fs.mkdirSync(INVOICE_DIR, { recursive: true });

const LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.jpg');
const INK = '#0e1a33';
const MUTED = '#4a5670';
const ACCENT = '#e07a1f';

const money = (cents, currency) => `${dec(cents)} ${String(currency || 'cad').toUpperCase()}`;
const dstr = iso => new Date(iso || Date.now()).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
const round = n => Math.round(Number(n) || 0);

function numberFor(prefix, counterKey) {
  const year = new Date().getFullYear();
  const n = next(counterKey);
  return `${db.settings.invoicePrefix || 'JNL'}-${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

// Company identity block (with the official JNL logo) plus the document title.
function drawHeader(doc, title, meta) {
  const s = db.settings;
  const hasLogo = fs.existsSync(LOGO);
  if (hasLogo) {
    try { doc.image(LOGO, 50, 44, { fit: [56, 56] }); } catch { /* logo unreadable: text header still renders */ }
  }
  const x = hasLogo ? 118 : 50;

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
    .text(s.legalName || s.name || 'Joneli Industries Inc.', x, 46, { width: 210 });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  [s.legalAddr || s.addr, s.email, s.phone, s.gstNumber ? 'GST/HST No. ' + s.gstNumber : '']
    .filter(Boolean).slice(0, 4)
    .forEach(line => doc.text(String(line), x, doc.y, { width: 210 }));

  doc.font('Helvetica-Bold').fontSize(23).fillColor(INK).text(title, 330, 46, { width: 215, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  meta.filter(([, v]) => v !== undefined && v !== null && v !== '')
    .forEach(([k, v]) => doc.text(`${k}: ${v}`, 330, doc.y, { width: 215, align: 'right' }));

  doc.y = Math.max(doc.y, 112);
  doc.moveDown(0.9);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(1.5).strokeColor(ACCENT).stroke();
  doc.lineWidth(1);
  doc.moveDown(1);
}

function billTo(doc, inv) {
  const o = inv.snapshot || {};
  const c = o.customer || {};
  const a = o.shippingAddress || null;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BILL TO');
  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(String(c.name || 'Customer'), { width: 300 });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  const lines = [
    c.company,
    a ? a.street : '',
    a ? [a.city, a.province, a.postalCode].filter(Boolean).join(', ') : '',
    a && a.country ? (a.country === 'CA' ? 'Canada' : a.country) : '',
    c.email,
    c.phone
  ].filter(Boolean);
  lines.forEach(l => doc.text(String(l), { width: 300 }));
  doc.moveDown(1.1);
}

function itemsTable(doc, inv, sign) {
  const o = inv.snapshot;
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', 50, top, { width: 270 });
  doc.text('QTY', 325, top, { width: 40, align: 'right' });
  doc.text('UNIT', 370, top, { width: 80, align: 'right' });
  doc.text('AMOUNT', 455, top, { width: 90, align: 'right' });
  doc.moveDown(0.6);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(0.55);

  doc.font('Helvetica').fontSize(9).fillColor(INK);
  (o.items || []).forEach(it => {
    const y = doc.y;
    const label = `${it.name}${it.sku ? '  (' + it.sku + ')' : ''}`;
    doc.text(label, 50, y, { width: 265 });
    const after = doc.y;
    doc.text(String(sign * it.qty), 325, y, { width: 40, align: 'right' });
    doc.text(money(it.unitCents, o.currency), 370, y, { width: 80, align: 'right' });
    doc.text(money(sign * it.lineCents, o.currency), 455, y, { width: 90, align: 'right' });
    doc.y = after;
    doc.moveDown(0.45);
  });

  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(0.8);
}

function totalsBlock(doc, rows) {
  const right = 360;
  doc.font('Helvetica').fontSize(10);
  rows.forEach(([label, value, bold]) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? INK : MUTED)
      .text(label, right, doc.y, { width: 110, align: 'right', continued: true })
      .font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK)
      .text(value, { width: 80, align: 'right' });
    doc.moveDown(0.25);
  });
}

function footer(doc) {
  const s = db.settings;
  doc.fontSize(8).fillColor('#8a94a8')
    .text(`${s.legalName || s.name || ''} - ${s.email || ''} - ${s.phone || ''}`, 50, 780,
      { width: 495, align: 'center' });
}

function render(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function buildInvoicePdf(inv) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: inv.number, Author: db.settings.legalName || db.settings.name } });
  const credit = inv.type === 'credit_note';
  const sign = credit ? -1 : 1;

  drawHeader(doc, credit ? 'CREDIT NOTE' : 'INVOICE', [
    ['Number', inv.number],
    ['Issue date', dstr(inv.date)],
    ['Due date', inv.dueDate ? dstr(inv.dueDate) : ''],
    ['Order', inv.orderNumber || '']
  ]);

  billTo(doc, inv);
  itemsTable(doc, inv, sign);

  const o = inv.snapshot;
  totalsBlock(doc, [
    ['Subtotal', money(sign * (inv.subtotalCents ?? 0), o.currency)],
    ...(inv.discountCents ? [['Discount', '-' + money(inv.discountCents, o.currency).replace('-', '')]] : []),
    ...(inv.shippingCents ? [['Shipping', money(sign * inv.shippingCents, o.currency)]] : []),
    [(inv.taxLabel || 'Tax') + (inv.taxRate ? ` (${inv.taxRate}%)` : ''), money(sign * (inv.taxCents ?? 0), o.currency)],
    ['Total ' + String(o.currency || 'cad').toUpperCase(), money(sign * inv.totalCents, o.currency), true]
  ]);

  // Payment status box
  doc.moveDown(1.1);
  const boxY = doc.y;
  const paid = inv.paymentStatus === 'paid';
  doc.roundedRect(50, boxY, 495, 34, 4).fillAndStroke(paid ? '#eef7f0' : '#fdf4ea', paid ? '#cfe6d6' : '#f0dcc6');
  doc.fillColor(paid ? '#1f7a45' : '#9a5b12').font('Helvetica-Bold').fontSize(9)
    .text(paid ? 'PAID' : 'PAYMENT DUE', 62, boxY + 12);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(credit ? 'Credit note' : (paid ? 'Payment received' : `Amount due ${money(inv.totalCents, o.currency)}`),
      160, boxY + 12, { width: 300, align: 'right' });
  doc.y = boxY + 48;

  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  if (credit) {
    doc.text(`Credit note for order ${inv.orderNumber}. Refund reference: ${inv.providerRefundId || '-'}`, 50, doc.y, { width: 495 });
  } else {
    if (inv.transactionRef) doc.text(`Payment reference: ${inv.transactionRef}`, 50, doc.y, { width: 495 });
    if (inv.notes) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fillColor(INK).text('Notes', 50, doc.y);
      doc.font('Helvetica').fillColor(MUTED).text(String(inv.notes), 50, doc.y, { width: 495 });
    }
    doc.moveDown(0.6);
    doc.text('No card details are stored by ' + (db.settings.legalName || db.settings.name) + '.', 50, doc.y, { width: 495 });
    doc.text(`All amounts in ${String(o.currency || 'cad').toUpperCase()}. Retain this document for your records.`, 50, doc.y + 12, { width: 495 });
  }

  footer(doc);
  return render(doc);
}

function snapshotOf(order) {
  return {
    customer: order.customer,
    shippingAddress: order.shippingAddress,
    items: order.items,
    currency: order.currency
  };
}

async function createInvoice(order, { actor = 'system' } = {}) {
  if (order.invoiceId) return db.invoices.find(i => i.id === order.invoiceId) || null;
  const id = crypto.randomBytes(8).toString('hex');
  const number = numberFor('INV', 'invoice');
  const inv = {
    id, number, type: 'invoice', source: 'order', orderId: order.id, orderNumber: order.number,
    userId: order.userId || null, date: new Date().toISOString(),
    subtotalCents: order.subtotalCents, discountCents: order.discountCents, discountCode: order.discountCode,
    shippingCents: order.shippingCents, shippingLabel: order.shippingLabel,
    taxCents: order.taxCents, taxLabel: order.taxLabel, taxRate: order.taxRate,
    totalCents: order.totalCents, currency: order.currency,
    paymentStatus: order.paymentStatus, transactionRef: order.paymentIntentId || '',
    snapshot: snapshotOf(order)
  };
  const file = `${number}.pdf`;
  const abs = path.join(INVOICE_DIR, file);
  fs.writeFileSync(abs, await buildInvoicePdf(inv));
  Object.assign(inv, { file, bytes: fs.statSync(abs).size, createdBy: actor });
  db.invoices.push(inv);
  order.invoiceId = id;
  return inv;
}

// An invoice entered by an administrator against a registered customer. It is
// deliberately not tied to an order: the admin supplies the items and prices,
// the server computes the tax and total from the configured rules.
async function createAdminInvoice({ user, items, issueDate, dueDate, taxProvince, shippingCents = 0, paymentStatus = 'unpaid', notes = '', actor = 'admin' }) {
  const s = db.settings;
  const currency = (s.currencyCode || 'cad').toLowerCase();
  const clean = (items || []).map(it => {
    const qty = Math.max(1, Math.min(999, Math.floor(Number(it.qty) || 0)));
    const unitCents = Math.max(0, round(it.unitCents));
    return { name: String(it.description || it.name || 'Item').slice(0, 200), sku: '', qty, unitCents, lineCents: qty * unitCents };
  });
  if (!clean.length) throw new Error('Add at least one line item');
  if (!user) throw new Error('Select a registered customer');

  const subtotalCents = clean.reduce((a, it) => a + it.lineCents, 0);
  const ship = Math.max(0, round(shippingCents));
  const rates = (s.tax && s.tax.rates) || {};
  const tax = taxProvince && rates[taxProvince]
    ? { rate: Number(rates[taxProvince].rate) || 0, label: rates[taxProvince].label || 'Tax' }
    : { rate: 0, label: '' };
  const taxable = subtotalCents + (s.tax && s.tax.onShipping === false ? 0 : ship);
  const taxCents = Math.round(taxable * tax.rate / 100);
  const totalCents = subtotalCents + ship + taxCents;
  const status = paymentStatus === 'paid' ? 'paid' : 'unpaid';

  const id = crypto.randomBytes(8).toString('hex');
  const number = numberFor('INV', 'invoice');
  const inv = {
    id, number, type: 'invoice', source: 'admin',
    orderId: '', orderNumber: '',
    userId: user.id, date: (issueDate && !isNaN(Date.parse(issueDate))) ? new Date(issueDate).toISOString() : new Date().toISOString(),
    dueDate: dueDate && !isNaN(Date.parse(dueDate)) ? new Date(dueDate).toISOString() : '',
    subtotalCents, discountCents: 0, discountCode: '',
    shippingCents: ship, shippingLabel: ship ? 'Delivery' : '',
    taxCents, taxLabel: tax.label, taxRate: tax.rate,
    totalCents, currency,
    paymentStatus: status,
    transactionRef: status === 'paid' ? 'TEST-' + id.slice(0, 8).toUpperCase() : '',
    notes: String(notes || '').slice(0, 800),
    snapshot: {
      customer: { id: user.id, name: user.name, email: user.email, phone: user.phone || '' },
      shippingAddress: null,
      items: clean,
      currency
    }
  };

  const file = `${number}.pdf`;
  const abs = path.join(INVOICE_DIR, file);
  fs.writeFileSync(abs, await buildInvoicePdf(inv));
  Object.assign(inv, { file, bytes: fs.statSync(abs).size, createdBy: actor });
  db.invoices.push(inv);
  return inv;
}

async function createCreditNote(order, refundEntry, { actor = 'system' } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const number = numberFor('CN', 'credit');
  const inv = {
    id, number, type: 'credit_note', source: 'order', orderId: order.id, orderNumber: order.number,
    userId: order.userId || null, date: new Date().toISOString(),
    subtotalCents: refundEntry.subtotalCents || refundEntry.amountCents,
    discountCents: refundEntry.discountCents || 0,
    shippingCents: refundEntry.shippingCents || 0,
    taxCents: refundEntry.taxCents || 0,
    taxLabel: order.taxLabel, taxRate: order.taxRate,
    totalCents: refundEntry.amountCents, currency: order.currency,
    paymentStatus: 'refunded', providerRefundId: refundEntry.providerRefundId || refundEntry.id,
    snapshot: snapshotOf(order)
  };
  const file = `${number}.pdf`;
  const abs = path.join(INVOICE_DIR, file);
  fs.writeFileSync(abs, await buildInvoicePdf(inv));
  Object.assign(inv, { file, bytes: fs.statSync(abs).size, createdBy: actor });
  db.invoices.push(inv);
  return inv;
}

// -----------------------------------------------------------------------------
// Payment receipts (admin download). Built from the real order + payment record
// so nothing is invented; a sandbox payment is explicitly labelled as a test.
// -----------------------------------------------------------------------------
const receiptNumber = order => `${db.settings.invoicePrefix || 'JNL'}-RCPT-${String(order.number || '').replace(/^.*?(\d+)$/, '$1') || order.id}`;

async function buildReceiptPdf(order, { payment = null, testMode = false } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: receiptNumber(order), Author: db.settings.legalName || db.settings.name } });
  const paidEvent = [...(order.events || [])].reverse().find(e => e.type === 'payment_paid');
  const paidAt = paidEvent?.at || order.updatedAt || order.date;
  const ref = payment?.intentId || order.paymentIntentId || '';

  drawHeader(doc, 'RECEIPT', [
    ['Number', receiptNumber(order)],
    ['Date', dstr(paidAt)],
    ['Order', order.number]
  ]);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('RECEIVED FROM');
  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(String(order.customer?.name || order.name || 'Customer'));
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  [order.customer?.email || order.email, order.customer?.phone || order.phone].filter(Boolean)
    .forEach(l => doc.text(String(l)));
  doc.moveDown(1.2);

  const rows = (order.items || []).map(it => [it.name + (it.sku ? ' (' + it.sku + ')' : ''), String(it.qty), money(it.unitCents, order.currency), money(it.lineCents, order.currency)]);
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', 50, top, { width: 270 });
  doc.text('QTY', 325, top, { width: 40, align: 'right' });
  doc.text('UNIT', 370, top, { width: 80, align: 'right' });
  doc.text('AMOUNT', 455, top, { width: 90, align: 'right' });
  doc.moveDown(0.6);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(0.55);
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  rows.forEach(([d, q, u, a]) => {
    const y = doc.y;
    doc.text(d, 50, y, { width: 265 });
    const after = doc.y;
    doc.text(q, 325, y, { width: 40, align: 'right' });
    doc.text(u, 370, y, { width: 80, align: 'right' });
    doc.text(a, 455, y, { width: 90, align: 'right' });
    doc.y = after;
    doc.moveDown(0.45);
  });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(0.8);

  totalsBlock(doc, [
    ['Subtotal', money(order.subtotalCents, order.currency)],
    ...(order.discountCents ? [['Discount', '-' + money(order.discountCents, order.currency).replace('-', '')]] : []),
    ...(order.shippingCents ? [['Shipping', money(order.shippingCents, order.currency)]] : []),
    [(order.taxLabel || 'Tax') + (order.taxRate ? ` (${order.taxRate}%)` : ''), money(order.taxCents, order.currency)],
    ['Total paid ' + String(order.currency || 'cad').toUpperCase(), money(order.totalCents, order.currency), true],
    ...(order.refundedCents ? [['Refunded to date', '-' + money(order.refundedCents, order.currency).replace('-', '')]] : [])
  ]);

  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Payment details');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  [
    ['Method', 'Credit / debit card'],
    ['Status', String(order.paymentStatus || '').replace(/_/g, ' ')],
    ['Paid on', dstr(paidAt)],
    ['Payment reference', ref || '-'],
    ...(testMode ? [['Environment', 'TEST / SANDBOX - no live funds moved']] : [])
  ].forEach(([k, v]) => doc.text(`${k}: ${v}`, { width: 495 }));

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor('#8a94a8')
    .text(testMode
      ? 'This receipt records a sandbox test transaction. No real card was charged.'
      : 'This receipt records a payment processed by our payment provider.',
      50, doc.y, { width: 495 });

  footer(doc);
  return render(doc);
}

const invoicePath = inv => path.join(INVOICE_DIR, path.basename(inv.file));

module.exports = {
  createInvoice, createCreditNote, createAdminInvoice,
  buildInvoicePdf, buildReceiptPdf, receiptNumber,
  INVOICE_DIR, invoicePath
};
