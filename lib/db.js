// -----------------------------------------------------------------------------
// Tiny JSON database with atomic writes, migrations and a write lock.
//
// The site shipped with data/db.json, so we keep it: one process, one file,
// written atomically (tmp + rename) and mutated only inside tx(). Critical
// commerce operations (order creation, payment updates) run inside a serialised
// transaction so two requests can never interleave a read-modify-write.
// -----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
// DB_FILE lets the automated suites (and restore drills) run a server against a
// throwaway database instead of the live shop data. Unset, the shop keeps using
// data/db.json exactly as before.
const FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(DIR, 'db.json');

const DEFAULT_TAX = {
  AB: { label: 'GST', rate: 5 },
  BC: { label: 'GST + PST', rate: 12 },
  MB: { label: 'GST + RST', rate: 12 },
  NB: { label: 'HST', rate: 15 },
  NL: { label: 'HST', rate: 15 },
  NS: { label: 'HST', rate: 14 },
  NT: { label: 'GST', rate: 5 },
  NU: { label: 'GST', rate: 5 },
  ON: { label: 'HST', rate: 13 },
  PE: { label: 'HST', rate: 15 },
  QC: { label: 'GST + QST', rate: 9.975 + 5 },
  SK: { label: 'GST + PST', rate: 11 },
  YT: { label: 'GST', rate: 5 }
};

const DEFAULT_SETTINGS = {
  name: 'Joneli Industries Inc.',
  logo: '/img/logo.jpg',
  heroImg: '',
  hero: 'We engineer the future. We supply what builds it.',
  tag: 'Turnkey project engineering and dependable distribution & procurement, under one roof.',
  about: "Write the company's story, mission and values here.",
  email: 'info@company.com',
  phone: '+000 000 000 0000',
  shopEmail: 'sales@company.com',
  shopPhone: '+000 000 000 0001',
  addr: 'Your business address',
  hours: 'Mon–Fri, 8am–5pm',
  cur: '$',
  currencyCode: 'cad',
  whatsapp: '',
  gaId: '',
  bank: 'Bank: Your Bank | Account name: Joneli Industries Inc. | Account no: 0000000000',
  // --- commerce configuration (all admin editable) ---
  legalName: 'Joneli Industries Inc.',
  legalAddr: '',
  gstNumber: '',
  invoicePrefix: 'JNL',
  invoiceRetentionYears: 7,
  lowStockThreshold: 5,
  tax: { onShipping: true, rates: DEFAULT_TAX },
  shipping: {
    freeOverCents: 50000,
    perKgCents: 0,
    maxWeightKg: 500,
    // Prefixes are Canadian FSA first letters (longer prefixes win, e.g. "M5V")
    zones: [
      { id: 'on-qc', label: 'Ontario & Quebec', prefixes: ['K', 'L', 'M', 'N', 'P', 'G', 'H', 'J'], cents: 1500 },
      { id: 'atlantic', label: 'Atlantic Canada', prefixes: ['A', 'B', 'C', 'E'], cents: 2200 },
      { id: 'prairies', label: 'Manitoba, Saskatchewan & Alberta', prefixes: ['R', 'S', 'T'], cents: 2500 },
      { id: 'bc', label: 'British Columbia', prefixes: ['V'], cents: 2800 },
      { id: 'north', label: 'Yukon, NWT & Nunavut', prefixes: ['X', 'Y'], cents: 4500 }
    ],
    methods: [
      { id: 'standard', label: 'Standard shipping', days: '3–5 business days', multiplier: 1 },
      { id: 'express', label: 'Express shipping', days: '1–2 business days', multiplier: 2 }
    ]
  },
  carousel: [
    { img: '/img/warehouse.jpg', title: 'Industrial supply, ready to ship', text: 'Valves, safety gear and electrical stock held in inventory.' },
    { img: '/img/logistics.jpg', title: 'Procurement without the guesswork', text: 'Clear pricing, real stock levels and tracked delivery across Canada.' },
    { img: '/img/construction.jpg', title: 'From site to shelf', text: 'Engineering-led sourcing for projects of every size.' }
  ]
};

const COLLECTIONS = ['products', 'projects', 'orders', 'quotes', 'messages', 'users', 'staff',
  'carts', 'payments', 'refunds', 'invoices', 'webhookEvents', 'audit', 'notifications',
  'discounts', 'paymentIntents', 'setupIntents', 'shipments', 'trackingEvents'];

const deepMerge = (base, extra) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
};

// Derive the two independent lifecycles from a legacy order row
function migrateOrder(o) {
  const cents = n => Math.round(Number(n || 0) * 100);
  if (!Number.isFinite(o.subtotalCents)) o.subtotalCents = cents(o.subtotal ?? o.total);
  if (!Number.isFinite(o.shippingCents)) o.shippingCents = cents(o.shipping);
  if (!Number.isFinite(o.taxCents)) o.taxCents = cents(o.tax);
  if (!Number.isFinite(o.discountCents)) o.discountCents = 0;
  if (!Number.isFinite(o.totalCents)) o.totalCents = o.subtotalCents + o.shippingCents + o.taxCents - o.discountCents;
  o.currency = o.currency || 'cad';
  o.number = o.number || 'JNL-' + String(o.date || new Date().toISOString()).slice(0, 4) + '-' + String(o.id).slice(0, 6).toUpperCase();
  o.paymentStatus = o.paymentStatus || (o.paid ? 'paid' : (o.status === 'cancelled' ? 'cancelled' : 'requires_payment'));
  o.fulfillmentStatus = o.fulfillmentStatus || ({
    paid: 'processing', shipped: 'shipped', delivered: 'delivered', cancelled: 'cancelled'
  }[o.status] || 'unfulfilled');
  if (!Array.isArray(o.events)) {
    o.events = [{ at: o.date || new Date().toISOString(), type: 'created', label: 'Order placed' }];
    if (o.paid) o.events.push({ at: o.date || new Date().toISOString(), type: 'paid', label: 'Payment received' });
  }
  if (!Array.isArray(o.lines)) o.lines = [];
  o.lines.forEach(l => {
    if (!Number.isFinite(l.unitCents)) l.unitCents = cents(l.pr);
    if (!l.sku) l.sku = '';
  });
  if (!o.shippingAddress) o.shippingAddress = { address: o.address || '', city: '', province: '', postalCode: '', country: 'CA' };
  if (!Array.isArray(o.refunds)) o.refunds = [];
  o.updatedAt = o.updatedAt || o.date || new Date().toISOString();
  return o;
}

function migrate(db) {
  db.settings = deepMerge(DEFAULT_SETTINGS, db.settings || {});
  // Rates/zones/methods are arrays+objects: keep the admin's own values but fill gaps
  db.settings.tax = db.settings.tax || {};
  db.settings.tax.rates = { ...DEFAULT_TAX, ...(db.settings.tax.rates || {}) };
  db.settings.shipping = deepMerge(DEFAULT_SETTINGS.shipping, db.settings.shipping || {});
  // The storefront shipped with the old seed value "usd"; this shop settles in
  // CAD. Migrate once, then leave the admin's choice alone.
  if (!db.settings.currencyMigrated) {
    db.settings.currencyCode = 'cad';
    db.settings.currencyMigrated = true;
  }
  if (!Array.isArray(db.settings.carousel) || !db.settings.carousel.length) db.settings.carousel = DEFAULT_SETTINGS.carousel;

  COLLECTIONS.forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });
  if (!db.views || typeof db.views !== 'object') db.views = {};
  if (!db.counters || typeof db.counters !== 'object') db.counters = { order: 0, invoice: 0 };
  if (!Number.isFinite(db.counters.order)) db.counters.order = 0;
  if (!Number.isFinite(db.counters.invoice)) db.counters.invoice = 0;
  if (!Number.isFinite(db.counters.invoiceYear)) db.counters.invoiceYear = 0;

  db.products.forEach(p => {
    if (!Number.isFinite(p.stock)) p.stock = 0;
    if (!Number.isFinite(p.weightKg)) p.weightKg = 1;
    if (!p.sku) p.sku = String(p.id || '').toUpperCase();
    if (p.active === undefined) p.active = true;
  });
  db.users.forEach(u => {
    if (!u.role) u.role = 'customer';
    if (!Array.isArray(u.paymentMethods)) u.paymentMethods = [];
    if (!Array.isArray(u.addresses)) u.addresses = [];
    u.notifications = u.notifications || [];
  });
  db.orders.forEach(migrateOrder);
  db.carts.forEach(c => { if (!Array.isArray(c.items)) c.items = []; });
  db.invoices.forEach(i => { if (!Number.isFinite(i.totalCents)) i.totalCents = Math.round((i.total || 0) * 100); });
  return db;
}

function freshDb() {
  return migrate({
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    products: [
      { id: 'p1', n: 'Industrial Gate Valve 2"', cat: 'Valves', pr: 120, ic: 'wrench', img: '', d: 'Cast steel, flanged.', stock: 120 },
      { id: 'p2', n: 'Safety Helmet', cat: 'Safety', pr: 15, ic: 'hard-hat', img: '', d: 'Impact-rated, adjustable.', stock: 300 },
      { id: 'p3', n: 'Power Cable 50m', cat: 'Electrical', pr: 85, ic: 'plug', img: '', d: 'Armoured copper cable.', stock: 80 }
    ],
    projects: [], orders: [], quotes: [], messages: [], users: [], staff: [], views: {}
  });
}

let db;
if (fs.existsSync(FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    // Never silently lose the shop: keep a copy of the unreadable file
    fs.copyFileSync(FILE, FILE + '.corrupt-' + Date.now());
    db = freshDb();
  }
} else {
  db = freshDb();
}
migrate(db);

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
save();

// Serialised mutation. Async work inside the callback must not await network
// calls: keep transactions short and side effects (emails, provider calls)
// outside the lock.
let chain = Promise.resolve();
function tx(fn) {
  const run = chain.then(async () => {
    const out = await fn(db);
    save();
    return out;
  });
  chain = run.catch(() => {});
  return run;
}

// Monotonic counter, e.g. order / invoice numbers
function next(k) {
  db.counters[k] = (Number(db.counters[k]) || 0) + 1;
  return db.counters[k];
}

module.exports = { db, save, tx, next, FILE, DIR, DEFAULT_SETTINGS, DEFAULT_TAX };
