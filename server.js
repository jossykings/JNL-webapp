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
  products: [{ id: 'p1', n: 'Industrial Gate Valve 2"', cat: 'Valves', pr: 120, ic: '🔧', img: '', d: 'Cast steel, flanged.' },
    { id: 'p2', n: 'Safety Helmet', cat: 'Safety', pr: 15, ic: '⛑️', img: '', d: 'Impact-rated, adjustable.' },
    { id: 'p3', n: 'Power Cable 50m', cat: 'Electrical', pr: 85, ic: '🔌', img: '', d: 'Armoured copper cable.' }],
  projects: [], orders: [], quotes: [], messages: [], users: [], views: {}
};
let db = fs.existsSync(FILE) ? { ...seed, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } : seed;
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
const auth = role => (req, res, next) => { const o = verify(tokenOf(req)); if (!o || (role && o.role !== role)) return res.status(401).json({ error: 'Please sign in' }); req.u = o; next(); };
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

// customer accounts
const userOut = u => ({ id: u.id, name: u.name, email: u.email });
const userTok = u => sign({ role: 'user', id: u.id, exp: Date.now() + 30 * 864e5 });
app.post('/api/auth/register', (req, res) => { const { name, email, password } = req.body; const e = S(email, 150).toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(e) || S(password).length < 8) return res.status(400).json({ error: 'Name, valid email and a password of 8+ characters are required' });
  if (db.users.find(u => u.email === e)) return res.status(400).json({ error: 'That email is already registered' });
  const u = { id: uid(), name: S(name, 100), email: e, pw: hashPw(S(password, 200)) }; db.users.push(u); save(); res.json({ token: userTok(u), user: userOut(u) }); });
app.post('/api/auth/login', (req, res) => { const u = db.users.find(x => x.email === S(req.body.email, 150).toLowerCase());
  if (!u || !checkPw(S(req.body.password, 200), u.pw)) return res.status(401).json({ error: 'Wrong email or password' }); res.json({ token: userTok(u), user: userOut(u) }); });
app.get('/api/me/orders', auth('user'), (req, res) => res.json(db.orders.filter(o => o.userId === req.u.id).reverse()));

// orders (prices are always re-read from the database, never trusted from the browser)
app.post('/api/orders', optAuth, async (req, res) => {
  const b = req.body; if (!b.name || !b.phone || !Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Name, phone and items are required' });
  const lines = []; for (const i of b.items.slice(0, 100)) { const p = db.products.find(x => x.id === i.id); if (p) lines.push({ id: p.id, n: p.n, pr: p.pr, qty: Math.max(1, Math.min(999, parseInt(i.qty) || 1)) }); }
  if (!lines.length) return res.status(400).json({ error: 'No valid items' });
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
app.post('/api/admin/login', (req, res) => { const t = tries[req.ip] = (tries[req.ip] || []).filter(x => Date.now() - x < 9e5);
  if (t.length >= 8) return res.status(429).json({ error: 'Too many attempts. Try again later.' }); t.push(Date.now());
  const ok = ADMIN_PASSWORD && Buffer.from(S(req.body.password, 200)).equals(Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' }); res.json({ token: sign({ role: 'admin', exp: Date.now() + 864e5 }) }); });
const A = auth('admin');
app.get('/api/admin/data', A, (req, res) => res.json({ orders: [...db.orders].reverse(), quotes: [...db.quotes].reverse(), messages: [...db.messages].reverse(), views: db.views, users: db.users.length }));
app.put('/api/admin/settings', A, (req, res) => { for (const k of Object.keys(db.settings)) if (k in req.body) db.settings[k] = S(req.body[k], 2e6); save(); res.json({ ok: 1 }); });
const pick = { products: o => ({ id: S(o.id, 20) || uid(), n: S(o.n, 150), cat: S(o.cat, 60) || 'General', pr: Number(o.pr), ic: S(o.ic, 8) || '📦', img: S(o.img, 2e6), d: S(o.d, 500) }),
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

app.use((err, req, res, next) => res.status(400).json({ error: 'Bad request' }));
app.listen(PORT, () => console.log('Site running on http://localhost:' + PORT));
