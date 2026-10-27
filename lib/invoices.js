// -----------------------------------------------------------------------------
// Invoice + credit-note generation (server-side PDF, private storage).
//
// PDFs live in data/invoices/ which is NOT served by express.static. They are
// only reachable through /api/invoices/:id/pdf after an ownership/RBAC check.
// Each invoice stores an immutable snapshot of the order as it was paid.
// -----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { db, next, DIR } = require('./db');
const { dec } = require('./money');

const INVOICE_DIR = path.join(DIR, 'invoices');
fs.mkdirSync(INVOICE_DIR, { recursive: true });

const money = (cents, currency) => `${dec(cents)} ${String(currency || 'cad').toUpperCase()}`;
const dstr = iso => new Date(iso || Date.now()).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });

function numberFor(prefix, counterKey) {
  const year = new Date().getFullYear();
  const n = next(counterKey);
  return `${db.settings.invoicePrefix || 'JNL'}-${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

function drawHeader(doc, title, meta) {
  const s = db.settings;
  doc.fillColor('#0e1a33').font('Helvetica-Bold').fontSize(20).text(s.legalName || s.name || 'Joneli Industries Inc.');
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor('#4a5670');
  [s.legalAddr || s.addr, s.email, s.phone, s.gstNumber ? 'GST/HST No. ' + s.gstNumber : '']
    .filter(Boolean).forEach(line => doc.text(String(line)));
  doc.moveDown(1);
  doc.fillColor('#0e1a33').font('Helvetica-Bold').fontSize(22).text(title, { align: 'right' });
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#4a5670');
  meta.forEach(([k, v]) => doc.text(`${k}: ${v}`, { align: 'right' }));
  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(1);
}

function totalsBlock(doc, rows) {
  const right = 360;
  doc.font('Helvetica').fontSize(10);
  rows.forEach(([label, value, bold]) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? '#0e1a33' : '#4a5670')
      .text(label, right, doc.y, { width: 110, align: 'right', continued: true })
      .font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#0e1a33')
      .text(value, { width: 80, align: 'right' });
    doc.moveDown(0.25);
  });
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
  drawHeader(doc, inv.type === 'credit_note' ? 'CREDIT NOTE' : 'INVOICE', [
    ['Number', inv.number], ['Date', dstr(inv.date)], ['Order', inv.orderNumber]
  ]);

  const o = inv.snapshot;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0e1a33').text('Bill to');
  doc.font('Helvetica').fontSize(10).fillColor('#4a5670');
  const a = o.shippingAddress || {};
  [o.customer?.name, a.street, a.city, a.province && a.postalCode ? `${a.city}, ${a.province} ${a.postalCode}` : '', a.country === 'CA' ? 'Canada' : a.country, o.customer?.email, o.customer?.phone]
    .filter(Boolean).forEach(l => doc.text(String(l)));
  doc.moveDown(1);

  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#4a5670');
  doc.text('ITEM', 50, top, { width: 250 });
  doc.text('QTY', 320, top, { width: 40, align: 'right' });
  doc.text('UNIT', 365, top, { width: 80, align: 'right' });
  doc.text('AMOUNT', 450, top, { width: 90, align: 'right' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(0.5);

  const sign = inv.type === 'credit_note' ? -1 : 1;
  doc.font('Helvetica').fontSize(9).fillColor('#0e1a33');
  o.items.forEach(it => {
    const y = doc.y;
    doc.text(`${it.name}${it.sku ? '  (' + it.sku + ')' : ''}`, 50, y, { width: 250 });
    doc.text(String(sign * it.qty), 320, y, { width: 40, align: 'right' });
    doc.text(money(it.unitCents, o.currency), 365, y, { width: 80, align: 'right' });
    doc.text(money(sign * it.lineCents, o.currency), 450, y, { width: 90, align: 'right' });
    doc.moveDown(0.45);
  });

  doc.moveDown(0.6);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dfe4ee').stroke();
  doc.moveDown(0.8);

  totalsBlock(doc, [
    ['Subtotal', money(sign * (inv.subtotalCents ?? 0), o.currency)],
    ...(inv.discountCents ? [['Discount' + (inv.discountCode ? ' (' + inv.discountCode + ')' : ''), '-' + money(inv.discountCents, o.currency)]] : []),
    ['Shipping' + (inv.shippingLabel ? ' - ' + inv.shippingLabel : ''), money(sign * (inv.shippingCents ?? 0), o.currency)],
    [(inv.taxLabel || 'Tax') + (inv.taxRate ? ` (${inv.taxRate}%)` : ''), money(sign * (inv.taxCents ?? 0), o.currency)],
    ['Total ' + String(o.currency || 'cad').toUpperCase(), money(sign * inv.totalCents, o.currency), true]
  ]);

  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(9).fillColor('#4a5670');
  if (inv.type === 'credit_note') {
    doc.text(`Credit note for order ${inv.orderNumber}. Refund reference: ${inv.providerRefundId || '-'}`, 50, doc.y, { width: 495 });
  } else {
    doc.text(`Payment status: ${inv.paymentStatus}${inv.transactionRef ? ' - transaction ' + inv.transactionRef : ''}`, 50, doc.y, { width: 495 });
    doc.text('Payment was processed by our payment provider. No card details are stored by ' + (db.settings.legalName || db.settings.name) + '.', 50, doc.y + 12, { width: 495 });
    doc.text(`All amounts in ${String(o.currency || 'cad').toUpperCase()}. Retain this invoice for your records.`, 50, doc.y + 12, { width: 495 });
  }
  doc.fontSize(8).fillColor('#8a94a8').text(`${db.settings.legalName || db.settings.name} - ${db.settings.email || ''} - ${db.settings.phone || ''}`, 50, 780, { width: 495, align: 'center' });

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
    id, number, type: 'invoice', orderId: order.id, orderNumber: order.number,
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

async function createCreditNote(order, refundEntry, { actor = 'system' } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const number = numberFor('CN', 'credit');
  const inv = {
    id, number, type: 'credit_note', orderId: order.id, orderNumber: order.number,
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

const invoicePath = inv => path.join(INVOICE_DIR, path.basename(inv.file));

module.exports = { createInvoice, createCreditNote, INVOICE_DIR, invoicePath, buildInvoicePdf };
