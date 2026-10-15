// Node.js + Express backend. Data is stored in data/db.json (swap for PostgreSQL/SQLite when you grow).
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { PORT = 3000, ADMIN_PASSWORD, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL } = process.env;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
if (!ADMIN_PASSWORD) console.warn('! ADMIN_PASSWORD is not set: admin login is disabled.');
if (!process.env.SECRET) console.warn('! SECRET is not set: logins reset on every restart.');

// ---------- tiny database ----------
const FILE = path.join(__dirname, 'data', 'db.json');
const seed = {
  settings: { name: 'Joneli Industries Inc.', logo: '/img/logo.jpg', heroImg: '', hero: 'We engineer the future. We supply what builds it.',
    tag: 'Turnkey project engineering and dependable distribution & procurement, under one roof.',
    about: "Write the company's story, mission and values here.", email: 'info@company.com', phone: '+000 000 000 0000',
    shopEmail: 'sales@company.com', shopPhone: '+000 000 000 0001', addr: 'Your business address', hours: 'Mon–Fri, 8am–5pm',
    cur: '$', currencyCode: 'usd', whatsapp: '', gaId: '', bank: 'Bank: Your Bank | Account name: Joneli Industries Inc. | Account no: 0000000000' },
  products: [{ id: 'p1', n: 'Industrial Gate Valve 2"', cat: 'Valves', pr: 120, ic: '🔧', img: '', d: 'Cast steel, flanged.', stock: 120 },
    { id: 'p2', n: 'Safety Helmet', cat: 'Safety', pr: 15, ic: '⛑️', img: '', d: 'Impact-rated, adjustable.', stock: 300 },
    { id: 'p3', n: 'Power Cable 50m', cat: 'Electrical', pr: 85, ic: '🔌', img: '', d: 'Armoured copper cable.', stock: 80 }],
  projects: [], orders: [], quotes: [], messages: [], users: [], staff: [], views: {}
};
let db = fs.existsSync(FILE) ? { ...seed, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } : seed;
// Migrate older rows: every product tracks stock, staff list always exists
db.staff = db.staff || [];
db.products.forEach(p => { if (!Number.isFinite(p.stock)) p.stock = 0; });
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); };
const uid = () => crypto.randomBytes(6).toString('hex');
const S = (s, n = 2000) => String(s ?? '').slice(0, n);

// ---------- auth helpers ----------
const mac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const sign = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + mac(b); };
const verify = t => { try { const [b, s] = String(t).split('.'); const a = Buffer.from(s), c = Buffer.from(mac(b));
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null; const o = JSON.parse(Buffer.from(b, 'base64url')); return o.exp > Date.now() ? o : null; } catch { return null; } };
const hashPw = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 64).toString('hex');
const checkPw = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 64)); };
const tokenOf = req => (req.headers.authorization || '').replace('Bearer ', '');
// Roles: 'super' = super admin, 'admin' = admin, 'customer' = customer.
// 'user' is the legacy customer role, accepted wherever 'customer' is required.
const ROLES = { super: ['super'], admin: ['admin', 'super'], customer: ['customer', 'user'], user: ['customer', 'user'] };
const auth = role => (req, res, next) => {
  const o = verify(tokenOf(req));
  if (!o) return res.status(401).json({ error: 'Please sign in' });
  // Staff tokens carry a staff id: their effective role always comes from the
  // live account record, so promote / demote / removal apply immediately.
  if (o.id && (o.role === 'admin' || o.role === 'super')) {
    const s = db.staff.find(x => x.id === o.id);
    if (!s) return res.status(401).json({ error: 'Please sign in' });
    o.role = s.role;
  }
  if (role && !(ROLES[role] || [role]).includes(o.role)) return res.status(401).json({ error: 'Please sign in' });
  req.u = o; next();
};
const optAuth = (req, res, next) => { req.u = verify(tokenOf(req)); next(); };
const app = express();

// ---------- Stripe webhook (needs the raw body, so it comes before express.json) ----------
app.post('/api/stripe-webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.sendStatus(404);
  const sig = Object.fromEntries((req.headers['stripe-signature'] || '').split(',').map(x => x.split('=')));
  const exp = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(sig.t + '.' + req.body).digest('hex');
  if (exp !== sig.v1) return res.sendStatus(400);
  const ev = JSON.parse(req.body);
  if (ev.type === 'checkout.session.completed') { const o = db.orders.find(x => x.id === ev.data.object.metadata?.order); if (o) { o.paid = true; o.status = 'paid'; save(); } }
  res.sendStatus(200);
});
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- public API ----------
app.get('/api/site', (req, res) => res.json({ c: { ...db.settings, card: !!STRIPE_SECRET_KEY }, products: db.products, projects: db.projects }));
app.post('/api/track', (req, res) => { const p = S(req.body.path, 40); if (p && (db.views[p] || Object.keys(db.views).length < 200)) { db.views[p] = (db.views[p] || 0) + 1; save(); } res.json({ ok: 1 }); });
app.post('/api/messages', (req, res) => { const b = req.body; if (b.website) return res.json({ ok: 1 }); // honeypot
  if (!b.name || !b.email || !b.body) return res.status(400).json({ error: 'Name, email and message are required' });
  db.messages.push({ id: uid(), date: new Date().toISOString(), name: S(b.name, 100), email: S(b.email, 150), body: S(b.body) }); save(); res.json({ ok: 1 }); });
app.post('/api/quotes', (req, res) => { const b = req.body; if (b.website) return res.json({ ok: 1 });
  if (!b.name || !(b.email || b.phone) || !b.details) return res.status(400).json({ error: 'Name, a contact and project details are required' });
  db.quotes.push({ id: uid(), date: new Date().toISOString(), name: S(b.name, 100), email: S(b.email, 150), phone: S(b.phone, 40), service: S(b.service, 80), details: S(b.details), status: 'new' }); save(); res.json({ ok: 1 }); });

// customer accounts (role: customer)
const userOut = u => ({ id: u.id, name: u.name, email: u.email, role: u.role || 'customer' });
const userTok = u => sign({ role: u.role || 'customer', id: u.id, exp: Date.now() + 30 * 864e5 });
app.post('/api/auth/register', (req, res) => { const { name, email, password } = req.body; const e = S(email, 150).toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(e) || S(password).length < 8) return res.status(400).json({ error: 'Name, valid email and a password of 8+ characters are required' });
  if (db.users.find(u => u.email === e)) return res.status(400).json({ error: 'That email is already registered' });
  const u = { id: uid(), name: S(name, 100), email: e, pw: hashPw(S(password, 200)), role: 'customer' }; db.users.push(u); save(); res.json({ token: userTok(u), user: userOut(u) }); });
app.post('/api/auth/login', (req, res) => { const u = db.users.find(x => x.email === S(req.body.email, 150).toLowerCase());
  if (!u || !checkPw(S(req.body.password, 200), u.pw)) return res.status(401).json({ error: 'Wrong email or password' }); res.json({ token: userTok(u), user: userOut(u) }); });
app.get('/api/me/orders', auth('customer'), (req, res) => res.json(db.orders.filter(o => o.userId === req.u.id).reverse()));

// orders (prices are always re-read from the database, never trusted from the browser)
app.post('/api/orders', optAuth, async (req, res) => {
  const b = req.body; if (!b.name || !b.phone || !Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Name, phone and items are required' });
  const lines = []; for (const i of b.items.slice(0, 100)) { const p = db.products.find(x => x.id === i.id); if (p) lines.push({ id: p.id, n: p.n, pr: p.pr, qty: Math.max(1, Math.min(999, parseInt(i.qty) || 1)) }); }
  if (!lines.length) return res.status(400).json({ error: 'No valid items' });
  // Stock on hand goes down as orders come in (never below zero)
  for (const l of lines) { const p = db.products.find(x => x.id === l.id); if (p) p.stock = Math.max(0, (Number.isFinite(p.stock) ? p.stock : 0) - l.qty); }
  const method = ['cod', 'bank', 'card'].includes(b.method) ? b.method : 'cod';
  const o = { id: uid(), date: new Date().toISOString(), userId: req.u?.id || null, name: S(b.name, 100), phone: S(b.phone, 40), email: S(b.email, 150), address: S(b.address, 300),
    lines, total: lines.reduce((a, l) => a + l.pr * l.qty, 0), method, status: 'new', paid: false };
  db.orders.push(o); save();
  if (method === 'card' && STRIPE_SECRET_KEY) {
    try { const base = SITE_URL || `${req.protocol}://${req.get('host')}`;
      const f = new URLSearchParams({ mode: 'payment', success_url: base + '/#/thanks', cancel_url: base + '/#/cart', 'metadata[order]': o.id });
      lines.forEach((l, i) => { f.append(`line_items[${i}][quantity]`, l.qty); f.append(`line_items[${i}][price_data][currency]`, db.settings.currencyCode || 'usd');
        f.append(`line_items[${i}][price_data][unit_amount]`, Math.round(l.pr * 100)); f.append(`line_items[${i}][price_data][product_data][name]`, l.n); });
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: f });
      const j = await r.json(); if (j.url) return res.json({ ok: 1, id: o.id, url: j.url });
    } catch (e) { console.error('Stripe error', e.message); }
  }
  res.json({ ok: 1, id: o.id });
});

// ---------- admin API ----------
const tries = {};
const pwOk = (p, h) => { try { return !!h && checkPw(p, h); } catch { return false; } };
const staffOut = s => ({ id: s.id, name: s.name, email: s.email, role: s.role });
// Two ways in: a staff email+password (role admin/super), or the master key
// (ADMIN_PASSWORD) which always signs a super admin token.
app.post('/api/admin/login', (req, res) => { const t = tries[req.ip] = (tries[req.ip] || []).filter(x => Date.now() - x < 9e5);
  if (t.length >= 8) return res.status(429).json({ error: 'Too many attempts. Try again later.' }); t.push(Date.now());
  const pw = S(req.body.password, 200);
  const email = S(req.body.email, 150).toLowerCase();
  if (email) {
    const s = db.staff.find(x => x.email === email);
    if (!s || !pwOk(pw, s.pw)) return res.status(401).json({ error: 'Wrong email or password' });
    tries[req.ip] = [];
    return res.json({ token: sign({ role: s.role, id: s.id, name: s.name, exp: Date.now() + 864e5 }), role: s.role, name: s.name });
  }
  const ok = ADMIN_PASSWORD && Buffer.from(pw).equals(Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  tries[req.ip] = [];
  res.json({ token: sign({ role: 'super', exp: Date.now() + 864e5 }), role: 'super', name: 'Super admin' }); });
const A = auth('admin');
const AS = auth('super');
app.get('/api/admin/data', A, (req, res) => res.json({ role: req.u.role, orders: [...db.orders].reverse(), quotes: [...db.quotes].reverse(), messages: [...db.messages].reverse(), views: db.views, users: db.users.length, staff: db.staff.map(staffOut) }));

// Staff accounts (super admin only)
const superCount = () => db.staff.filter(x => x.role === 'super').length + (ADMIN_PASSWORD ? 1 : 0);
app.get('/api/admin/staff', AS, (req, res) => res.json(db.staff.map(staffOut)));
app.post('/api/admin/staff', AS, (req, res) => {
  const b = req.body; const e = S(b.email, 150).toLowerCase();
  if (!b.name || !/^\S+@\S+\.\S+$/.test(e) || S(b.password).length < 8) return res.status(400).json({ error: 'Name, valid email and a password of 8+ characters are required' });
  if (db.staff.find(x => x.email === e) || db.users.find(x => x.email === e)) return res.status(400).json({ error: 'That email is already registered' });
  const s = { id: uid(), name: S(b.name, 100), email: e, pw: hashPw(S(b.password, 200)), role: b.role === 'super' ? 'super' : 'admin' };
  db.staff.push(s); save(); res.json(staffOut(s)); });
app.patch('/api/admin/staff/:id', AS, (req, res) => {
  const s = db.staff.find(x => x.id === req.params.id); if (!s) return res.sendStatus(404);
  const role = req.body.role;
  if (role !== 'admin' && role !== 'super') return res.status(400).json({ error: 'Role must be admin or super' });
  if (s.role === 'super' && role === 'admin' && superCount() <= 1) return res.status(400).json({ error: 'At least one super admin must remain' });
  s.role = role; save(); res.json(staffOut(s)); });
app.delete('/api/admin/staff/:id', AS, (req, res) => {
  const s = db.staff.find(x => x.id === req.params.id); if (!s) return res.sendStatus(404);
  if (s.role === 'super' && superCount() <= 1) return res.status(400).json({ error: 'At least one super admin must remain' });
  db.staff = db.staff.filter(x => x.id !== s.id); save(); res.json({ ok: 1 }); });
app.put('/api/admin/settings', A, (req, res) => { for (const k of Object.keys(db.settings)) if (k in req.body) db.settings[k] = S(req.body[k], 2e6); save(); res.json({ ok: 1 }); });
const pick = { products: o => ({ id: S(o.id, 20) || uid(), n: S(o.n, 150), cat: S(o.cat, 60) || 'General', pr: Number(o.pr), ic: S(o.ic, 8) || '📦', img: S(o.img, 2e6), d: S(o.d, 500), stock: Math.max(0, parseInt(o.stock, 10) || 0) }),
  projects: o => ({ id: S(o.id, 20) || uid(), t: S(o.t, 150), d: S(o.d, 500), img: S(o.img, 2e6) }) };
for (const k of Object.keys(pick)) {
  app.put('/api/admin/' + k, A, (req, res) => { const o = pick[k](req.body); if (!o.n && !o.t) return res.status(400).json({ error: 'Title is required' });
    if (k === 'products' && !(o.pr >= 0)) return res.status(400).json({ error: 'Valid price required' });
    const i = db[k].findIndex(x => x.id === o.id); i < 0 ? db[k].push(o) : (db[k][i] = o); save(); res.json(o); });
  app.delete('/api/admin/' + k + '/:id', A, (req, res) => { db[k] = db[k].filter(x => x.id !== req.params.id); save(); res.json({ ok: 1 }); });
}
app.patch('/api/admin/orders/:id', A, (req, res) => { const o = db.orders.find(x => x.id === req.params.id); if (!o) return res.sendStatus(404);
  if (req.body.status) o.status = S(req.body.status, 20); if ('paid' in req.body) o.paid = !!req.body.paid; save(); res.json(o); });
app.patch('/api/admin/quotes/:id', A, (req, res) => { const o = db.quotes.find(x => x.id === req.params.id); if (!o) return res.sendStatus(404); o.status = S(req.body.status, 20); save(); res.json(o); });

// ---------- sales overview + CSV reports ----------
const dayMs = 864e5;
const RANGES = {
  '7d':   ['Past 7 days', 7],
  '30d':  ['Past 30 days', 30],
  '90d':  ['Past 3 months', 90],
  '180d': ['Past 6 months', 180],
  '365d': ['Past 12 months', 365]
};
const dayStr = t => new Date(t).toISOString().slice(0, 10);

// Resolve ?range=7d|30d|90d|180d|365d|all  or  ?from=YYYY-MM-DD&to=YYYY-MM-DD
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

// Everything the dashboard and the CSV report need for a period
function salesData(from, to, label) {
  const inRange = o => { const t = Date.parse(o.date); return !isNaN(t) && (from === null || t >= from) && t <= to; };
  const orders = db.orders.filter(inRange);
  const revenue    = orders.reduce((a, o) => a + (+o.total || 0), 0);
  const paid       = orders.filter(o => o.paid).reduce((a, o) => a + (+o.total || 0), 0);
  const units      = orders.reduce((a, o) => a + (o.lines || []).reduce((x, l) => x + (l.qty || 0), 0), 0);
  const byStatus = {}, byMethod = {};
  orders.forEach(o => {
    const st = o.status || 'new', m = o.method || 'cod';
    byStatus[st] = (byStatus[st] || 0) + 1;
    byMethod[m]  = (byMethod[m] || 0) + 1;
  });

  // Units sold & revenue per product (every product listed, sold or not)
  const sold = {};
  orders.forEach(o => (o.lines || []).forEach(l => {
    sold[l.id] = sold[l.id] || { qty: 0, revenue: 0 };
    sold[l.id].qty += l.qty || 0;
    sold[l.id].revenue += (l.pr || 0) * (l.qty || 0);
  }));
  const products = db.products.map(p => {
    const s = sold[p.id] || { qty: 0, revenue: 0 };
    const stock = Number.isFinite(p.stock) ? p.stock : 0;
    return { id: p.id, name: p.n, cat: p.cat, price: p.pr, qty: s.qty, revenue: s.revenue, stock, stockValue: stock * p.pr };
  }).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name));

  // Time series: day buckets up to 45 days, weekly up to ~10 months, then monthly
  const first = from !== null ? from
    : (orders.length ? Math.min(...orders.map(o => Date.parse(o.date))) : to);
  const spanDays = Math.max(1, Math.ceil((to - first) / dayMs));
  const bucket = spanDays <= 45 ? 1 : spanDays <= 320 ? 7 : 30;
  const step = bucket * dayMs;
  const series = [], idx = new Map();
  for (let t = Math.floor(first / step) * step; t <= to && series.length < 400; t += step) {
    const e = { label: dayStr(t), orders: 0, revenue: 0, units: 0 };
    idx.set(t, e); series.push(e);
  }
  orders.forEach(o => {
    const t = Date.parse(o.date);
    const e = idx.get(Math.floor(t / step) * step);
    if (e) { e.orders++; e.revenue += +o.total || 0; e.units += (o.lines || []).reduce((x, l) => x + (l.qty || 0), 0); }
  });

  // Flattened line-item rows — reused by the CSV report
  const rows = [];
  orders.forEach(o => {
    const base = { id: o.id, date: o.date, name: o.name, email: o.email, phone: o.phone,
                   method: o.method, paid: o.paid ? 'yes' : 'no', status: o.status, total: o.total };
    const ls = o.lines || [];
    if (!ls.length) rows.push({ ...base, product: '', qty: '', pr: '', lineTotal: '' });
    ls.forEach(l => rows.push({ ...base, product: l.n, qty: l.qty, pr: l.pr, lineTotal: (l.pr || 0) * (l.qty || 0) }));
  });

  const recent = [...orders].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 10)
    .map(o => ({ id: o.id, date: o.date, name: o.name, total: o.total, paid: !!o.paid, status: o.status, method: o.method,
                 items: (o.lines || []).reduce((a, l) => a + (l.qty || 0), 0) }));

  return {
    label, from: from !== null ? dayStr(from) : '', to: dayStr(to),
    kpis: {
      orders: orders.length, revenue, paid, outstanding: revenue - paid, units,
      avg: orders.length ? revenue / orders.length : 0,
      customers: new Set(orders.map(o => (o.email || o.name || '').toLowerCase()).filter(Boolean)).size,
      stockUnits: products.reduce((a, p) => a + p.stock, 0),
      stockValue: products.reduce((a, p) => a + p.stockValue, 0)
    },
    byStatus, byMethod, products, series, recent, rows
  };
}

app.get('/api/admin/sales', A, (req, res) => {
  const r = salesRange(req.query);
  const d = salesData(r.from, r.to, r.label);
  delete d.rows;                                   // rows are only for the CSV
  res.json({ ...d, range: r.key });
});

// CSV report for the selected period (attachment download)
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

app.use((err, req, res, next) => res.status(400).json({ error: 'Bad request' }));
app.listen(PORT, () => console.log('Site running on http://localhost:' + PORT));
