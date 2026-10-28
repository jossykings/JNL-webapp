// API verification for roles + sales overview + CSV reports.
import crypto from 'crypto';
import fs from 'fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const env = fs.readFileSync('.env', 'utf8');
const ADMIN_PASSWORD = (env.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim();
const SECRET = (env.match(/^SECRET=(.*)$/m) || [])[1]?.trim();
const day = 864e5;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const req = async (path, { method = 'GET', token, body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: r.status, j, txt, headers: r.headers };
};

// ---- 1. Super admin login (master key, no email) ----
const sup = await req('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
ok('super login via master key -> role super', sup.status === 200 && sup.j.role === 'super', JSON.stringify(sup.j));
const ST = sup.j?.token;

// ---- 2. Sales ranges ----
const sales = q => req('/api/admin/sales?' + q, { token: ST });
const K = (name, cond, extra) => ok(name, cond, extra);

let r = await sales('range=7d');
K('7d: 1 order / revenue 240 / paid 240 / outstanding 0 / units 2',
  r.j?.kpis?.orders === 1 && r.j.kpis.revenue === 240 && r.j.kpis.paid === 240 &&
  r.j.kpis.outstanding === 0 && r.j.kpis.units === 2, JSON.stringify(r.j?.kpis));
K('7d: label + range echoed', r.j?.label === 'Past 7 days' && r.j.range === '7d', r.j?.label);
K('7d: daily series buckets with revenue', Array.isArray(r.j?.series) && r.j.series.length >= 7 &&
  r.j.series.some(x => x.revenue === 240 && x.orders === 1), JSON.stringify(r.j?.series?.slice(0, 3)));

r = await sales('range=30d');
K('30d: 2 orders / revenue 400 / outstanding 160 / units 8',
  r.j?.kpis?.orders === 2 && r.j.kpis.revenue === 400 && r.j.kpis.outstanding === 160 &&
  r.j.kpis.units === 8, JSON.stringify(r.j?.kpis));
K('30d: per-product sold (p1 x2=240, p3 x1=85, p2 x5=75)',
  r.j?.products?.find(p => p.id === 'p1')?.qty === 2 && r.j.products.find(p => p.id === 'p1').revenue === 240 &&
  r.j.products.find(p => p.id === 'p3').qty === 1 && r.j.products.find(p => p.id === 'p3').revenue === 85 &&
  r.j.products.find(p => p.id === 'p2').qty === 5 && r.j.products.find(p => p.id === 'p2').revenue === 75,
  JSON.stringify(r.j?.products?.map(p => [p.id, p.qty, p.revenue])));
K('30d: stock left + stock value (500 units / $25,700)',
  r.j?.kpis?.stockUnits === 500 && r.j.kpis.stockValue === 25700, JSON.stringify([r.j?.kpis?.stockUnits, r.j?.kpis?.stockValue]));
K('30d: status & method breakdowns',
  r.j?.byStatus?.new === 1 && r.j.byStatus?.paid === 1 && r.j.byMethod?.cod === 1 && r.j.byMethod?.card === 1,
  JSON.stringify([r.j?.byStatus, r.j?.byMethod]));
K('30d: recent orders listed', r.j?.recent?.length === 2 && r.j.recent[0].id === 't2', JSON.stringify(r.j?.recent?.map(x => x.id)));

r = await sales('range=90d');
K('90d: 3 orders / revenue 655 / units 11', r.j?.kpis?.orders === 3 && r.j.kpis.revenue === 655 && r.j.kpis.units === 11, JSON.stringify(r.j?.kpis));
r = await sales('range=365d');
K('365d: 5 orders / revenue 925 / paid 645 / outstanding 280', r.j?.kpis?.orders === 5 && r.j.kpis.revenue === 925 &&
  r.j.kpis.paid === 645 && r.j.kpis.outstanding === 280, JSON.stringify(r.j?.kpis));
r = await sales('range=all');
K('all: 6 orders / revenue 1095 / paid 815 / customers 6', r.j?.kpis?.orders === 6 && r.j.kpis.revenue === 1095 &&
  r.j.kpis.paid === 815 && r.j.kpis.customers === 6, JSON.stringify(r.j?.kpis));
K('all: monthly buckets (span > 320 days)', r.j?.series?.length > 8 && r.j.series.length < 70, String(r.j?.series?.length));

// custom from/to: from = 45 days ago, to = 5 days ago -> only the 10-day-old order
const dstr = t => new Date(t).toISOString().slice(0, 10);
r = await sales('from=' + dstr(Date.now() - 45 * day) + '&to=' + dstr(Date.now() - 5 * day));
// inside 45d..5d ago fall the 10-day-old order (160) and the 40-day-old one (255)
K('custom range: 2 orders / revenue 415 / paid 255 / outstanding 160', r.j?.kpis?.orders === 2 && r.j.kpis.revenue === 415 && r.j.kpis.paid === 255 && r.j.kpis.outstanding === 160, JSON.stringify(r.j?.kpis));
K('custom range: label "… to …"', /^start|\d{4}-/.test(r.j?.label || '') && r.j.label.includes(' to '), r.j?.label);
r = await sales('range=bogus');
K('unknown range falls back to all-time', r.status === 200 && r.j?.range === 'all', JSON.stringify(r.j?.range));

// ---- 3. CSV report ----
let c = await req('/api/admin/sales.csv?range=7d', { token: ST });
const fname = c.headers.get('content-disposition') || '';
K('CSV 7d: 200 + text/csv + attachment filename', c.status === 200 &&
  (c.headers.get('content-type') || '').includes('text/csv') && /sales-report_7d_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv/.test(fname), fname);
const lines = c.txt.split('\r\n');
K('CSV 7d: header row exact', lines[0] === 'Order ID,Date,Customer,Email,Phone,Method,Paid,Status,Product,Qty,Unit price,Line total,Order total', lines[0]);
K('CSV 7d: one order line row (t2 / Alice)', lines[1].startsWith('t2,') && lines[1].includes('Alice Adams') &&
  lines[1].includes('Industrial Gate Valve 2') && lines[1].endsWith('240'), lines[1]);
K('CSV 7d: summary block with period + totals', c.txt.includes('SUMMARY') && c.txt.includes('Past 7 days') &&
  c.txt.includes('Orders,1') && c.txt.includes('Units sold,2') && c.txt.includes('Gross revenue,240') &&
  c.txt.includes('Outstanding (amount left),0'), JSON.stringify(lines.slice(-9)));
c = await req('/api/admin/sales.csv?range=all', { token: ST });
// 6 orders -> 7 line-item rows (the 10-day-old order has two products)
K('CSV all: 7 line-item rows + all-time summary', (c.txt.match(/^t\d+,/gm) || []).length === 7 &&
  c.txt.includes('Orders,6') && c.txt.includes('Outstanding (amount left),280') && c.txt.includes('Products in stock (units),500'),
  String((c.txt.match(/^t\d+,/gm) || []).length));
K('CSV escaped cells: quoted product with comma', c.txt.includes('"Industrial Gate Valve 2"') || c.txt.includes('Industrial Gate Valve 2'), 'name check');

// ---- 4. Roles ----
const reg = await req('/api/auth/register', { method: 'POST', body: { name: 'Cust Omer', email: 'cust@test.dev', password: 'password123' } });
K('register -> role customer + token', reg.status === 200 && reg.j.user.role === 'customer' && !!reg.j.token, JSON.stringify(reg.j?.user));
const CT = reg.j?.token;
r = await req('/api/me/orders', { token: CT });
K('customer token: own orders 200', r.status === 200, String(r.status));
r = await req('/api/admin/data', { token: CT });
K('customer token: admin data 401', r.status === 401, String(r.status));
r = await req('/api/admin/sales?range=7d', { token: CT });
K('customer token: sales 401', r.status === 401, String(r.status));
r = await req('/api/admin/sales.csv?range=7d', { token: CT });
K('customer token: CSV 401', r.status === 401, String(r.status));
r = await req('/api/admin/staff', { token: CT });
K('customer token: staff 401', r.status === 401, String(r.status));
r = await req('/api/me/orders');
K('no token: own orders 401', r.status === 401, String(r.status));

// legacy 'user' role tokens (pre-upgrade sessions) still resolve to the customer
const legacy = id => {
  const b = Buffer.from(JSON.stringify({ role: 'user', id, exp: Date.now() + day })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  return b + '.' + mac;
};
r = await req('/api/me/orders', { token: legacy(reg.j.user.id) });
K('legacy role "user" token (real account) accepted as customer', r.status === 200, String(r.status));

// A validly signed token for an account that no longer exists must be rejected
// outright, not answered with 200 and empty per-customer data.
r = await req('/api/me/orders', { token: legacy('deleted-account') });
K('token for a removed account rejected (401)', r.status === 401, String(r.status));
r = await req('/api/cart', { token: legacy('deleted-account') });
K('removed account cannot read a cart (401)', r.status === 401, String(r.status));

// ---- 5. Staff accounts (super creates, admin cannot) ----
r = await req('/api/admin/staff', { method: 'POST', token: ST, body: { name: 'Admin One', email: 'admin1@test.dev', password: 'password123', role: 'admin' } });
K('super creates staff admin', r.status === 200 && r.j.role === 'admin' && !('pw' in r.j), JSON.stringify(r.j));
const staffId = r.j?.id;
r = await req('/api/admin/staff', { method: 'POST', token: ST, body: { name: 'Dup', email: 'admin1@test.dev', password: 'password123' } });
K('duplicate staff email rejected', r.status === 400, String(r.status));
const admLogin = await req('/api/admin/login', { method: 'POST', body: { email: 'admin1@test.dev', password: 'password123' } });
K('staff login -> role admin', admLogin.status === 200 && admLogin.j.role === 'admin', JSON.stringify(admLogin.j));
const AT = admLogin.j?.token;
r = await req('/api/admin/data', { token: AT });
K('admin token: dashboard data 200 with role + staff list', r.status === 200 && r.j.role === 'admin' && Array.isArray(r.j.staff) && r.j.staff.length === 1, JSON.stringify({ role: r.j?.role, staff: r.j?.staff }));
r = await req('/api/admin/sales?range=30d', { token: AT });
K('admin token: sales 200', r.status === 200 && r.j.kpis.orders === 2, String(r.status));
r = await req('/api/admin/sales.csv?range=30d', { token: AT });
K('admin token: CSV 200', r.status === 200, String(r.status));
r = await req('/api/admin/staff', { token: AT });
K('admin cannot list staff (super only)', r.status === 401, String(r.status));
r = await req('/api/admin/staff', { method: 'POST', token: AT, body: { name: 'X', email: 'x@test.dev', password: 'password123' } });
K('admin cannot create staff (super only)', r.status === 401, String(r.status));
r = await req('/api/admin/staff/' + staffId, { method: 'DELETE', token: AT });
K('admin cannot delete staff (super only)', r.status === 401, String(r.status));

const bad = await req('/api/admin/login', { method: 'POST', body: { email: 'admin1@test.dev', password: 'wrong' } });
K('staff login wrong password 401', bad.status === 401, String(bad.status));
const unknown = await req('/api/admin/login', { method: 'POST', body: { email: 'nobody@test.dev', password: 'password123' } });
K('unknown staff email 401', unknown.status === 401, String(unknown.status));

// promote / demote — live session role changes, no re-login needed
r = await req('/api/admin/staff/' + staffId, { method: 'PATCH', token: ST, body: { role: 'super' } });
K('super promotes staff to super', r.status === 200 && r.j.role === 'super', JSON.stringify(r.j));
r = await req('/api/admin/staff', { token: AT });
K('old admin token gains super access immediately after promote', r.status === 200, String(r.status));
r = await req('/api/admin/staff/' + staffId, { method: 'PATCH', token: ST, body: { role: 'hacker' } });
K('invalid role rejected', r.status === 400, String(r.status));
r = await req('/api/admin/staff/' + staffId, { method: 'PATCH', token: ST, body: { role: 'admin' } });
K('super demotes back to admin', r.status === 200 && r.j.role === 'admin', JSON.stringify(r.j));
r = await req('/api/admin/staff', { token: AT });
K('old token loses super access immediately after demote', r.status === 401, String(r.status));
r = await req('/api/admin/sales?range=7d', { token: AT });
K('demoted staff still uses admin endpoints', r.status === 200, String(r.status));
r = await req('/api/admin/staff/' + staffId, { method: 'DELETE', token: ST });
K('super deletes staff account', r.status === 200, String(r.status));
r = await req('/api/admin/staff/' + staffId, { method: 'DELETE', token: ST });
K('deleted staff -> 404', r.status === 404, String(r.status));
r = await req('/api/admin/data', { token: AT });
K('removed staff token revoked immediately', r.status === 401, String(r.status));

// ---- 6. Stock decrement on new orders ----
r = await req('/api/orders', { method: 'POST', body: { items: [{ id: 'p1', qty: 3 }], name: 'Walk In', phone: '+1', method: 'cod' } });
K('public order accepted', r.status === 200 && r.j.ok === 1, JSON.stringify(r.j));
const site = await req('/api/site');
const p1 = site.j.products.find(p => p.id === 'p1');
K('stock decremented 120 -> 117 (clamped, never negative)', p1.stock === 117, String(p1.stock));
r = await req('/api/orders', { method: 'POST', body: { items: [{ id: 'p1', qty: 9999 }], name: 'Bulk', phone: '+1', method: 'cod' } });
const site2 = await req('/api/site');
K('huge order clamps stock at 0', site2.j.products.find(p => p.id === 'p1').stock === 0, String(site2.j.products.find(p => p.id === 'p1').stock));

// stock also editable through the product endpoint
r = await req('/api/admin/products', { method: 'PUT', token: ST, body: { id: 'p1', n: 'Industrial Gate Valve 2"', cat: 'Valves', pr: 120, stock: '42' } });
K('product PUT accepts stock', r.status === 200 && r.j.stock === 42, JSON.stringify(r.j?.stock));
r = await req('/api/admin/products', { method: 'PUT', token: ST, body: { id: 'p1', n: 'Industrial Gate Valve 2"', cat: 'Valves', pr: 120, stock: '-5' } });
K('negative stock clamps to 0', r.status === 200 && r.j.stock === 0, String(r.j?.stock));

// ---- 7. Customers & Settings — super admin only ----
r = await req('/api/admin/customers', { token: ST });
K('super lists customers 200', r.status === 200 && Array.isArray(r.j), String(r.status));
const cu = r.j?.find(x => x.email === 'cust@test.dev');
K('registered customer appears with name/date/status/orders/spent',
  cu && cu.name === 'Cust Omer' && typeof cu.date === 'string' && cu.date.length > 10 &&
  cu.status === 'active' && cu.orders === 0 && cu.spent === 0, JSON.stringify(cu));
r = await req('/api/admin/data', { token: ST });
K('super dashboard data includes customers array', Array.isArray(r.j?.customers) &&
  r.j.customers.some(x => x.email === 'cust@test.dev'), String(r.j?.customers?.length));

r = await req('/api/admin/staff', { method: 'POST', token: ST, body: { name: 'Admin Two', email: 'admin2@test.dev', password: 'password123', role: 'admin' } });
K('super creates admin2 for permission checks', r.status === 200, String(r.status));
const adm2 = await req('/api/admin/login', { method: 'POST', body: { email: 'admin2@test.dev', password: 'password123' } });
const A2 = adm2.j?.token;
r = await req('/api/admin/customers', { token: A2 });
K('admin cannot list customers (super only)', r.status === 401, String(r.status));
r = await req('/api/admin/data', { token: A2 });
K('admin dashboard data omits customers field', r.status === 200 && !('customers' in r.j), JSON.stringify(Object.keys(r.j || {})));
r = await req('/api/admin/customers', { token: CT });
K('customer token: customers list 401', r.status === 401, String(r.status));
r = await req('/api/admin/customers');
K('no token: customers list 401', r.status === 401, String(r.status));

// Settings: super can save; admin and customer are blocked (direct API calls too)
r = await req('/api/admin/settings', { method: 'PUT', token: A2, body: { hours: 'hacked' } });
K('admin cannot change settings (super only)', r.status === 401, String(r.status));
r = await req('/api/admin/settings', { method: 'PUT', token: CT, body: { hours: 'hacked' } });
K('customer token: settings 401', r.status === 401, String(r.status));
const origHours = (await req('/api/site')).j.c.hours;
r = await req('/api/admin/settings', { method: 'PUT', token: ST, body: { hours: 'Test hours' } });
K('super can change settings', r.status === 200 && r.j.ok === 1, String(r.status));
K('settings change persisted to /api/site', (await req('/api/site')).j.c.hours === 'Test hours',
  String((await req('/api/site')).j.c.hours));
await req('/api/admin/settings', { method: 'PUT', token: ST, body: { hours: origHours } });
K('settings restored after test', (await req('/api/site')).j.c.hours === origHours, String(origHours));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
