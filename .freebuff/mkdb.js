// Builds a test database from data/db.json.bak with stock levels and orders
// spread over the past ~13 months so range filters can be verified.
const fs = require('fs');
const base = JSON.parse(fs.readFileSync('data/db.json.orig', 'utf8'));
const now = Date.now(), day = 864e5;

base.products[0].stock = 120;
base.products[1].stock = 300;
base.products[2].stock = 80;
base.staff = [];
base.users = [];
base.orders = [];

const mk = (daysAgo, lines, paid, status, method, name, email) => ({
  id: 't' + daysAgo,
  date: new Date(now - daysAgo * day - 3600e3).toISOString(),
  userId: null, name, phone: '+100000000', email, address: '1 Test St',
  lines, total: lines.reduce((a, l) => a + l.pr * l.qty, 0),
  method, status, paid
});

const L = (id, n, pr, qty) => ({ id, n, pr, qty });

base.orders = [
  mk(2,   [L('p1', 'Industrial Gate Valve 2"', 120, 2)], true,  'paid',      'card', 'Alice Adams', 'alice@test.dev'),
  mk(10,  [L('p2', 'Safety Helmet', 15, 5), L('p3', 'Power Cable 50m', 85, 1)], false, 'new', 'cod', 'Bob Brown', 'bob@test.dev'),
  mk(40,  [L('p3', 'Power Cable 50m', 85, 3)], true,  'delivered', 'bank', 'Carol Clark', 'carol@test.dev'),
  mk(120, [L('p1', 'Industrial Gate Valve 2"', 120, 1)], false, 'confirmed', 'cod', 'Dave Davis', 'dave@test.dev'),
  mk(200, [L('p2', 'Safety Helmet', 15, 10)], true, 'delivered', 'card', 'Eve Ellis', 'eve@test.dev'),
  mk(400, [L('p3', 'Power Cable 50m', 85, 2)], true, 'delivered', 'cod', 'Frank Foster', 'frank@test.dev')
];

const target = process.env.DB_FILE || 'data/db.json';
fs.writeFileSync(target, JSON.stringify(base));
console.log('TEST_DB_WRITTEN ' + target + ' orders=' + base.orders.length);
