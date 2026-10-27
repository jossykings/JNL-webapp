// =============================================================================
// Frontend: talks to the Node API (see server.js).
// Routes use the URL hash (#/shop, #/cart ...).
//
// Sections
//   1. State & core helpers
//   2. Artwork (SVG)
//   3. Shared UI components
//   4. Public views
//   5. Admin view
//   6. Actions (buttons use data-a="name")
//   7. Event wiring
//   8. Router / render
// =============================================================================


// -----------------------------------------------------------------------------
// 1. STATE & CORE HELPERS
// -----------------------------------------------------------------------------

const $   = s => document.querySelector(s);
const app = $('#app');

// Escape text for safe HTML insertion
const E = s => String(s ?? '').replace(/[&<>"']/g, m => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[m]));

// App state
let S        = { c: {}, products: [], projects: [] };   // site data from the server
let cat      = 'All';                                   // active shop category
let q        = '';                                      // shop search query
let pend     = null;                                    // pending image upload (admin)
let AD       = null;                                    // admin dashboard data
let tab      = 'sales';                                 // active admin tab
let authMode = 'login';                                 // 'login' | 'register'
let SF       = { range: '7d', from: '', to: '' };       // sales report period filter
let SALES    = null;                                    // loaded sales overview
let salesKey = '';                                      // query SALES was loaded for

// --- storefront / commerce state -------------------------------------------
const guestCart = () => { try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch { return []; } };
let cart = guestCart();                                  // [{ id, qty }]
let me   = JSON.parse(localStorage.getItem('me')   || 'null');
let pendingCheckout = false;                             // guest wanted checkout before signing up
let Q = null;                                            // latest server-calculated quote
let CO = null;                                           // checkout form state
let CAR = { i: 0, timer: null, paused: false };          // shop carousel
let acctTab = 'orders';
let ACCT = { orders: null, invoices: null, methods: null, notifications: null };
let AO = null, AI = null, AP = null, AA = null, ADMIN_ORDER = null;
let OF = { q: '', payment: '', fulfillment: '', refund: '', from: '', to: '' };
let theme = 'light';

// Shorthands
const C     = () => S.c;
const money = n  => E(C().cur) + Number(n).toLocaleString();
const moneyC = n => E(C().cur) + (Number(n || 0) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const v     = id => $('#' + id).value;
const atk   = () => sessionStorage.getItem('atk');      // admin token
const tk    = () => localStorage.getItem('tk') || '';

const cartQty = () => cart.reduce((a, l) => a + (Number(l.qty) || 0), 0);
const cartLines = () => cart.map(l => ({ ...l, p: S.products.find(p => p.id === l.id) })).filter(l => l.p);
const cartSubtotal = () => cartLines().reduce((a, l) => a + l.p.pr * l.qty, 0);

// Cart badge everywhere it appears (shop toolbar, cart page). The accessible
// name is refreshed too, so screen readers never announce a stale count.
const badge = () => {
  const n = cartQty();
  document.querySelectorAll('[data-cart-count]').forEach(el => { el.textContent = n; });
  document.querySelectorAll('.cartbtn').forEach(el => {
    el.setAttribute('aria-label', `Cart: ${n} item${n === 1 ? '' : 's'}`);
  });
};

async function loadCart() {
  if (me) {
    try { const r = await api('/cart'); cart = r.items || []; }
    catch { cart = guestCart(); }
  } else cart = guestCart();
  badge();
}

const saveCart = () => {
  if (me) api('/cart', { method: 'PUT', body: { items: cart } }).catch(() => { });
  else localStorage.setItem('cart', JSON.stringify(cart));
  badge();
};

// Human labels for the two independent order lifecycles
const PAY_LABEL = { requires_payment: 'Awaiting payment', processing: 'Payment processing', paid: 'Paid', failed: 'Payment failed', cancelled: 'Payment cancelled', refund_pending: 'Refund pending', partially_refunded: 'Partially refunded', refunded: 'Refunded' };
const FUL_LABEL = { unfulfilled: 'Not fulfilled', processing: 'Preparing', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
const payBadge = st => `<span class="badge p-${E(st)}">${E(PAY_LABEL[st] || st)}</span>`;
const fulBadge = st => `<span class="badge f-${E(st)}">${E(FUL_LABEL[st] || st)}</span>`;
const dateStr = iso => iso ? new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

// ---------------------------------------------------------------------------
// Theme: persisted per browser, applied to <html data-theme>
// ---------------------------------------------------------------------------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  const b = $('#tt');
  if (b) {
    const dark = theme === 'dark';
    b.innerHTML = dark ? '<i class="uil uil-sun" aria-hidden="true"></i>' : '<i class="uil uil-moon" aria-hidden="true"></i>';
    b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    b.setAttribute('aria-pressed', String(dark));
  }
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = theme === 'dark' ? '#0b1220' : '#f4f6fb';
}
function initTheme() {
  const saved = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
  theme = saved === 'light' || saved === 'dark' ? saved
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme();
}

// Stripe.js is loaded async; wait for it only when card entry is needed
function stripeReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    (function poll() {
      if (window.Stripe) return resolve(window.Stripe);
      if (n++ > 100) return reject(new Error('The secure card form could not load. Check your connection and retry.'));
      setTimeout(poll, 100);
    })();
  });
}

// Authenticated file download (invoices / reports) as a blob
async function dlFile(path, fallback = 'document.pdf', admin = false) {
  const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + (admin ? atk() : tk()) } });
  if (!r.ok) {
    if (r.status === 401) throw new Error('Please sign in again');
    throw new Error('That document could not be downloaded');
  }
  const blob = await r.blob();
  const m = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : fallback;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Icon system — Unicons, the open-source set by IconScout (self-hosted in public/vendor/unicons)
const EMOJI_ICON = { '📦': 'package', '🔧': 'wrench', '⛑️': 'hard-hat', '🔌': 'plug',
                     '📐': 'ruler', '⚙️': 'cog', '📋': 'clipboard-notes', '🛠️': 'wrench' };
const icName = v => EMOJI_ICON[v] || (/^[a-z][a-z0-9-]{0,20}$/.test(String(v || '')) ? v : 'package');
const ic = (v, cls) => `<i class="uil uil-${icName(v)}${cls ? ' ' + cls : ''}"></i>`;

// API wrapper (pass admin=true to use the admin token)
async function api(path, opts = {}, admin) {
  const token = admin ? atk() : localStorage.getItem('tk') || '';
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  const r = await fetch('/api' + path, {
    method:  opts.method || 'GET',
    headers,
    body:    opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (admin && r.status === 401) sessionStorage.removeItem('atk');
    const err = new Error(j.error || 'Something went wrong');
    err.status = r.status; err.body = j;
    throw err;
  }
  return j;
}

// Toast notification
const toast = m => {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), 2600);
};

// Downscale an image file and return a JPEG data URL via callback
function shrink(file, max, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width  = im.width  * k;
      c.height = im.height * k;
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', .75));
    };
    im.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Hook a file input to shrink() + callback
const img = (id, max, cb) => {
  const el = $('#' + id);
  if (el) el.onchange = e => e.target.files[0] && shrink(e.target.files[0], max, cb);
};

const load = async () => { S = await api('/site'); };


// -----------------------------------------------------------------------------
// 2. ARTWORK (SVG)
// -----------------------------------------------------------------------------

// Opening <svg> with gradient background (caller closes the </svg>)
const skyline = (id, endColor) => `
  <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${id == 'a1' ? '#10224a' : '#2b1a0c'}"/>
        <stop offset="1" stop-color="${endColor}"/>
      </linearGradient>
    </defs>
    <rect width="800" height="500" fill="url(#${id})"/>`;

// Photography shipped with the site (public/img/)
const PIC = {
  logo:         '/img/logo.jpg',
  tech:         '/img/tech.jpg',          // data globe -> home hero
  design:       '/img/design.jpg',        // design & consulting
  engineers:    '/img/engineers.jpg',     // site team
  construction: '/img/construction.jpg',  // build / crane
  warehouse:    '/img/warehouse.jpg',     // distribution
  logistics:    '/img/logistics.jpg'      // port / procurement
};

const ART = {
  hero: () => `
    <svg class="bg" viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="h" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0b1220"/>
          <stop offset="1" stop-color="#1f3d8f"/>
        </linearGradient>
      </defs>
      <rect width="800" height="500" fill="url(#h)"/>
      <g fill="#fff" fill-opacity=".08">
        <rect x="470" y="260" width="60" height="240"/>
        <rect x="540" y="200" width="80" height="300"/>
        <rect x="630" y="300" width="70" height="200"/>
        <rect x="710" y="240" width="60" height="260"/>
      </g>
      <g stroke="#ff7a1a" stroke-width="3" fill="none">
        <path d="M600 200V40M560 70h180M600 40l-40 30M600 40l140 30M700 70v60"/>
        <path d="M700 130h-8v10h16v-10z" fill="#ff7a1a"/>
      </g>
      <circle cx="120" cy="90" r="160" fill="#ff7a1a" fill-opacity=".08"/>
    </svg>`,

  eng: () => skyline('a1', '#2f6bff') + `
      <g stroke="#ff7a1a" stroke-width="3" fill="none">
        <path d="M300 60V300M230 90h210M300 60l-50 30M300 60l130 30M400 90v70"/>
        <rect x="150" y="300" width="160" height="200" fill="#fff" fill-opacity=".1" stroke="#fff" stroke-opacity=".4"/>
        <rect x="330" y="240" width="110" height="260" fill="#fff" fill-opacity=".1" stroke="#fff" stroke-opacity=".4"/>
      </g>
      <g fill="#ff7a1a" fill-opacity=".8"><circle cx="560" cy="150" r="46"/></g>
      <g stroke="#fff" stroke-opacity=".7" stroke-width="5"><circle cx="560" cy="150" r="30" fill="none"/></g>
    </svg>`,

  shop: () => skyline('a2', '#ff7a1a') + `
      <g fill="#fff" fill-opacity=".14" stroke="#fff" stroke-opacity=".55" stroke-width="2">
        <rect x="120" y="260" width="140" height="120"/>
        <rect x="280" y="260" width="140" height="120"/>
        <rect x="200" y="140" width="140" height="120"/>
        <rect x="460" y="300" width="180" height="80"/>
      </g>
      <g stroke="#fff" stroke-opacity=".5" stroke-width="2">
        <path d="M120 300h140M280 300h140M200 180h140M460 330h180"/>
      </g>
    </svg>`,

  proj: i => `
    <svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="p${i}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${['#12306f', '#ff7a1a', '#0e8f7a'][i]}"/>
          <stop offset="1" stop-color="#0b1220"/>
        </linearGradient>
      </defs>
      <rect width="400" height="200" fill="url(#p${i})"/>
      <g fill="#fff" fill-opacity=".14">
        <rect x="${40 + i * 20}" y="70" width="60" height="130"/>
        <rect x="120" y="40" width="70" height="160"/>
        <rect x="210" y="90" width="60" height="110"/>
        <rect x="290" y="60" width="70" height="140"/>
      </g>
    </svg>`
};


// -----------------------------------------------------------------------------
// 3. SHARED UI COMPONENTS
// -----------------------------------------------------------------------------

// Update header, footer, cart count, WhatsApp link, account label, analytics
const logoHTML = c =>
  '<span class="lg">' + (c.logo ? `<img alt="" src="${E(c.logo)}">` : E((c.name || 'C')[0])) + '</span>' +
  '<span>' + E(c.name) + '</span>';

function brand() {
  const c = C();

  $('#brand').innerHTML = logoHTML(c);
  if ($('#fbrand')) $('#fbrand').innerHTML = logoHTML(c);

  $('#fn').textContent = String(c.name || '').replace(/\.$/, '') + '. All rights reserved.';
  $('#yr').textContent = new Date().getFullYear();
  $('#ft').textContent = (c.email || '') + ' · ' + (c.phone || '');

  // Footer columns
  const fico = (id, icon, txt) => { const el = $('#' + id); if (el) el.innerHTML = txt ? ic(icon) + '<span>' + E(txt) + '</span>' : ''; };
  const fl = $('#fblurb'); if (fl) fl.textContent = c.tag || '';
  fico('fem',   'envelope',       c.email);
  fico('fph',   'phone',          c.phone);
  fico('faddr', 'location-point', c.addr);
  fico('fhrs',  'clock',          c.hours);
  badge();
  if (!document.title.includes('|')) document.title = c.name + ' | Engineering, Distribution & Procurement';

  // Floating WhatsApp button
  const w = $('#wa');
  if (c.whatsapp) {
    w.href = 'https://wa.me/' + c.whatsapp.replace(/\D/g, '') +
             '?text=' + encodeURIComponent('Hello, I have an enquiry.');
    w.classList.remove('hid');
  } else {
    w.classList.add('hid');
  }

  $('#acct').innerHTML = me ? ic('user-circle') + ' ' + E(me.name.split(' ')[0]) : 'Account';

  // Navbar sign-out shows for every signed-in role (customer, admin, super admin)
  $('#outli')?.classList.toggle('hid', !(me || atk()));

  // Google Analytics (loaded once)
  if (c.gaId && !window.gaOn && /^[\w-]+$/.test(c.gaId)) {
    window.gaOn = 1;
    const s = document.createElement('script');
    s.async = 1;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + c.gaId;
    document.head.appendChild(s);
    window.dataLayer = [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', c.gaId);
  }
}

const hero = (headline, tagline, small, buttons, pic) => {
  const bg = C().heroImg || pic || '';
  return `
    <div class="hero ${small ? 's' : ''}" ${bg ? `style="background-image:url('${E(bg)}')"` : ''}>
      ${bg ? '' : ART.hero()}
      <div class="wrap">
        <span class="pill"><i></i>Engineering · Distribution · Procurement</span>
        <h1>${headline}</h1>
        ${tagline ? `<p>${E(tagline)}</p>` : ''}
        ${buttons ? `<div class="hbtns">${buttons}</div>` : ''}
      </div>
      ${small ? '' : '<div class="cue" aria-hidden="true"><span></span></div>'}
    </div>`;
};

const field = (id, placeholder, type = 'text') =>
  `<input id="${id}" type="${type}" placeholder="${placeholder}">`;

const contact = (title, email, phone) => `
  <section id="contact">
    <div class="wrap">
      <span class="eyebrow">Get in touch</span>
      <h2>${title}</h2>
      <p class="sub">Tell us what you need and we'll respond promptly.</p>
      <div class="grid">
        <div class="card">
          <h3>Reach us</h3>
          <p class="clist">
            <span>${ic('envelope')}${E(email)}</span>
            <span>${ic('phone')}${E(phone)}</span>
            <span>${ic('location-point')}${E(C().addr)}</span>
            <span>${ic('clock')}${E(C().hours)}</span>
          </p>
        </div>
        <div class="card">
          <h3>Send a message</h3>
          <div class="f">
            <input id="mn" placeholder="Name">
            <input id="me" placeholder="Your email">
          </div>
          <input id="mw" class="hp" tabindex="-1" autocomplete="off">
          <textarea id="mb" rows="3" placeholder="How can we help?"></textarea>
          <p></p>
          <button class="btn" data-a="msg">Send message</button>
        </div>
      </div>
    </div>
  </section>`;

const aboutSec = () => `
  <section id="about">
    <div class="wrap">
      <div class="grid about" style="align-items:center">
        <div class="rv">
          <span class="eyebrow">About us</span>
          <h2>Built on expertise. Driven by delivery.</h2>
          <p class="sub" style="margin:0 0 26px">${E(C().about)}</p>
          <a class="btn d s" href="#/contact">Work with us</a>
        </div>
        <div class="gal two">
          <div class="shot"><img alt="Engineers reviewing plans on site" src="${PIC.engineers}"></div>
          <div class="shot"><img alt="Engineering design and coordination" src="${PIC.design}"></div>
        </div>
      </div>
    </div>
  </section>`;

const pcard = p => {
  const stock = Number.isFinite(p.stock) ? p.stock : 0;
  return `
  <div class="card pcard">
    <div class="pimg">${p.img ? `<img alt="${E(p.n)}" src="${E(p.img)}" loading="lazy" decoding="async">` : ic(p.ic)}</div>
    <div class="tag">${E(p.cat)}</div>
    <h3>${E(p.n)}</h3>
    <p>${E(p.d)}</p>
    <div class="pmeta">
      <span class="price">${money(p.pr)} <small>CAD</small></span>
      <span class="stock ${stock > 0 ? 'in' : 'out'}">${stock > 0 ? stock + ' in stock' : 'Out of stock'}</span>
    </div>
    ${p.sku ? `<div class="sku">SKU ${E(p.sku)}</div>` : ''}
    <p></p>
    <button class="btn s" data-a="add" data-id="${p.id}" ${stock > 0 ? '' : 'disabled'}>${stock > 0 ? 'Add to cart' : 'Notify me'}</button>
    ${C().whatsapp
      ? `<a class="btn s d" target="_blank" rel="noopener"
            href="https://wa.me/${C().whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent('Hi, I want to order: ' + p.n)}">WhatsApp</a>`
      : ''}
  </div>`;
};


// -----------------------------------------------------------------------------
// 4. PUBLIC VIEWS
// -----------------------------------------------------------------------------

// ---- Home ----
const home = () =>
  hero(
    E(C().hero), C().tag, 0,
    '<a class="btn" href="#/engineering">Project Engineering</a> <a class="btn o" href="#/shop">Visit the Shop</a>',
    PIC.tech
  ) +

  `<div class="strip"><div class="wrap">
     <div><b>15+</b><span class="lbl">Years experience</span></div>
     <div><b>200+</b><span class="lbl">Projects delivered</span></div>
     <div><b>50+</b><span class="lbl">Brands supplied</span></div>
     <div><b>24/7</b><span class="lbl">Support</span></div>
   </div></div>` +

  aboutSec() +

  `<section style="background:var(--card)">
     <div class="wrap rv">
       <span class="eyebrow">What we do</span>
       <h2>Two divisions. One standard.</h2>
       <p class="sub">Choose where you'd like to start.</p>
       <div class="div2">
         <a class="div" href="#/engineering">
           <img class="bg" alt="" src="${PIC.construction}">
           <div class="t">
             <span class="dtag">01 — Engineering</span>
             <h3>Project Engineering</h3>
             <p>Design, installation, commissioning and project management.</p>              <span class="btn s">Explore <i class="uil uil-arrow-right"></i></span>
           </div>
         </a>
         <a class="div" href="#/shop">
           <img class="bg" alt="" src="${PIC.warehouse}">
           <div class="t">
             <span class="dtag">02 — Supply</span>
             <h3>Distribution &amp; Procurement</h3>
             <p>An online shop of quality products at clear prices.</p>              <span class="btn s">Shop now <i class="uil uil-arrow-right"></i></span>
           </div>
         </a>
       </div>
     </div>
   </section>` +

  `<section><div class="wrap">
     <div class="banner rv" style="background-image:url('${PIC.logistics}')">
       <h2>Ready to start your project?</h2>
       <p style="opacity:.85;margin:0 0 22px">Request a free quote from our engineers.</p>
       <a class="btn" href="#/engineering#quote">Request a quote</a>
     </div>
   </div></section>` +

  contact('Contact us', C().email, C().phone);


// ---- Engineering ----
const SERVICES = [
  ['ruler',           'Design & Consulting',          'Feasibility, detailed design and technical studies.'],
  ['cog',             'Installation & Commissioning', 'Mechanical, electrical and process installation.'],
  ['clipboard-notes', 'Project Management',           'Planning, cost control and site supervision.'],
  ['wrench',          'Maintenance',                  'Scheduled and emergency maintenance support.']
];
const QUOTE_SERVICES = [
  'Design & Consulting', 'Installation & Commissioning',
  'Project Management', 'Maintenance', 'Other'
];

// Shown in the portfolio until real projects are added from the admin dashboard
const SHOWCASE = [
  { img: PIC.construction, t: 'Design & Construct',
    d: 'Feasibility, detailed design and full turnkey execution.' },
  { img: PIC.engineers,    t: 'Site Supervision & Commissioning',
    d: 'Safety-first delivery with qualified engineers on site.' },
  { img: PIC.logistics,    t: 'Procurement & Logistics',
    d: 'Global sourcing, expediting and delivery to site.' }
];

const eng = () =>
  hero(
    'Project <em>Engineering</em>',
    'From concept to commissioning, delivered safely, on time and on budget.',
    1,
    '<button class="btn" data-a="explore">Explore our services</button> <a class="btn o" href="#/engineering#quote">Request a quote</a>',
    PIC.engineers
  ) +

  // Services (hidden until "Explore" is clicked)
  `<section id="svc" class="hid"><div class="wrap">
     <span class="eyebrow">Services</span>
     <h2>What we deliver</h2>
     <p class="sub">Edit these in app.js to match the company's offering.</p>
     <div class="grid">        ${SERVICES.map(s => `<div class="card"><div class="ic">${ic(s[0])}</div><h3>${s[1]}</h3><p>${s[2]}</p></div>`).join('')}
     </div>
   </div></section>` +

  // Portfolio
  `<section><div class="wrap rv">
     <span class="eyebrow">Portfolio</span>
     <h2>Selected projects</h2>
     <p class="sub"></p>
     <div class="gal">
       ${S.projects.length ? S.projects.map((p, i) => `
         <div class="proj">
           ${p.img ? `<img alt="${E(p.t)}" src="${E(p.img)}">` : ART.proj(i % 3)}
           <div class="cap"><b>${E(p.t)}</b><br>${E(p.d)}</div>
         </div>`).join('')
       : SHOWCASE.map(s => `
         <div class="proj">
           <img alt="${E(s.t)}" src="${s.img}">
           <div class="cap"><b>${E(s.t)}</b><br>${E(s.d)}</div>
         </div>`).join('')}
     </div>
   </div></section>` +

  // Quote form
  `<section id="quote" style="background:var(--card)"><div class="wrap">
     <span class="eyebrow">Free quote</span>
     <h2>Tell us about your project</h2>
     <p class="sub">We'll review it and get back to you.</p>
     <div class="card">
       <div class="f">
         ${field('qn', 'Name')}
         ${field('qe', 'Email', 'email')}
         ${field('qp', 'Phone')}
         <select id="qs">${QUOTE_SERVICES.map(x => `<option>${x}</option>`).join('')}</select>
       </div>
       <input id="mw" class="hp" tabindex="-1" autocomplete="off">
       <textarea id="qd" rows="4" placeholder="Describe the project, location and timeline"></textarea>
       <p></p>
       <button class="btn" data-a="quote">Submit request</button>
     </div>
   </div></section>` +

  contact('Talk to our engineers', C().email, C().phone);


// ---- Shop ----
const carSlides = () => (C().carousel && C().carousel.length ? C().carousel : [
  { img: PIC.warehouse, title: 'Industrial supply, ready to ship', text: 'Quality products, clear prices, tracked delivery across Canada.' }
]);

// Shop hero: automatic image carousel with arrows, dots, pause on hover,
// touch swipe and reduced-motion support.
function shopHero() {
  const slides = carSlides();
  return `
  <div class="hero car" id="car" role="region" aria-roledescription="carousel" aria-label="JNL Shop highlights">
    <div class="slides">
      ${slides.map((s, i) => `
      <div class="slide ${i === 0 ? 'on' : ''}" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}"${i === 0 ? '' : ' aria-hidden="true"'} style="background-image:url('${E(s.img)}')">
        <div class="wrap">
          <span class="pill"><i></i>JNL Shop · Canada</span>
          <h1>JNL <em>SHOP</em></h1>
          <p class="cslide-t">${E(s.title || '')}</p>
          <p class="cslide-s">${E(s.text || '')}</p>
          <div class="hbtns"><a class="btn" href="#/shop" data-a="carshop">Browse products</a> <a class="btn o" href="#/engineering#quote">Request a quote</a></div>
        </div>
      </div>`).join('')}
    </div>
    <button class="car-nav prev" data-a="car" data-d="-1" aria-label="Previous slide"><i class="uil uil-angle-left-b" aria-hidden="true"></i></button>
    <button class="car-nav next" data-a="car" data-d="1" aria-label="Next slide"><i class="uil uil-angle-right-b" aria-hidden="true"></i></button>
    <div class="dots" role="tablist" aria-label="Choose a slide">
      ${slides.map((_, i) => `<button class="dot ${i === 0 ? 'on' : ''}" data-a="cardot" data-i="${i}" role="tab" aria-selected="${i === 0}" aria-label="Slide ${i + 1}"></button>`).join('')}
    </div>
  </div>`;
}

function carGo(i) {
  const car = $('#car');
  if (!car) return;
  const slides = [...car.querySelectorAll('.slide')];
  if (!slides.length) return;
  CAR.i = (i + slides.length) % slides.length;
  slides.forEach((s, n) => {
    s.classList.toggle('on', n === CAR.i);
    if (n === CAR.i) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true');
  });
  car.querySelectorAll('.dot').forEach((d, n) => {
    d.classList.toggle('on', n === CAR.i);
    d.setAttribute('aria-selected', String(n === CAR.i));
  });
}

function initCarousel() {
  const car = $('#car');
  if (!car) return;
  clearInterval(CAR.timer);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  CAR.i = 0;
  if (reduce) return;                         // no autoplay for reduced-motion users
  const delay = Math.max(2500, Number(C().carouselInterval) || 5000);
  const start = () => { clearInterval(CAR.timer); CAR.timer = setInterval(() => { if (!CAR.paused && !document.hidden) carGo(CAR.i + 1); }, delay); };
  car.addEventListener('mouseenter', () => { CAR.paused = true; });
  car.addEventListener('mouseleave', () => { CAR.paused = false; });
  car.addEventListener('focusin', () => { CAR.paused = true; });
  car.addEventListener('focusout', () => { CAR.paused = false; });
  let sx = null;
  car.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  car.addEventListener('touchend', e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) carGo(CAR.i + (dx < 0 ? 1 : -1));
    sx = null;
  }, { passive: true });
  start();
}

function shop() {
  const cats = ['All', ...new Set(S.products.map(p => p.cat).filter(Boolean))];
  if (!cats.includes(cat)) cat = 'All';

  const list = S.products.filter(p =>
    (cat === 'All' || p.cat === cat) && (p.n + ' ' + p.d + ' ' + (p.sku || '')).toLowerCase().includes(q)
  );

  return shopHero() +

    `<div class="shopbar"><div class="wrap">
       <div class="chips" role="group" aria-label="Filter by category">
         ${cats.map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-a="cat" data-v="${E(c)}" aria-pressed="${c === cat}">${E(c)}</button>`).join('')}
       </div>
       <div class="sbar">
         <label class="srch" for="qs">${ic('search')}<input id="qs" type="search" placeholder="Search products" aria-label="Search products" value="${E(q)}"></label>
         <a class="cartbtn" href="#/cart" aria-label="Cart: ${cartQty()} item${cartQty() === 1 ? '' : 's'}">${ic('shopping-cart')}<span>Cart</span><b data-cart-count>${cartQty()}</b></a>
       </div>
     </div></div>

     <section><div class="wrap">
       <div class="shopmeta"><span>${list.length} product${list.length === 1 ? '' : 's'}</span>${q ? `<span>for “${E(q)}”</span>` : ''}</div>
       <div class="grid">${list.map(pcard).join('') || `<p class="empty">${ic('search')}<br>No products match your search.</p>`}</div>
     </div></section>` +

    contact('JNL Shop contact', C().shopEmail, C().shopPhone);
}


// ---- Cart ----
function cartView() {
  const lines = cartLines();
  const sub = lines.reduce((a, l) => a + l.p.pr * l.qty, 0);

  if (!lines.length) {
    return hero('Your <em>cart</em>', 'Nothing here yet.', 1, '') + `
      <section><div class="wrap"><div class="card center">
        ${ic('shopping-cart')}
        <h3>Your cart is empty</h3>
        <p class="per">Browse the JNL Shop and add what you need.</p>
        <a class="btn" href="#/shop">Browse the JNL Shop</a>
      </div></div></section>`;
  }

  return hero('Your <em>cart</em>', 'Review your items before checkout.', 1, '') + `
    <section><div class="wrap cartwrap">
      <div class="card cartcard">
        ${lines.map(l => `
          <div class="cline">
            <div class="cpic">${l.p.img ? `<img alt="" src="${E(l.p.img)}" loading="lazy">` : ic(l.p.ic)}</div>
            <div class="cname">
              <b>${E(l.p.n)}</b>
              <span>${money(l.p.pr)} each${l.p.sku ? ' · SKU ' + E(l.p.sku) : ''}</span>
            </div>
            <div class="qtybox" role="group" aria-label="Quantity for ${E(l.p.n)}">
              <button class="qb" data-a="qty" data-id="${l.id}" data-d="-1" aria-label="Decrease quantity">${ic('minus')}</button>
              <span aria-live="polite">${l.qty}</span>
              <button class="qb" data-a="qty" data-id="${l.id}" data-d="1" aria-label="Increase quantity">${ic('plus')}</button>
            </div>
            <b class="ctotal">${money(l.p.pr * l.qty)}</b>
            <button class="qb rm" data-a="rm" data-id="${l.id}" aria-label="Remove ${E(l.p.n)}">${ic('times')}</button>
          </div>`).join('')}
      </div>
      <aside class="card cartsum">
        <h3>Summary</h3>
        <div class="srow"><span>Subtotal (${lines.reduce((a, l) => a + l.qty, 0)} items)</span><b>${money(sub)}</b></div>
        <div class="srow"><span>Shipping</span><span class="per">Calculated from your postal code</span></div>
        <div class="srow"><span>GST/HST</span><span class="per">Calculated by destination</span></div>
        <div class="srow tot"><span>Estimated total</span><b>${money(sub)}</b></div>
        <button class="btn w" data-a="checkout">Proceed to checkout ${ic('arrow-right')}</button>
        <a class="btn s d w" href="#/shop">Continue shopping</a>
        <p class="secure">${ic('shield-check')} Secure card payment · CAD · ${me ? 'Cart saved to your account' : 'Guest cart — you can create an account at checkout'}</p>
      </aside>
    </div></section>`;
}

// ---- Account wall (sign in / register) ----
function authWall(title, sub) {
  const login = authMode === 'login';
  return hero(title, sub, 1, '') + `
    <section><div class="wrap">
      ${pendingCheckout ? `<div class="notice">${ic('lock')} <div><b>Your cart is saved.</b> Create an account (or sign in) and we will take you straight back to checkout.</div></div>` : ''}
      <div class="card auth">
        <h3>${login ? 'Sign in' : 'Create account'}</h3>
        ${login ? '' : field('rn', 'Full name')}
        ${field('re', 'Email', 'email')}
        ${field('rp', 'Password (8+ characters)', 'password')}
        <p></p>
        <button class="btn w" data-a="auth">${login ? 'Sign in' : 'Create account'}</button>
        <button class="btn d w" data-a="swap">${login ? 'New here? Create an account' : 'Have an account? Sign in'}</button>
      </div>
    </div></section>`;
}

// ---- Checkout ----
const PAYCFG = { mode: 'sandbox', sandbox: true, enabled: true, publishableKey: '', savedCards: [] };
let STRIPE = null, ELEMENTS = null, CARD = null;

const brandLabel = b => ({ visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', unionpay: 'UnionPay', test: 'Test card' }[String(b).toLowerCase()] || String(b || 'Card'));

function freshCO() {
  return {
    name: me ? me.name : '', email: me ? me.email : '', phone: '',
    street: '', city: '', province: '', postal: '',
    method: 'standard', pay: 'card', savedCard: '', saveCard: false, discount: '',
    busy: false, error: '', order: null, clientSecret: '', idem: ''
  };
}

const coVal = id => { const e = $('#' + id); return e ? e.value : ''; };
function collectCO() {
  if (!CO) return;
  CO.name = coVal('co-name'); CO.email = coVal('co-email'); CO.phone = coVal('co-phone');
  CO.street = coVal('co-street'); CO.city = coVal('co-city'); CO.province = coVal('co-prov');
  CO.postal = coVal('co-postal'); CO.discount = coVal('co-disc');
  const save = $('#co-save'); if (save) CO.saveCard = save.checked;
}

const methodRadios = () => {
  const opts = (Q && Q.shippingMethods && Q.shippingMethods.length ? Q.shippingMethods
    : (PAYCFG.shippingMethods || [{ id: 'standard', label: 'Standard shipping', days: '3–5 business days' }]));
  return `<div class="shipopts" role="radiogroup" aria-label="Delivery method">${opts.map(o => `
    <label class="shipopt">
      <input type="radio" name="ship" value="${E(o.id)}" data-a="setship" ${CO && CO.method === o.id ? 'checked' : ''}>
      <span><b>${E(o.label)}</b><small>${E(o.days || '')}${o.zone ? ' · ' + E(o.zone) : ''}</small></span>
      <b>${o.cents === undefined ? '—' : (o.cents === 0 ? 'Free' : moneyC(o.cents))}</b>
    </label>`).join('')}</div>${Q && Q.freeShipping ? '<p class="freenote">Free shipping applied on this order.</p>' : ''}`;
};

const sandboxPanel = () => `
  <div class="sandboxnote">
    <b>${ic('flask')} Sandbox payments</b>
    <p>Stripe test credentials are not configured, so this store runs the checkout in sandbox mode. No card is requested and no money moves.</p>
    <label>Simulated outcome
      <select id="sbx-outcome">
        <option value="succeed">Successful payment</option>
        <option value="fail">Declined card</option>
        <option value="auth">Requires authentication (3-D Secure)</option>
      </select>
    </label>
  </div>`;

const payPanel = () => {
  const cards = PAYCFG.savedCards || [];
  return `
  <div class="payopts" role="radiogroup" aria-label="Payment method">
    <label class="payopt"><input type="radio" name="pay" value="card" data-a="setpay" ${CO.pay === 'card' ? 'checked' : ''}>
      <span><b>Credit or debit card</b><small>${PAYCFG.sandbox ? 'Sandbox — nothing is charged' : 'Secured by Stripe · 3-D Secure when required'}</small></span>${ic('credit-card')}</label>
    <label class="payopt"><input type="radio" name="pay" value="cod" data-a="setpay" ${CO.pay === 'cod' ? 'checked' : ''}>
      <span><b>Pay on delivery</b><small>Pay the driver when it arrives</small></span>${ic('truck')}</label>
    <label class="payopt"><input type="radio" name="pay" value="bank" data-a="setpay" ${CO.pay === 'bank' ? 'checked' : ''}>
      <span><b>Bank transfer</b><small>We ship once the transfer clears</small></span>${ic('university')}</label>
  </div>
  ${CO.pay !== 'card' ? `<p class="per">${CO.pay === 'bank' ? E(C().bank) : 'Pay in full on delivery. Your order is confirmed now and marked paid when payment is received.'}</p>` : `
    ${cards.length ? `<div class="savedpick" role="radiogroup" aria-label="Saved cards">
      ${cards.map(c => `<label class="cardopt"><input type="radio" name="saved" value="${E(c.id)}" data-a="setsaved" ${CO.savedCard === c.id ? 'checked' : ''}>
        <span>${E(brandLabel(c.brand))} ···· ${E(c.last4)}</span><small>${String(c.expMonth).padStart(2, '0')}/${c.expYear}</small>${c.isDefault ? '<em>default</em>' : ''}</label>`).join('')}
      <label class="cardopt"><input type="radio" name="saved" value="" data-a="setsaved" ${CO.savedCard ? '' : 'checked'}><span>Use a new card</span></label>
    </div>` : ''}
    ${CO.savedCard ? `<p class="per">${ic('lock')} Your bank may ask you to authenticate this saved card.</p>`
      : PAYCFG.sandbox ? sandboxPanel() : `<div id="card-el" class="stripe-el"><span class="per">Loading the secure card form…</span></div>`}
    ${CO.pay === 'card' ? `<label class="consent"><input type="checkbox" id="co-save" ${CO.saveCard ? 'checked' : ''}> Save this card for faster checkout <span>(optional)</span></label>` : ''}
  `}`;
};

function summaryHTML() {
  const lines = cartLines();
  const subC = lines.reduce((a, l) => a + Math.round(l.p.pr * 100) * l.qty, 0);
  const q = Q && (Q.ok || Q.totalCents !== undefined) ? Q : null;
  const totalC = q && q.totalCents !== undefined ? q.totalCents : subC;
  return `<div class="card cosumcard">
    <h3>Order summary</h3>
    <div class="sumlines">
      ${lines.map(l => `<div class="srow"><span>${E(l.p.n)} × ${l.qty}</span><b>${moneyC(Math.round(l.p.pr * 100) * l.qty)}</b></div>`).join('') || '<p class="per">Your cart is empty.</p>'}
    </div>
    <div class="sumtotals">
      <div class="srow"><span>Subtotal</span><b>${moneyC(subC)}</b></div>
      ${q && q.discountCents ? `<div class="srow disc"><span>Discount ${E(q.discountCode || '')}</span><b>−${moneyC(q.discountCents)}</b></div>` : ''}
      <div class="srow"><span>Shipping${q && q.shippingLabel ? ' · ' + E(q.shippingLabel) : ''}</span><b>${q && q.addressReady ? (q.shippingCents === 0 ? 'Free' : moneyC(q.shippingCents)) : '—'}</b></div>
      <div class="srow"><span>${q && q.taxLabel ? E(q.taxLabel) + (q.taxRate ? ' (' + q.taxRate + '%)' : '') : 'GST/HST'}</span><b>${q && q.addressReady ? moneyC(q.taxCents) : '—'}</b></div>
      <div class="srow tot"><span>Total (CAD)</span><b>${moneyC(totalC)}</b></div>
    </div>
    ${!q || q.error ? `<p class="per">${E((q && q.error) || 'Enter your delivery address to calculate shipping and tax.')}</p>` : ''}
    ${CO.error ? `<p class="err" role="alert">${E(CO.error)}</p>` : ''}
    ${CO.order
      ? `<div class="sandboxnote"><b>${ic('credit-card')} Sandbox payment</b><p>Order ${E(CO.order.number)} is waiting for a simulated provider result.</p>
          <div class="f"><button class="btn s" data-a="sbx" data-v="succeed">Pay ${moneyC(CO.order.totalCents)}</button>
          <button class="btn s d" data-a="sbx" data-v="fail">Simulate decline</button></div></div>`
      : `<button class="btn w" data-a="place" ${CO.busy || !lines.length ? 'disabled' : ''}>${CO.busy ? 'Please wait…' : (CO.pay === 'card' ? 'Pay ' + moneyC(totalC) : 'Place order')}</button>`}
    <p class="secure">${ic(PAYCFG.sandbox ? 'flask' : 'lock')} ${PAYCFG.sandbox ? 'Sandbox mode — no real payment is taken.' : 'Card details are handled by Stripe and never touch our servers.'}</p>
  </div>`;
}

function mountCard() {
  if (!PAYCFG || PAYCFG.mode !== 'stripe' || !CO || CO.pay !== 'card' || CO.savedCard) return;
  const host = $('#card-el');
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = '1';
  stripeReady().then(Stripe => {
    if (!PAYCFG.publishableKey) throw new Error('Stripe publishable key is missing on the server');
    STRIPE = STRIPE || Stripe(PAYCFG.publishableKey);
    ELEMENTS = STRIPE.elements({ locale: 'en-CA' });
    CARD = ELEMENTS.create('card', { hidePostalCode: true, style: { base: { fontSize: '16px', color: document.documentElement.getAttribute('data-theme') === 'dark' ? '#eef2fa' : '#0e1a33', '::placeholder': { color: '#8a94a8' } } } });
    CARD.mount('#card-el');
  }).catch(e => { host.innerHTML = `<p class="err">${E(e.message)}</p>`; });
}

function checkout() {
  if (!me) { pendingCheckout = true; authMode = 'register'; return authWall('Checkout', 'Create an account to complete your order.'); }
  if (!cartLines().length) { location.hash = '#/cart'; return ''; }
  CO = CO || freshCO();
  const provs = PAYCFG.provinces || S.provinces || [];
  return hero('Secure <em>checkout</em>', 'Canadian delivery · prices in CAD · encrypted payment', 1, '') + `
    <section><div class="wrap co">
      <div class="coform">
        <div class="card">
          <h3><span class="step">1</span> Contact & delivery</h3>
          <div class="f">
            <label>Full name<input id="co-name" autocomplete="name" value="${E(CO.name)}"></label>
            <label>Email<input id="co-email" type="email" autocomplete="email" value="${E(CO.email)}"></label>
            <label>Phone<input id="co-phone" type="tel" autocomplete="tel" placeholder="+1 416 555 0134" value="${E(CO.phone)}"></label>
          </div>
          <label>Street address<input id="co-street" autocomplete="address-line1" placeholder="123 King St W, Unit 4" value="${E(CO.street)}"></label>
          <div class="f">
            <label>City<input id="co-city" autocomplete="address-level2" value="${E(CO.city)}"></label>
            <label>Province / territory<select id="co-prov" autocomplete="address-level1">
              <option value="">Select province</option>
              ${provs.map(p => `<option value="${p[0]}" ${CO.province === p[0] ? 'selected' : ''}>${p[1]}</option>`).join('')}
            </select></label>
            <label>Postal code<input id="co-postal" autocomplete="postal-code" placeholder="M5V 3L9" maxlength="7" value="${E(CO.postal)}"></label>
          </div>
          <p class="per">${ic('map-marker')} We deliver across Canada. Shipping and tax update as soon as your postal code is valid.</p>
        </div>

        <div class="card">
          <h3><span class="step">2</span> Delivery method</h3>
          <div id="comethods">${methodRadios()}</div>
        </div>

        <div class="card">
          <h3><span class="step">3</span> Payment</h3>
          <div id="copay">${payPanel()}</div>
          ${PAYCFG.sandbox ? `<p class="per">${ic('info-circle')} Sandbox mode: no real payment is taken until Stripe credentials are configured.</p>` : ''}
        </div>

        <div class="card">
          <h3><span class="step">4</span> Discount code</h3>
          <div class="f"><input id="co-disc" placeholder="Enter a code" value="${E(CO.discount)}"><button class="btn s d" data-a="applydisc">Apply</button></div>
        </div>
      </div>
      <aside class="cosum" id="cosum" aria-live="polite">${summaryHTML()}</aside>
    </div></section>`;
}

// ---- Order detail / tracking ----
const orderPage = () => {
  if (!me) return authWall('Your orders', 'Sign in to see your orders, tracking and invoices.');
  return hero('Order <em>details</em>', 'Payment, tracking and invoice', 1, '') +
    `<section><div class="wrap"><div id="orderbox" class="card">Loading…</div></div></section>`;
};

function timelineHTML(o) {
  const evs = [...(o.events || [])];
  (o.shipment?.events || []).forEach(e => evs.push({ at: e.at, label: e.description || e.status, type: 'tracking', actor: e.source === 'carrier' ? (o.shipment.carrier || 'carrier') : 'admin', note: e.location }));
  evs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return `<ol class="tl">${evs.map(e => `<li>
    <span class="tldot ${e.type === 'delivered' || e.type === 'fulfillment_delivered' ? 'done' : ''}"></span>
    <div><b>${E(e.label || e.type)}</b><small>${dateStr(e.at)} ${e.at ? new Date(e.at).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : ''}${e.actor ? ' · ' + E(e.actor) : ''}</small>${e.note ? `<p>${E(e.note)}</p>` : ''}</div>
  </li>`).join('')}</ol>`;
}

function orderHTML(o) {
  const s = o.shipment || {};
  const canPay = ['requires_payment', 'failed'].includes(o.paymentStatus);
  return `
    <div class="ohead">
      <div><span class="eyebrow">Order ${E(o.number)}</span><h2>${moneyC(o.totalCents)}</h2><p class="per">Placed ${dateStr(o.date)} · ${E(o.items.length)} item${o.items.length === 1 ? '' : 's'}</p></div>
      <div class="obadges">${payBadge(o.paymentStatus)} ${fulBadge(o.fulfillmentStatus)}</div>
    </div>
    ${o.paymentStatus === 'failed' && o.lastPaymentError ? `<p class="err" role="alert">${E(o.lastPaymentError)}</p>` : ''}
    ${o.estimateDeliveryAt ? `<p class="per">${ic('clock')} Estimated delivery ${dateStr(o.estimateDeliveryAt)} — an estimate, not carrier-confirmed.</p>` : ''}
    <div class="ogrid">
      <div>
        <h3>Items</h3>
        ${o.items.map(i => `<div class="row"><span>${E(i.name)} <small>× ${i.qty}${i.sku ? ' · ' + E(i.sku) : ''}</small></span><b>${moneyC(i.lineCents)}</b></div>`).join('')}
        <div class="srow"><span>Subtotal</span><b>${moneyC(o.subtotalCents)}</b></div>
        ${o.discountCents ? `<div class="srow"><span>Discount</span><b>−${moneyC(o.discountCents)}</b></div>` : ''}
        <div class="srow"><span>Shipping${o.shippingLabel ? ' · ' + E(o.shippingLabel) : ''}</span><b>${o.shippingCents ? moneyC(o.shippingCents) : 'Free'}</b></div>
        <div class="srow"><span>${E(o.taxLabel || 'Tax')}</span><b>${moneyC(o.taxCents)}</b></div>
        <div class="srow tot"><span>Total ${String(o.currency).toUpperCase()}</span><b>${moneyC(o.totalCents)}</b></div>
        ${o.refunds && o.refunds.length ? `<p class="per">Refunded ${moneyC(o.refunds.reduce((a, r) => a + r.amountCents, 0))}</p>` : ''}
      </div>
      <div>
        <h3>Delivery</h3>
        <p class="per">${E(o.shippingAddress.name)}<br>${E(o.shippingAddress.street)}<br>${E(o.shippingAddress.city)}, ${E(o.shippingAddress.province)} ${E(o.shippingAddress.postalCode)}<br>Canada</p>
        ${s.trackingNumber ? `<div class="shipcard">${ic('truck')}<div><b>${E(s.carrier || 'Carrier')}</b><div class="mono">${E(s.trackingNumber)}</div>${s.trackingUrl ? `<a href="${E(s.trackingUrl)}" target="_blank" rel="noopener noreferrer">Track with the carrier ${ic('external-link-alt')}</a>` : ''}<small>${s.source === 'admin' ? 'Shipment entered by our team' : 'Shipment updates from the carrier'}</small></div></div>` : '<p class="per">Tracking appears here once your order ships.</p>'}
        <div class="oacts">
          ${o.canDownloadInvoice ? `<button class="btn s" data-a="invoice" data-id="${o.invoiceId}">${ic('file-alt')} Download invoice</button>` : ''}
          ${canPay && PAYCFG.mode !== 'stripe' ? `<button class="btn s d" data-a="retry" data-id="${o.id}">Retry payment</button>` : ''}
          ${['requires_payment', 'failed', 'processing'].includes(o.paymentStatus) ? `<button class="btn s d" data-a="ocancel" data-id="${o.id}">Cancel order</button>` : ''}
        </div>
        ${canPay && PAYCFG.mode === 'stripe' ? `<div id="pay-el" class="stripe-el"></div>
          <button class="btn s" data-a="payorder" data-id="${o.id}">Pay ${moneyC(o.totalCents)}</button>` : ''}
      </div>
    </div>
    <h3>Timeline</h3>
    ${timelineHTML(o)}`;
}

// ---- Customer dashboard ----
function account() {
  if (!me) return authWall('Your <em>account</em>', 'Sign in to view orders, tracking, invoices and saved cards.');
  const tabs = [['orders', 'Orders & tracking'], ['invoices', 'Invoices'], ['cards', 'Payment methods'], ['profile', 'Profile'], ['alerts', 'Notifications']];
  return hero('Hello, <em>' + E(String(me.name || 'there').split(' ')[0]) + '</em>', 'Orders, tracking, invoices and saved payment methods.', 1,
              '<button class="btn o" data-a="logout">Sign out</button>') +
    `<div class="subnav"><div class="wrap">${tabs.map(t => `<button class="${acctTab === t[0] ? 'on' : ''}" data-a="atab" data-v="${t[0]}" aria-pressed="${acctTab === t[0]}">${t[1]}</button>`).join('')}</div></div>
     <section><div class="wrap" id="acctbox">Loading…</div></section>`;
}

function acctPanel() {
  if (acctTab === 'orders') {
    const os = ACCT.orders || [];
    return os.length ? `<div class="orderlist">${os.map(o => `
      <a class="ordercard" href="#/order/${o.id}">
        <div><b>${E(o.number)}</b><small>${dateStr(o.date)} · ${o.items.length} item${o.items.length === 1 ? '' : 's'}</small></div>
        <div>${payBadge(o.paymentStatus)} ${fulBadge(o.fulfillmentStatus)}</div>
        <b>${moneyC(o.totalCents)}</b>
        <span class="go">${ic('arrow-right')}</span>
      </a>`).join('')}</div>` : `<div class="card center">${ic('package')}<h3>No orders yet</h3><p class="per">Your orders and tracking will appear here.</p><a class="btn" href="#/shop">Start shopping</a></div>`;
  }
  if (acctTab === 'invoices') {
    const list = ACCT.invoices || [];
    return list.length ? `<div class="tbl inv"><div class="tr th"><span>Invoice</span><span>Order</span><span>Date</span><span>Total</span><span></span></div>
      ${list.map(i => `<div class="tr"><span>${E(i.number)}</span><span>${E(i.orderNumber)}</span><span>${dateStr(i.date)}</span><span>${moneyC(i.totalCents)}</span><span><button class="btn s d" data-a="invoice" data-id="${i.id}">PDF</button></span></div>`).join('')}</div>`
      : `<div class="card center">${ic('file-alt')}<h3>No invoices yet</h3><p class="per">An invoice is issued automatically once a payment is confirmed.</p></div>`;
  }
  if (acctTab === 'cards') {
    const list = ACCT.methods || [];
    return `<div class="card">
      <h3>Saved cards</h3>
      ${PAYCFG.sandbox ? `<p class="per">${ic('flask')} Sandbox mode — saved cards are simulated test tokens.</p>` : `<p class="per">${ic('lock')} Cards are stored with Stripe. We only keep the brand, last 4 digits and expiry.</p>`}
      ${list.length ? list.map(c => `<div class="row pml"><span>${ic('credit-card')} <b>${E(brandLabel(c.brand))} ···· ${E(c.last4)}</b> <small>exp ${String(c.expMonth).padStart(2, '0')}/${c.expYear}</small>${c.isDefault ? '<em class="def">default</em>' : ''}</span>
        <span>${c.isDefault ? '' : `<button class="btn s d" data-a="pmdef" data-id="${E(c.id)}">Make default</button>`}
        <button class="btn s d" data-a="pmdel" data-id="${E(c.id)}">Remove</button></span></div>`).join('') : '<p class="per">No saved cards yet.</p>'}
      <div id="newcard"></div>
      <button class="btn s" data-a="addcard">${ic('plus')} Add a card</button>
    </div>`;
  }
  if (acctTab === 'profile') {
    return `<div class="card" style="max-width:520px">
      <h3>Profile</h3>
      <div class="f"><label>Name<input id="pf-name" value="${E(me.name || '')}"></label><label>Phone<input id="pf-phone" value="${E(me.phone || '')}"></label></div>
      <label>Email<input value="${E(me.email)}" disabled></label>
      <p></p><button class="btn s" data-a="pfsave">Save profile</button>
      <h3 style="margin-top:28px">Change password</h3>
      <label>Current password<input id="pw-old" type="password"></label>
      <label>New password (8+ characters)<input id="pw-new" type="password"></label>
      <p></p><button class="btn s d" data-a="pwchange">Update password</button>
    </div>`;
  }
  const ns = ACCT.notifications || [];
  return ns.length ? `<div class="card">${ns.map(n => `<div class="row notif ${n.read ? '' : 'unread'}"><span><b>${E(n.title)}</b><br><small>${E(n.body)}</small></span><small>${dateStr(n.at)}</small></div>`).join('')}</div>
    <button class="btn s d" data-a="notifread">Mark all as read</button>`
    : `<div class="card center">${ic('bell')}<h3>No notifications</h3><p class="per">Order and payment updates will appear here.</p></div>`;
}

async function loadAccount() {
  if (!me) return;
  const box = $('#acctbox');
  if (!box) return;
  try {
    if (acctTab === 'orders' && !ACCT.orders) ACCT.orders = await api('/me/orders');
    if (acctTab === 'invoices' && !ACCT.invoices) ACCT.invoices = await api('/invoices');
    if (acctTab === 'cards' && !ACCT.methods) ACCT.methods = (await api('/payments/methods')).methods;
    if (acctTab === 'alerts') ACCT.notifications = (await api('/me/notifications')).notifications;
  } catch (e) {
    if (e.status === 401) { acts.logout(); return; }
    box.innerHTML = `<p class="err">${E(e.message)}</p>`;
    return;
  }
  box.innerHTML = acctPanel();
}


// -----------------------------------------------------------------------------
// 5. ADMIN VIEW
// -----------------------------------------------------------------------------

const ORDER_STATUSES = ['new', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled'];
const QUOTE_STATUSES = ['new', 'contacted', 'won', 'closed'];
const ADMIN_TABS     = ['sales', 'products', 'orders', 'invoices', 'payments', 'quotes', 'messages', 'projects', 'staff', 'customers', 'settings', 'stats', 'audit'];
const PRODUCT_ICONS  = ['package', 'wrench', 'hard-hat', 'plug', 'box', 'bolt', 'shield', 'cog', 'building', 'ruler', 'screw', 'processor'];
const SALES_RANGES   = [['7d', 'Past 7 days'], ['30d', 'Past 30 days'], ['90d', 'Past 3 months'], ['180d', 'Past 6 months'], ['365d', 'Past 12 months'], ['all', 'All time']];

// Query string for the currently selected sales period
const sfQuery = () => SF.from || SF.to
  ? 'from=' + encodeURIComponent(SF.from) + '&to=' + encodeURIComponent(SF.to)
  : 'range=' + (SF.range || 'all');

// Download a protected report as a file (CSV)
async function dl(path) {
  const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + atk() } });
  if (!r.ok) {
    if (r.status === 401) { sessionStorage.removeItem('atk'); throw new Error('Please sign in again'); }
    throw new Error('Download failed');
  }
  const blob = await r.blob();
  const m = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : 'report.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const SETTINGS_INPUTS = [
  ['name',         'Company name'],
  ['legalName',    'Legal name (invoices)'],
  ['cur',          'Currency symbol'],
  ['currencyCode', 'Currency code (cad, usd)'],
  ['email',        'Main email'],
  ['phone',        'Main phone'],
  ['shopEmail',    'Shop email'],
  ['shopPhone',    'Shop phone'],
  ['whatsapp',     'WhatsApp number (with country code)'],
  ['gaId',         'Google Analytics ID (G-XXXX)'],
  ['hours',        'Business hours'],
  ['addr',         'Address'],
  ['legalAddr',    'Legal address (invoices)'],
  ['gstNumber',    'GST/HST registration number'],
  ['invoicePrefix','Invoice prefix (e.g. JNL)']
];
const SETTINGS_TEXTAREAS = [
  ['hero',  'Hero headline'],
  ['tag',   'Hero tagline'],
  ['about', 'About text'],
  ['bank',  'Bank transfer details']
];

const option = (value, current) => `<option value="${E(value)}" ${value === current ? 'selected' : ''}>${E(value)}</option>`;

const PAY_STATUSES = ['requires_payment', 'processing', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'];
const FUL_STATUSES = ['unfulfilled', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];

// Expanded admin order record: payment vs fulfillment kept clearly separate
function adminOrderCard(o) {
  const remaining = o.totalCents - (o.refundedCents || 0);
  const refundable = ['paid', 'partially_refunded', 'refund_pending'].includes(o.paymentStatus);
  return `<div class="card adorder" id="adorder">
    <div class="ohead">
      <div><span class="eyebrow">${E(o.number)}</span><h3>${moneyC(o.totalCents)} ${E(String(o.currency).toUpperCase())}</h3>
        <p class="per">${dateStr(o.date)} · ${E(o.customer?.name || o.name)} · ${E(o.customer?.email || o.email)} · ${E(o.customer?.phone || o.phone)}
        ${o.customerAccount ? ' · <a href="#/admin">account</a>' : ''}</p></div>
      <div class="obadges">${payBadge(o.paymentStatus)} ${fulBadge(o.fulfillmentStatus)}</div>
    </div>

    <div class="ogrid">
      <div>
        <h4>Items</h4>
        ${(o.items || []).map(i => `<div class="row"><span>${E(i.name)} <small>× ${i.qty}${i.sku ? ' · ' + E(i.sku) : ''}</small></span><b>${moneyC(i.lineCents)}</b></div>`).join('')}
        <div class="srow"><span>Subtotal</span><b>${moneyC(o.subtotalCents)}</b></div>
        ${o.discountCents ? `<div class="srow"><span>Discount ${E(o.discountCode || '')}</span><b>−${moneyC(o.discountCents)}</b></div>` : ''}
        <div class="srow"><span>Shipping${o.shippingLabel ? ' · ' + E(o.shippingLabel) : ''}</span><b>${moneyC(o.shippingCents)}</b></div>
        <div class="srow"><span>${E(o.taxLabel || 'Tax')}${o.taxRate ? ' (' + o.taxRate + '%)' : ''}</span><b>${moneyC(o.taxCents)}</b></div>
        <div class="srow tot"><span>Total</span><b>${moneyC(o.totalCents)}</b></div>
        ${o.refundedCents ? `<div class="srow"><span>Refunded</span><b>−${moneyC(o.refundedCents)}</b></div>` : ''}

        <h4>Delivery address</h4>
        <p class="per">${E(o.shippingAddress?.name || '')}<br>${E(o.shippingAddress?.street || '')}<br>${E(o.shippingAddress?.city || '')}, ${E(o.shippingAddress?.province || '')} ${E(o.shippingAddress?.postalCode || '')}<br>Canada</p>

        <h4>Payment reference</h4>
        <p class="per mono">${E(o.paymentIntentId || 'no provider intent')}<br>${E(o.method)} · ${E(o.paymentStatus)}${o.lastPaymentError ? '<br>' + E(o.lastPaymentError) : ''}</p>
        <p class="per">${ic('lock')} No card numbers, CVV or PINs are stored.</p>

        <h4>Downloads</h4>
        ${o.invoice ? `<button class="btn s d" data-a="ainvoice" data-id="${E(o.invoice.id)}">${ic('file-alt')} Invoice ${E(o.invoice.number)}</button>` : '<p class="per">No invoice yet — one is issued when payment is confirmed.</p>'}
      </div>

      <div>
        <h4>Fulfillment</h4>
        <label>Status<select id="oful-st">${FUL_STATUSES.map(s => option(s, o.fulfillmentStatus)).join('')}</select></label>
        <div class="f">
          <label>Carrier<input id="oful-car" value="${E(o.shipment?.carrier || '')}" placeholder="Canada Post"></label>
          <label>Tracking number<input id="oful-trk" value="${E(o.shipment?.trackingNumber || '')}"></label>
        </div>
        <label>Tracking URL<input id="oful-url" value="${E(o.shipment?.trackingUrl || '')}" placeholder="https://…"></label>
        <label>Note (optional)<input id="oful-note" placeholder="Visible in the customer timeline"></label>
        <button class="btn s" data-a="oful" data-id="${E(o.id)}">Save fulfillment</button>
        <p class="per">Fulfillment updates never change the payment status.</p>

        ${o.shipment ? `<h4>Add tracking event</h4>
          <p class="per">${E(o.shipment.carrier || 'Carrier')} · <span class="mono">${E(o.shipment.trackingNumber)}</span></p>
          <div class="f"><label>Status<input id="otrk-st" placeholder="in_transit"></label><label>Location<input id="otrk-loc" placeholder="Toronto, ON"></label></div>
          <label>Description<input id="otrk-desc" placeholder="Arrived at sorting facility"></label>
          <button class="btn s d" data-a="otrack" data-id="${E(o.id)}">Add event (manual)</button>` : ''}

        ${AD && AD.role === 'super' && refundable ? `<h4>Refund</h4>
          <p class="per">Refundable now: <b>${moneyC(remaining)}</b></p>
          <div class="f"><label>Amount (CAD)<input id="oref-amt" type="number" step="0.01" min="0.01" max="${(remaining / 100).toFixed(2)}" value="${(remaining / 100).toFixed(2)}"></label>
          <label>Reason<select id="oref-why"><option value="requested_by_customer">Requested by customer</option><option value="duplicate">Duplicate</option><option value="fraudulent">Fraudulent</option></select></label></div>
          <button class="btn s d" data-a="orefund" data-id="${E(o.id)}">Refund via provider</button>
          <p class="per">Refunds are processed by the payment provider and issue a credit note.</p>` : ''}
        ${AD && AD.role !== 'super' && refundable ? '<p class="per">Refunds require a super admin.</p>' : ''}
      </div>
    </div>

    <h4>Timeline</h4>
    ${timelineHTML(o)}

    <h4>Audit history</h4>
    ${(o.audit || []).length ? (o.audit || []).map(a => `<div class="row"><span>${E(a.action)} · ${E(a.actor)}</span><small>${dateStr(a.at)}</small></div>`).join('') : '<p class="per">No administrative actions yet.</p>'}
    <p></p><button class="btn s d" data-a="oclose">Close</button>
  </div>`;
}

// Admin tab renderers (d = admin data)
const adminTabs = d => ({

  // Sales overview: period filters, KPIs, revenue chart, product breakdown, CSV
  sales: () => {
    const s = SALES;
    if (!s) return '<p>Loading sales overview…</p>';
    const k = s.kpis;
    const stale = salesKey !== sfQuery();
    const maxRev = Math.max(1, ...s.series.map(x => x.revenue));
    const skip = Math.max(1, Math.ceil(s.series.length / 16));
    return `
    <div class="fbar">
      ${SALES_RANGES.map(([v2, l]) => `<button class="chip ${!SF.from && !SF.to && SF.range === v2 ? 'on' : ''}" data-a="srange" data-v="${v2}">${l}</button>`).join('')}
      <span class="sp"><input type="date" id="sfrom" value="${E(SF.from)}" aria-label="From date"><i>–</i><input type="date" id="sto" value="${E(SF.to)}" aria-label="To date"></span>
      <button class="chip" data-a="scustom">Apply dates</button>
      <button class="chip dl" data-a="scsv"><i class="uil uil-download-alt"></i> Download CSV</button>
    </div>
    <p class="per">${E(s.label)}${stale ? ' · <b>updating…</b>' : ''} — ${k.orders} orders, ${k.units} units sold</p>

    <div class="grid">
      <div class="card kpi"><h3>${money(k.revenue)}</h3>Gross revenue</div>
      <div class="card kpi"><h3>${money(k.paid)}</h3>Collected (paid)</div>
      <div class="card kpi"><h3>${money(k.outstanding)}</h3>Amount left (unpaid)</div>
      <div class="card kpi"><h3>${k.orders}</h3>Orders</div>
      <div class="card kpi"><h3>${k.units}</h3>Units sold</div>
      <div class="card kpi"><h3>${money(Math.round(k.avg))}</h3>Average order</div>
      <div class="card kpi"><h3>${k.customers}</h3>Customers buying</div>
      <div class="card kpi"><h3>${k.stockUnits}</h3>Units left in stock</div>
      <div class="card kpi"><h3>${money(Math.round(k.stockValue))}</h3>Stock value left</div>
    </div>

    <h3>Revenue over time</h3>
    ${s.series.length ? `<div class="chart">${s.series.map((x, i) => `
      <div class="bar" title="${E(x.label)} — ${x.orders} orders · ${x.units} units · ${money(x.revenue)}">
        <i style="height:${Math.max(2, Math.round(x.revenue / maxRev * 100))}%"></i>
        <span>${i % skip === 0 ? E(x.label.slice(5)) : ''}</span>
      </div>`).join('')}</div>` : '<p>No sales in this period.</p>'}

    <h3>Products sold</h3>
    <div class="tbl">
      <div class="tr th"><span>Product</span><span>Price</span><span>Sold</span><span>Revenue</span><span>Left in stock</span><span>Stock value</span></div>
      ${s.products.map(p => `<div class="tr">
        <span>${ic(p.ic)} ${E(p.name)}${p.cat ? ' · ' + E(p.cat) : ''}</span>
        <span>${money(p.price)}</span>
        <span>${p.qty}</span>
        <span>${money(p.revenue)}</span>
        <span>${p.stock}</span>
        <span>${money(Math.round(p.stockValue))}</span>
      </div>`).join('') || '<div class="tr"><span>No products yet.</span></div>'}
    </div>

    <div class="grid">
      <div class="card">
        <h3>Orders by status</h3>
        ${Object.entries(s.byStatus).map(([st, n]) => `<div class="row"><span>${E(st)}</span><b>${n}</b></div>`).join('') || '<p>None.</p>'}
      </div>
      <div class="card">
        <h3>Orders by payment method</h3>
        ${Object.entries(s.byMethod).map(([m, n]) => `<div class="row"><span>${E(m)}</span><b>${n}</b></div>`).join('') || '<p>None.</p>'}
      </div>
    </div>

    <h3>Latest orders in period</h3>
    ${s.recent.map(o => `<div class="row">
      <span>#${E(o.id)} · ${new Date(o.date).toLocaleDateString()} · ${E(o.name)} · ${o.items} item${o.items === 1 ? '' : 's'} · ${E(o.method)}</span>
      <span><b>${money(o.total)}</b> ${o.paid ? `· ${ic('check-circle')} paid` : `· ${ic('clock')} unpaid`} · ${E(o.status)}</span>
    </div>`).join('') || '<p>No orders in this period.</p>'}`;
  },

  products: () => `
    <div class="adm">
      <div class="f">
        <input id="an"  placeholder="Product name">
        <input id="ap2" type="number" step="any" placeholder="Price">
        <input id="ac"  placeholder="Category">
        <select id="ai" aria-label="Icon">${PRODUCT_ICONS.map(n => `<option value="${n}">${n}</option>`).join('')}</select>
        <input id="astk" type="number" min="0" placeholder="Units in stock">
      </div>
      <input id="ad" placeholder="Description">
      <input type="hidden" id="aid">
      <p></p>
      <label class="btn s d"><i class="uil uil-camera"></i> Photo<input id="aim" type="file" accept="image/*" hidden></label>
      <span id="ast"></span>
      <button class="btn s" data-a="psave">Save product</button>
    </div>
    ${S.products.map(p => `
      <div class="row">
        <span>${p.img ? ic('image') : ic(p.ic)} ${E(p.n)} · ${money(p.pr)} · ${E(p.cat)} · ${Number.isFinite(p.stock) ? p.stock : 0} in stock</span>
        <span>
          <button class="btn s d" data-a="pedit" data-id="${p.id}">Edit</button>
          <button class="btn s d" data-a="pdel"  data-id="${p.id}">Delete</button>
        </span>
      </div>`).join('')}`,

  orders: () => `
    <div class="card" style="background:none;border:0;padding:0">
      <div class="fbar">
        <input id="of-q" placeholder="Search order #, name, email" value="${E(OF.q)}" aria-label="Search orders">
        <select id="of-pay" aria-label="Payment status"><option value="">All payments</option>${PAY_STATUSES.map(s => `<option value="${s}" ${OF.payment === s ? 'selected' : ''}>${PAY_LABEL[s] || s}</option>`).join('')}</select>
        <select id="of-ful" aria-label="Fulfillment status"><option value="">All fulfillment</option>${FUL_STATUSES.map(s => `<option value="${s}" ${OF.fulfillment === s ? 'selected' : ''}>${FUL_LABEL[s] || s}</option>`).join('')}</select>
        <select id="of-ref" aria-label="Refund status"><option value="">Any refund state</option><option value="any" ${OF.refund === 'any' ? 'selected' : ''}>Has refunds</option><option value="partial" ${OF.refund === 'partial' ? 'selected' : ''}>Partially refunded</option><option value="full" ${OF.refund === 'full' ? 'selected' : ''}>Refunded</option></select>
        <span class="sp"><input type="date" id="of-from" value="${E(OF.from)}" aria-label="From"><i>–</i><input type="date" id="of-to" value="${E(OF.to)}" aria-label="To"></span>
        <button class="chip" data-a="ofilter">Filter</button>
        <button class="chip dl" data-a="ocsv">${ic('download-alt')} Export CSV</button>
      </div>
    </div>
    ${ADMIN_ORDER ? adminOrderCard(ADMIN_ORDER) : ''}
    ${AO === null ? '<p>Loading orders…</p>' : (AO.length ? `<div class="tbl ord">
      <div class="tr th"><span>Order</span><span>Customer</span><span>Payment</span><span>Fulfillment</span><span>Total</span><span></span></div>
      ${AO.map(o => `<div class="tr">
        <span><b>${E(o.number)}</b><br><small>${dateStr(o.date)}</small></span>
        <span>${E(o.customer?.name || '')}<br><small>${E(o.customer?.email || '')}</small></span>
        <span>${payBadge(o.paymentStatus)}</span>
        <span>${fulBadge(o.fulfillmentStatus)}</span>
        <span><b>${moneyC(o.totalCents)}</b>${o.refundedCents ? `<br><small>−${moneyC(o.refundedCents)}</small>` : ''}</span>
        <span><button class="btn s d" data-a="oopen" data-id="${E(o.id)}">Open</button></span>
      </div>`).join('')}
    </div>` : '<p>No orders match these filters.</p>')}
    <p class="per">Search, filter by date, customer, number, payment, fulfillment or refund state. Totals are the server-stored order snapshot.</p>`,

  invoices: () => `
    <div class="fbar"><input id="if-q" placeholder="Search invoice or order number, customer" aria-label="Search invoices">
      <button class="chip" data-a="ifilter">Search</button></div>
    ${AI === null ? '<p>Loading invoices…</p>' : (AI.length ? `<div class="tbl inv">
      <div class="tr th"><span>Invoice</span><span>Order</span><span>Customer</span><span>Date</span><span>Total</span><span></span></div>
      ${AI.map(i => `<div class="tr">
        <span><b>${E(i.number)}</b><br><small>${E(i.type)}</small></span>
        <span>${E(i.orderNumber)}</span>
        <span>${E(i.customer)}<br><small>${E(i.email)}</small></span>
        <span>${dateStr(i.date)}</span>
        <span>${moneyC(i.totalCents)}</span>
        <span><button class="btn s d" data-a="ainvoice" data-id="${E(i.id)}">PDF</button></span>
      </div>`).join('')}
    </div>` : '<p>No invoices yet. One is generated for every confirmed payment.</p>')}`,

  payments: () => `
    <p class="per">Provider: <b>${E((AD && AD.paymentMode) || PAYCFG.mode)}</b> · statuses mirror the provider records. Card data is never shown because it is never stored.</p>
    ${AP === null ? '<p>Loading payments…</p>' : (AP.length ? `<div class="tbl pay">
      <div class="tr th"><span>Order</span><span>Customer</span><span>Status</span><span>Amount</span><span>Refunds</span><span>Intent</span></div>
      ${AP.map(p => `<div class="tr">
        <span><b>${E(p.orderNumber)}</b><br><small>${dateStr(p.date)}</small></span>
        <span>${E(p.customer)}</span>
        <span>${payBadge(p.paymentStatus)}${p.lastError ? `<br><small class="err">${E(p.lastError)}</small>` : ''}</span>
        <span>${moneyC(p.amountCents)}</span>
        <span>${p.refunds ? p.refunds + ' · ' + moneyC(p.refundedCents) : '—'}</span>
        <span class="mono"><small>${E(p.intentId || '—')}</small></span>
      </div>`).join('')}
    </div>` : '<p>No payments yet.</p>')}`,

  audit: () => `
    <p class="per">Who did what and when — refunds, fulfillment, staff, settings and invoice access.</p>
    ${AA === null ? '<p>Loading audit log…</p>' : (AA.length ? `<div class="tbl aud">
      <div class="tr th"><span>When</span><span>Who</span><span>Action</span><span>Target</span><span>Details</span></div>
      ${AA.map(a => `<div class="tr"><span>${new Date(a.at).toLocaleString('en-CA')}</span><span>${E(a.actor)}${a.role ? ' · ' + E(a.role) : ''}</span><span>${E(a.action)}</span><span>${E(a.target)} ${E(a.targetId)}</span><span><small>${E(a.meta ? JSON.stringify(a.meta).slice(0, 120) : '')}</small></span></div>`).join('')}
    </div>` : '<p>Nothing recorded yet.</p>')}`,

  quotes: () => d.quotes.map(o => `
    <div class="card" style="margin-bottom:12px">
      <b>${E(o.name)}</b> · ${E(o.service)} · ${new Date(o.date).toLocaleDateString()}<br>
      ${E(o.email)} ${E(o.phone)}
      <p>${E(o.details)}</p>
      <select data-a="qstat" data-id="${o.id}">${QUOTE_STATUSES.map(s => option(s, o.status)).join('')}</select>
    </div>`).join('') || '<p>No quote requests yet.</p>',

  messages: () => d.messages.map(o => `
    <div class="card" style="margin-bottom:12px">
      <b>${E(o.name)}</b> · ${E(o.email)} · ${new Date(o.date).toLocaleDateString()}
      <p>${E(o.body)}</p>
    </div>`).join('') || '<p>No messages yet.</p>',

  projects: () => `
    <div class="adm">
      <div class="f">
        <input id="jt" placeholder="Project title">
        <input id="jd" placeholder="Short description">
      </div>
      <label class="btn s d"><i class="uil uil-camera"></i> Photo<input id="jim" type="file" accept="image/*" hidden></label>
      <span id="jst"></span>
      <button class="btn s" data-a="jsave">Add project</button>
    </div>
    ${S.projects.map(p => `
      <div class="row">
        <span>${p.img ? ic('image') : ic('building')} ${E(p.t)}</span>
        <button class="btn s d" data-a="jdel" data-id="${p.id}">Delete</button>
      </div>`).join('')}`,

  // Staff accounts — visible to super admins only (filtered in adminView)
  staff: () => `
    <div class="adm">
      <div class="f">
        <input id="stn" placeholder="Full name">
        <input id="ste" type="email" placeholder="Email">
        <input id="stp" type="password" placeholder="Password (8+ characters)">
        <select id="str" aria-label="Role"><option value="admin">Admin</option><option value="super">Super admin</option></select>
      </div>
      <button class="btn s" data-a="stsave">Create staff account</button>
    </div>
    <p class="per">Super admins see everything; admins manage products, orders, quotes and reports.</p>
    ${(d.staff || []).map(s => `<div class="row">
      <span>${ic(s.role === 'super' ? 'star' : 'shield')} <b>${E(s.name)}</b> · ${E(s.email)} · ${E(s.role === 'super' ? 'Super admin' : 'Admin')}</span>
      <span>
        <button class="btn s d" data-a="strole" data-id="${s.id}" data-v="${s.role === 'super' ? 'admin' : 'super'}">${s.role === 'super' ? 'Demote to admin' : 'Promote to super'}</button>
        <button class="btn s d" data-a="stdelete" data-id="${s.id}">Remove</button>
      </span>
    </div>`).join('') || '<p>No staff accounts yet — you are signed in with the master key.</p>'}`,

  // Registered customers — super admins only (data is only sent to them, filtered in adminView)
  customers: () => `
    <div class="tbl">
      <div class="tr th"><span>Name</span><span>Email</span><span>Joined</span><span>Status</span><span>Orders</span><span>Spent</span></div>
      ${(d.customers || []).map(c => `<div class="tr">
        <span><b>${E(c.name)}</b></span>
        <span>${E(c.email)}</span>
        <span>${c.date ? new Date(c.date).toLocaleDateString() : '—'}</span>
        <span>${ic('check-circle')} ${E(c.status)}</span>
        <span>${c.orders}</span>
        <span>${money(c.spent)}</span>
      </div>`).join('') || '<div class="tr"><span>No customers yet — new registrations appear here instantly.</span></div>'}
    </div>
    <p class="per">Every account created on the public Account page appears here automatically.</p>`,

  settings: () => `
    <div class="card">
      <div class="f">
        ${SETTINGS_INPUTS.map(x => `<label>${x[1]}<input id="s_${x[0]}" value="${E(C()[x[0]])}"></label>`).join('')}
      </div>
      ${SETTINGS_TEXTAREAS.map(x => `<label>${x[1]}<textarea id="s_${x[0]}" rows="2">${E(C()[x[0]])}</textarea></label>`).join('')}
      <p></p>
      <label class="btn s d"><i class="uil uil-tag"></i> Logo<input id="slg" type="file" accept="image/*" hidden></label>
      <label class="btn s d"><i class="uil uil-image"></i> Hero image<input id="shi" type="file" accept="image/*" hidden></label>
      <button class="btn s d" data-a="rmhero">Remove hero image</button>
      <button class="btn s" data-a="ssave">Save settings</button>
    </div>

    <h3>Shipping rules</h3>
    <div class="card">
      <p class="per">Charged per shipment to the zone whose postal prefix matches. The longest matching prefix wins. Fees are in CAD.</p>
      <div class="f">
        <label>Free shipping over ($)<input id="s_free" type="number" min="0" step="1" value="${(C().shipping.freeOverCents / 100).toFixed(2)}"></label>
        <label>Extra per kg over 1kg ($)<input id="s_perkg" type="number" min="0" step="0.01" value="${(C().shipping.perKgCents / 100).toFixed(2)}"></label>
        <label>Max order weight (kg)<input id="s_maxw" type="number" min="1" value="${C().shipping.maxWeightKg}"></label>
      </div>
      <div class="tbl zones">
        <div class="tr th"><span>Zone</span><span>Postal prefixes</span><span>Fee ($)</span></div>
        ${C().shipping.zones.map((z, i) => `<div class="tr">
          <span><input id="sz_${i}_label" value="${E(z.label)}" aria-label="Zone name"></span>
          <span><input id="sz_${i}_prefixes" value="${E((z.prefixes || []).join(', '))}" aria-label="Zone prefixes"></span>
          <span><input id="sz_${i}_amt" type="number" min="0" step="0.01" value="${((z.cents || 0) / 100).toFixed(2)}" aria-label="Zone fee"></span>
        </div>`).join('')}
      </div>
    </div>

    <h3>Sales tax by destination</h3>
    <div class="card">
      <p class="per">Combined rate applied to the discounted subtotal plus shipping. Set a rate to 0 to stop charging tax in a province.</p>
      <div class="taxgrid">
        ${(S.provinces || []).map(p => `<label>${p[1]}<input id="st_${p[0]}" type="number" min="0" max="30" step="0.001" value="${Number(C().tax.rates[p[0]]?.rate || 0)}"></label>`).join('')}
      </div>
      <label class="consent"><input type="checkbox" id="s_taxon" ${C().tax.onShipping === false ? '' : 'checked'}> Charge tax on shipping</label>
    </div>

    <h3>Shop carousel</h3>
    <div class="card">
      ${(C().carousel || []).map((s, i) => `<div class="caredit">
        <span>Slide ${i + 1}</span>
        <input id="sc_${i}_img" value="${E(s.img)}" placeholder="Image path (e.g. /img/warehouse.jpg)" aria-label="Slide ${i + 1} image">
        <input id="sc_${i}_title" value="${E(s.title)}" placeholder="Headline" aria-label="Slide ${i + 1} headline">
        <input id="sc_${i}_text" value="${E(s.text)}" placeholder="Supporting text" aria-label="Slide ${i + 1} text">
      </div>`).join('')}
      <button class="btn s" data-a="ssave">Save all settings</button>
    </div>`,

  stats: () => `
    <div class="grid">
      <div class="card"><h3>${d.orders.length}</h3>orders</div>
      <div class="card"><h3>${d.quotes.length}</h3>quote requests</div>
      <div class="card"><h3>${d.users}</h3>customers</div>
      <div class="card"><h3>${money(d.orders.filter(o => o.paid).reduce((a, o) => a + o.total, 0))}</h3>paid revenue</div>
    </div>
    <h3>Page views</h3>
    ${Object.entries(d.views).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `<div class="row"><span>${E(k)}</span><b>${n}</b></div>`).join('')
        || '<p>No data yet.</p>'}`
});

function adminView() {
  // Not signed in
  if (!atk()) {
    return hero('Admin <em>login</em>', '', 1, '') + `
      <section><div class="wrap"><div class="card" style="max-width:420px">
        <h3>Sign in</h3>
        <p>Staff accounts use their email + password. The master key needs no email.</p>
        <label>Email
          <input id="ae" type="email" placeholder="admin@company.com (blank = master key)">
        </label>
        ${field('ap', 'Password', 'password')}
        <p></p>
        <button class="btn" data-a="alogin">Sign in</button>
      </div></div></section>`;
  }

  // Data still loading
  if (!AD) return '<section><div class="wrap">Loading…</div></section>';

  // Staff, customers, settings, audit and financials are reserved for super admins
  const SUPER_ONLY = ['staff', 'customers', 'settings', 'audit'];
  const tabs = ADMIN_TABS.filter(t => !SUPER_ONLY.includes(t) || AD.role === 'super');
  if (!tabs.includes(tab)) tab = 'sales';
  const roleLabel = AD.role === 'super' ? 'Super admin access' : 'Admin access';

  return hero('Admin <em>dashboard</em>', roleLabel, 1, '<button class="btn o" data-a="alogout">Sign out</button>') + `
    <div class="subnav"><div class="wrap">
      ${tabs.map(t => `<button class="${t === tab ? 'on' : ''}" data-a="tab" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div></div>
    <section><div class="wrap">${adminTabs(AD)[tab]()}</div></section>`;
}

const refreshAdmin = async () => {
  AD = await api('/admin/data', {}, 1);
  SALES = null; salesKey = '';                        // sales overview refetches on next view
  await load();
  render();
};


// -----------------------------------------------------------------------------
// 6. ACTIONS  (buttons use data-a="name"; handlers receive the element's dataset)
// -----------------------------------------------------------------------------

const clearFields = ids => ids.forEach(i => $('#' + i).value = '');

// ---- shared loaders ----
let NEWCARD = null, PAYCARD = null, PAYRETRY = '';

async function loadConfig() {
  try { Object.assign(PAYCFG, await api('/checkout/config')); } catch { }
}

const orderQuery = () => {
  const p = new URLSearchParams();
  ['q', 'payment', 'fulfillment', 'refund', 'from', 'to'].forEach(k => { if (OF[k]) p.set(k, OF[k]); });
  return p.toString();
};

async function loadAdminTab() {
  if (!atk() || !AD) return;
  try {
    if (tab === 'orders' && !AO) AO = (await api('/admin/orders?' + orderQuery(), {}, 1)).orders;
    else if (tab === 'invoices' && !AI) { const f = $('#if-q')?.value || ''; AI = await api('/admin/invoices' + (f ? '?q=' + encodeURIComponent(f) : ''), {}, 1); }
    else if (tab === 'payments' && !AP) AP = (await api('/admin/payments', {}, 1)).payments;
    else if (tab === 'audit' && !AA && AD.role === 'super') AA = await api('/admin/audit', {}, 1);
  } catch (e) { toast(e.message); return; }
  render();
}

async function loadOrder(id) {
  const box = $('#orderbox');
  if (!box) return;
  try {
    const o = await api('/orders/' + id);
    box.classList.remove('card');
    box.innerHTML = orderHTML(o);
    document.title = 'Order ' + o.number + ' | JNL Shop';
    if (PAYCFG.mode === 'stripe' && ['requires_payment', 'failed'].includes(o.paymentStatus)) {
      if (!PAYRETRY) { try { PAYRETRY = (await api('/checkout/' + id + '/retry', { method: 'POST', body: {} })).clientSecret; } catch { } }
      await mountPayCard();
    }
  } catch (e) {
    box.innerHTML = `<p class="err">${E(e.message)}</p>`;
  }
}

async function mountPayCard() {
  const host = $('#pay-el');
  if (!host || host.dataset.mounted || !PAYCFG.publishableKey) return;
  host.dataset.mounted = '1';
  try {
    const Stripe = await stripeReady();
    STRIPE = STRIPE || Stripe(PAYCFG.publishableKey);
    const els = STRIPE.elements({ locale: 'en-CA' });
    PAYCARD = els.create('card', { hidePostalCode: true });
    PAYCARD.mount('#pay-el');
  } catch (e) { host.innerHTML = `<p class="err">${E(e.message)}</p>`; }
}

// ---- checkout helpers ----
const newIdem = () => (crypto.randomUUID ? crypto.randomUUID() : 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2));

async function mergeCartAfterAuth() {
  const guest = guestCart();
  if (!guest.length) return;
  try {
    const r = await api('/cart/merge', { method: 'POST', body: { items: guest } });
    cart = r.items || cart;
    localStorage.setItem('cart', '[]');
  } catch { /* keep the local cart if the merge fails */ }
}

async function refreshQuote() {
  if (!CO) return;
  collectCO();
  const body = { items: cart, postalCode: CO.postal, province: CO.province, shippingMethod: CO.method, discountCode: CO.discount };
  try { Q = await api('/checkout/quote', { method: 'POST', body }); }
  catch (e) { Q = { ok: false, error: e.message }; }
  const s = $('#cosum'); if (s) s.innerHTML = summaryHTML();
  const m = $('#comethods'); if (m) m.innerHTML = methodRadios();
  if (Q && Q.shippingMethods && Q.shippingMethods.length && !Q.shippingMethods.some(o => o.id === CO.method)) {
    CO.method = Q.shippingMethods[0].id;
    if (m) m.innerHTML = methodRadios();
  }
}
let quoteTimer;
const queueQuote = () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(refreshQuote, 320); };
const renderSummary = () => { const s = $('#cosum'); if (s) s.innerHTML = summaryHTML(); };

function finishOrder(id) {
  cart = [];
  saveCart();
  CO = null; Q = null;
  ACCT.orders = null; ACCT.invoices = null;
  location.hash = '#/order/' + id;
}

async function payStripe() {
  const Stripe = await stripeReady();
  STRIPE = STRIPE || Stripe(PAYCFG.publishableKey);
  let res;
  if (CO.savedCard) {
    res = await STRIPE.confirmCardPayment(CO.clientSecret, { payment_method: CO.savedCard });
  } else {
    const host = $('#card-el');
    if (!CARD && host) {
      host.dataset.mounted = '';
      mountCard();
      await new Promise(r => setTimeout(r, 600));
    }
    if (!CARD) throw new Error('The card form did not load. Please refresh and try again.');
    res = await STRIPE.confirmCardPayment(CO.clientSecret, {
      payment_method: {
        card: CARD,
        billing_details: {
          name: CO.name, email: CO.email, phone: CO.phone,
          address: { line1: CO.street, city: CO.city, state: CO.province, postal_code: CO.postal, country: 'CA' }
        }
      }
    });
  }
  if (res.error) throw new Error(res.error.message || 'Your card was declined');
  if (res.paymentIntent && res.paymentIntent.status === 'succeeded') {
    // The webhook is authoritative; sync once so the UI reflects it immediately
    try { await api('/checkout/' + CO.order.id + '/sync', { method: 'POST' }); } catch { }
    return finishOrder(CO.order.id);
  }
  throw new Error('Your bank needs a moment to confirm this payment. Check the order page shortly.');
}

async function doSignOut() {
  try { if (me) await api('/auth/logout', { method: 'POST' }); } catch { }
  localStorage.removeItem('tk');
  localStorage.removeItem('me');
  sessionStorage.removeItem('atk');
  me = null; AD = null; SALES = null; salesKey = ''; tab = 'sales';
  ACCT = { orders: null, invoices: null, methods: null, notifications: null };
  ADMIN_ORDER = null; AO = null; AI = null; AP = null; AA = null;
  CO = null; Q = null; pendingCheckout = false; authMode = 'login';
  await loadCart();
  if (location.hash.startsWith('#/admin') || location.hash.startsWith('#/account') || location.hash.startsWith('#/order') || location.hash.startsWith('#/checkout')) location.hash = '#/';
  render();
  toast('Signed out');
}

const acts = {

  // ---- Shop / navigation ----
  cat:     d => { cat = d.v; render(); },
  explore: () => { $('#svc').classList.remove('hid'); $('#svc').scrollIntoView(); },

  // ---- Cart ----
  add: d => {
    const p = S.products.find(x => x.id === d.id);
    if (!p) return;
    const stock = Number.isFinite(p.stock) ? p.stock : 0;
    if (stock <= 0) return toast('That product is out of stock');
    const l = cart.find(x => x.id === d.id);
    if (l) {
      if (l.qty >= stock) return toast('Only ' + stock + ' in stock');
      l.qty++;
    } else cart.push({ id: d.id, qty: 1 });
    saveCart();
    toast(p.n + ' added to cart');
  },
  qty: d => {
    const l = cart.find(x => x.id === d.id);
    if (!l) return;
    const p = S.products.find(x => x.id === d.id);
    const stock = p && Number.isFinite(p.stock) ? p.stock : 99;
    l.qty = Math.min(stock, Math.max(1, l.qty + Number(d.d)));
    saveCart();
    render();
  },
  rm: d => {
    cart = cart.filter(x => x.id !== d.id);
    saveCart();
    render();
  },

  // ---- Theme & carousel ----
  theme: () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', theme); } catch { }
    applyTheme();
    if (STRIPE && CARD) { /* Elements keep their own styling */ }
  },
  car: d => carGo(CAR.i + Number(d.d)),
  cardot: d => carGo(Number(d.i)),
  carshop: () => { document.querySelector('.shopbar')?.scrollIntoView({ behavior: 'smooth' }); },

  // ---- Checkout ----
  checkout: () => {
    if (!cartLines().length) return toast('Your cart is empty');
    if (!me) {
      pendingCheckout = true; authMode = 'register';
      location.hash = '#/account';
      render();
      toast('Create an account to check out — your cart is saved');
      return;
    }
    CO = CO || freshCO();
    location.hash = '#/checkout';
  },
  setship: () => {
    collectCO();
    const el = document.querySelector('input[name="ship"]:checked');
    if (el) CO.method = el.value;
    refreshQuote();
  },
  setpay: () => {
    collectCO();
    const el = document.querySelector('input[name="pay"]:checked');
    if (el) CO.pay = el.value;
    const host = $('#copay');
    if (host) host.innerHTML = payPanel();
    if (CO.pay === 'card') mountCard();
    renderSummary();
  },
  setsaved: () => {
    collectCO();
    const el = document.querySelector('input[name="saved"]:checked');
    CO.savedCard = el ? el.value : '';
    const host = $('#copay');
    if (host) host.innerHTML = payPanel();
    if (!CO.savedCard) mountCard();
  },
  applydisc: () => { collectCO(); refreshQuote(); },
  place: async () => {
    collectCO();
    if (!CO || CO.busy) return;
    CO.error = '';
    CO.busy = true; renderSummary();
    try {
      if (CO.postal) CO.postal = CO.postal.toUpperCase();
      if (!CO.idem) CO.idem = newIdem();
      const r = await api('/checkout', {
        method: 'POST', idem: CO.idem,
        body: {
          items: cart, name: CO.name, email: CO.email, phone: CO.phone,
          street: CO.street, city: CO.city, province: CO.province, postalCode: CO.postal,
          shippingMethod: CO.method, paymentMethod: CO.pay, discountCode: CO.discount,
          saveCard: CO.saveCard, savedPaymentMethodId: CO.savedCard || ''
        }
      });
      CO.order = r.order; CO.clientSecret = r.clientSecret; CO.mode = r.mode;
      if (CO.pay !== 'card') return finishOrder(r.order.id);
      if (!r.clientSecret && r.order.paymentStatus === 'paid') return finishOrder(r.order.id);
      if (r.mode !== 'stripe') { CO.busy = false; renderSummary(); return; }
      await payStripe();
    } catch (e) {
      CO.busy = false;
      CO.error = e.message;
      if (e.status === 409 || e.status === 422 || e.status === 502) CO.order = null;
      renderSummary();
    }
  },
  sbx: async d => {
    if (!CO || !CO.order || CO.busy) return;
    CO.busy = true; renderSummary();
    try {
      const r = await api('/payments/sandbox/confirm', { method: 'POST', body: { orderId: CO.order.id, outcome: d.v } });
      if (r.order.paymentStatus === 'paid') return finishOrder(CO.order.id);
      CO.busy = false;
      CO.error = d.v === 'fail' ? 'Sandbox card declined. Choose another card and try again.'
        : d.v === 'auth' ? 'Authentication required. Complete it with the payment provider, then retry.'
        : 'Payment not completed yet.';
      renderSummary();
    } catch (e) { CO.busy = false; CO.error = e.message; renderSummary(); }
  },

  // ---- Public forms ----
  msg: async () => {
    await api('/messages', {
      method: 'POST',
      body: { name: v('mn'), email: v('me'), body: v('mb'), website: v('mw') }
    });
    toast('Message sent. Thank you!');
    clearFields(['mn', 'me', 'mb']);
  },
  quote: async () => {
    await api('/quotes', {
      method: 'POST',
      body: { name: v('qn'), email: v('qe'), phone: v('qp'), service: v('qs'), details: v('qd'), website: v('mw') }
    });
    toast('Quote request sent!');
    clearFields(['qn', 'qe', 'qp', 'qd']);
  },
  // ---- Customer auth ----
  swap: () => { authMode = authMode === 'login' ? 'register' : 'login'; render(); },
  auth: async () => {
    const body = { email: v('re'), password: v('rp') };
    if (authMode === 'register') body.name = v('rn');
    const r = await api('/auth/' + authMode, { method: 'POST', body });
    localStorage.setItem('tk', r.token);
    me = r.user;
    localStorage.setItem('me', JSON.stringify(me));
    ACCT = { orders: null, invoices: null, methods: null, notifications: null };
    await mergeCartAfterAuth();
    await loadCart();
    await loadConfig();
    toast(authMode === 'register' ? 'Account created' : 'Signed in');
    if (pendingCheckout) { pendingCheckout = false; location.hash = '#/checkout'; }
    else render();
  },
  logout: () => doSignOut(),
  // Navbar sign out: clears the customer session AND the staff token in one go
  signout: () => doSignOut(),

  // ---- Customer dashboard ----
  atab: d => { acctTab = d.v; render(); },
  invoice: async d => {
    try { await dlFile('/invoices/' + d.id + '/pdf', 'invoice.pdf'); }
    catch (e) { toast(e.message); }
  },
  ainvoice: async d => {
    try { await dlFile('/admin/invoices/' + d.id + '/pdf', 'invoice.pdf', true); }
    catch (e) { toast(e.message); }
  },
  pfsave: async () => {
    const r = await api('/me/profile', { method: 'PATCH', body: { name: v('pf-name'), phone: v('pf-phone') } });
    me = { ...me, ...r.user };
    localStorage.setItem('me', JSON.stringify(me));
    toast('Profile saved');
    render();
  },
  pwchange: async () => {
    await api('/auth/password', { method: 'POST', body: { currentPassword: v('pw-old'), newPassword: v('pw-new') } });
    toast('Password updated — please sign in again');
    doSignOut();
  },
  notifread: async () => {
    await api('/me/notifications/read', { method: 'POST' });
    ACCT.notifications = null;
    loadAccount();
  },
  pmdef: async d => {
    const r = await api('/payments/methods/' + d.id + '/default', { method: 'POST' });
    ACCT.methods = r.methods;
    loadAccount();
    toast('Default card updated');
  },
  pmdel: async d => {
    if (!confirm('Remove this saved card?')) return;
    const r = await api('/payments/methods/' + d.id, { method: 'DELETE' });
    ACCT.methods = r.methods;
    loadConfig();
    loadAccount();
    toast('Card removed');
  },
  addcard: async () => {
    try {
      const si = await api('/payments/methods/setup-intent', { method: 'POST' });
      const host = $('#newcard');
      if (si.mode === 'stripe') {
        const Stripe = await stripeReady();
        STRIPE = STRIPE || Stripe(si.publishableKey);
        ELEMENTS = STRIPE.elements({ locale: 'en-CA' });
        const el = ELEMENTS.create('card', { hidePostalCode: true });
        host.innerHTML = '<div id="newcard-el" class="stripe-el"></div><button class="btn s" data-a="savesetup" data-id="' + E(si.clientSecret) + '">Save card</button>';
        el.mount('#newcard-el');
        NEWCARD = el;
      } else {
        const pm = await api('/payments/sandbox/setup', { method: 'POST', body: { setupIntentId: si.setupIntentId } });
        const r = await api('/payments/methods', { method: 'POST', body: { paymentMethodId: pm.paymentMethodId } });
        ACCT.methods = r.methods;
        await loadConfig();
        loadAccount();
        toast('Test card saved');
      }
    } catch (e) { toast(e.message); }
  },
  savesetup: async d => {
    try {
      const Stripe = await stripeReady();
      const r = await STRIPE.confirmCardSetup(d.id, { payment_method: { card: NEWCARD } });
      if (r.error) throw new Error(r.error.message);
      const saved = await api('/payments/methods', { method: 'POST', body: { paymentMethodId: r.setupIntent.payment_method } });
      ACCT.methods = saved.methods;
      await loadConfig();
      loadAccount();
      toast('Card saved');
    } catch (e) { toast(e.message); }
  },
  retry: async d => {
    try {
      const r = await api('/checkout/' + d.id + '/retry', { method: 'POST', body: {} });
      if (r.mode === 'sandbox') {
        const out = await api('/payments/sandbox/confirm', { method: 'POST', body: { orderId: d.id, outcome: 'succeed' } });
        await loadOrder(d.id);
        toast(out.order.paymentStatus === 'paid' ? 'Payment complete' : 'Payment not completed');
      } else {
        PAYRETRY = r.clientSecret;
        await loadOrder(d.id);
        await mountPayCard();
        toast('Enter your card to complete payment');
      }
    } catch (e) { toast(e.message); }
  },
  payorder: async d => {
    try {
      if (!PAYCARD) throw new Error('The card form is still loading');
      const o = await api('/orders/' + d.id);
      const res = await STRIPE.confirmCardPayment(PAYRETRY, { payment_method: { card: PAYCARD, billing_details: { name: o.shippingAddress.name, email: o.email, address: { line1: o.shippingAddress.street, city: o.shippingAddress.city, state: o.shippingAddress.province, postal_code: o.shippingAddress.postalCode, country: 'CA' } } } });
      if (res.error) throw new Error(res.error.message);
      await api('/checkout/' + d.id + '/sync', { method: 'POST' });
      await loadOrder(d.id);
      toast('Payment received');
    } catch (e) { toast(e.message); }
  },
  ocancel: async d => {
    if (!confirm('Cancel this order?')) return;
    try {
      await api('/checkout/' + d.id + '/cancel', { method: 'POST' });
      await loadOrder(d.id);
      toast('Order cancelled');
    } catch (e) { toast(e.message); }
  },

  // ---- Admin: orders / invoices / payments / audit ----
  ofilter: () => {
    OF = { q: v('of-q'), payment: v('of-pay'), fulfillment: v('of-ful'), refund: v('of-ref'), from: v('of-from'), to: v('of-to') };
    AO = null; ADMIN_ORDER = null;
    loadAdminTab();
  },
  oopen: async d => {
    try { ADMIN_ORDER = await api('/admin/orders/' + d.id, {}, 1); AO = AO || []; render(); }
    catch (e) { toast(e.message); }
  },
  oclose: () => { ADMIN_ORDER = null; render(); },
  oful: async d => {
    try {
      await api('/admin/orders/' + d.id + '/fulfillment', {
        method: 'PATCH',
        body: { fulfillmentStatus: v('oful-st'), carrier: v('oful-car'), trackingNumber: v('oful-trk'), trackingUrl: v('oful-url'), note: v('oful-note') }
      }, 1);
      ADMIN_ORDER = await api('/admin/orders/' + d.id, {}, 1);
      AO = null; await loadAdminTab(); toast('Fulfillment updated');
    } catch (e) { toast(e.message); }
  },
  otrack: async d => {
    try {
      await api('/admin/orders/' + d.id + '/tracking', { method: 'POST', body: { status: v('otrk-st'), location: v('otrk-loc'), description: v('otrk-desc') } }, 1);
      ADMIN_ORDER = await api('/admin/orders/' + d.id, {}, 1);
      render(); toast('Tracking event added (manual entry)');
    } catch (e) { toast(e.message); }
  },
  orefund: async d => {
    const amt = Number(v('oref-amt'));
    if (!(amt > 0)) return toast('Enter a refund amount');
    if (!confirm('Refund ' + moneyC(Math.round(amt * 100)) + ' through the payment provider?')) return;
    try {
      await api('/admin/orders/' + d.id + '/refund', { method: 'POST', body: { amountCents: Math.round(amt * 100), reason: v('oref-why') } }, 1);
      ADMIN_ORDER = await api('/admin/orders/' + d.id, {}, 1);
      AO = null; AP = null; AI = null; await loadAdminTab(); toast('Refund submitted');
    } catch (e) { toast(e.message); }
  },
  ocsv: async () => {
    try { await dlFile('/admin/orders.csv?' + orderQuery(), 'orders.csv', true); toast('Order export downloaded'); }
    catch (e) { toast(e.message); }
  },
  ifilter: () => { AI = null; loadAdminTab(); },

  // ---- Admin auth / tabs ----
  alogin: async () => {
    const r = await api('/admin/login', { method: 'POST', body: { email: v('ae').trim(), password: v('ap') } });
    sessionStorage.setItem('atk', r.token);
    AD = null; SALES = null; salesKey = '';
    tab = 'sales';
    render();
  },
  alogout: () => { sessionStorage.removeItem('atk'); AD = null; SALES = null; salesKey = ''; render(); },
  tab:     d  => { tab = d.v; pend = null; render(); },

  // ---- Admin: sales report filters & CSV download ----
  srange:  d  => { SF = { range: d.v, from: '', to: '' }; render(); },
  scustom: ()  => {
    const f = v('sfrom'), t = v('sto');
    if (!f && !t) { SF = { range: SF.range || '7d', from: '', to: '' }; toast('Showing ' + (SALES_RANGES.find(x => x[0] === SF.range) || ['', 'period'])[1].toLowerCase()); }
    else SF = { range: '', from: f, to: t };
    render();
  },
  scsv:    ()  => dl('/admin/sales.csv?' + sfQuery()).then(() => toast('Report downloaded')),

  // ---- Admin: staff accounts (super admin) ----
  stsave: async () => {
    await api('/admin/staff', {
      method: 'POST',
      body: { name: v('stn'), email: v('ste'), password: v('stp'), role: v('str') }
    }, 1);
    toast('Staff account created');
    clearFields(['stn', 'ste', 'stp']);
    await refreshAdmin();
  },
  strole: async d => {
    await api('/admin/staff/' + d.id, { method: 'PATCH', body: { role: d.v } }, 1);
    toast('Role updated');
    await refreshAdmin();
  },
  stdelete: async d => {
    if (confirm('Remove this staff account?')) {
      await api('/admin/staff/' + d.id, { method: 'DELETE' }, 1);
      toast('Staff account removed');
      await refreshAdmin();
    }
  },

  // ---- Admin: products ----
  psave: async () => {
    const old = S.products.find(p => p.id === v('aid')) || {};
    await api('/admin/products', {
      method: 'PUT',
      body: {
        id:  v('aid') || undefined,
        n:   v('an'),
        pr:  v('ap2'),
        cat: v('ac'),
        ic:  v('ai'),
        d:   v('ad'),
        stock: v('astk'),
        img: pend || old.img || ''
      }
    }, 1);
    pend = null;
    toast('Saved');
    await refreshAdmin();
  },
  pedit: d => {
    const p = S.products.find(x => x.id === d.id);
    $('#an').value  = p.n;
    $('#ap2').value = p.pr;
    $('#ac').value  = p.cat;
    $('#ai').value  = icName(p.ic);
    $('#ad').value  = p.d;
    $('#astk').value = Number.isFinite(p.stock) ? p.stock : 0;
    $('#aid').value = p.id;
    scrollTo(0, 0);
  },
  pdel: async d => {
    if (confirm('Delete this product?')) {
      await api('/admin/products/' + d.id, { method: 'DELETE' }, 1);
      await refreshAdmin();
    }
  },

  // ---- Admin: projects ----
  jsave: async () => {
    await api('/admin/projects', { method: 'PUT', body: { t: v('jt'), d: v('jd'), img: pend || '' } }, 1);
    pend = null;
    toast('Project added');
    await refreshAdmin();
  },
  jdel: async d => {
    if (confirm('Delete this project?')) {
      await api('/admin/projects/' + d.id, { method: 'DELETE' }, 1);
      await refreshAdmin();
    }
  },

  // ---- Admin: settings ----
  ssave: async () => {
    const body = {};
    Object.keys(C()).forEach(k => {
      const el = $('#s_' + k);
      if (el) body[k] = el.value;
    });
    if (pend) body[pend.k] = pend.d;               // pending logo / hero image

    const q = id => { const e = $('#' + id); return e ? e.value : null; };
    body.shipping = {
      freeOverCents: Math.round(Number(q('s_free') || 0) * 100),
      perKgCents: Math.round(Number(q('s_perkg') || 0) * 100),
      maxWeightKg: Number(q('s_maxw') || 500),
      zones: (C().shipping.zones || []).map((z, i) => ({
        id: z.id, label: q('sz_' + i + '_label') || z.label,
        prefixes: String(q('sz_' + i + '_prefixes') || '').split(',').map(s => s.trim()).filter(Boolean),
        cents: Math.round(Number(q('sz_' + i + '_amt') || 0) * 100)
      }))
    };
    body.tax = { onShipping: !$('#s_taxon') || $('#s_taxon').checked, rates: {} };
    (S.provinces || []).forEach(p => {
      const e = $('#st_' + p[0]);
      if (e) body.tax.rates[p[0]] = { label: C().tax.rates[p[0]]?.label || p[0], rate: Number(e.value) || 0 };
    });
    body.carousel = (C().carousel || []).map((s, i) => ({
      img: q('sc_' + i + '_img') || s.img,
      title: q('sc_' + i + '_title') ?? s.title,
      text: q('sc_' + i + '_text') ?? s.text
    }));

    await api('/admin/settings', { method: 'PUT', body }, 1);
    pend = null;
    toast('Settings saved');
    await refreshAdmin();
  },
  rmhero: async () => {
    await api('/admin/settings', { method: 'PUT', body: { heroImg: '' } }, 1);
    await refreshAdmin();
  },

  // ---- Admin: orders ----
  opaid: async d => {
    await api('/admin/orders/' + d.id, { method: 'PATCH', body: { paid: !!d.p } }, 1);
    await refreshAdmin();
  }
};


// -----------------------------------------------------------------------------
// 7. EVENT WIRING
// -----------------------------------------------------------------------------

// Click delegation for every [data-a] button
app.onclick = async e => {
  const b = e.target.closest('[data-a]');
  if (!b || b.tagName === 'SELECT') return;
  try { await acts[b.dataset.a](b.dataset); }
  catch (err) { toast(err.message); }
};

// Status dropdowns in the admin (quotes)
app.onchange = async e => {
  const t = e.target;
  if (t.tagName !== 'SELECT' || !t.dataset.a) return;
  try {
    const kind = t.dataset.a === 'ostat' ? 'orders' : 'quotes';
    await api('/admin/' + kind + '/' + t.dataset.id, { method: 'PATCH', body: { status: t.value } }, 1);
    toast('Updated');
  } catch (err) { toast(err.message); }
};

// Mobile menu (animated open/close) + hash routing
const setMenu = open => {
  $('#menu').classList.toggle('open', open);
  const mb = $('#mb');
  mb.classList.toggle('x', open);
  mb.innerHTML = open ? '<i class="uil uil-times"></i>' : '<i class="uil uil-bars"></i>';
  mb.setAttribute('aria-expanded', String(open));
};

$('#mb').onclick = () => setMenu(!$('#menu').classList.contains('open'));
$('#outa').onclick = e => { e.preventDefault(); setMenu(false); acts.signout(); };
$('#menu').onclick = e => { if (e.target.closest('a')) setMenu(false); };
addEventListener('hashchange', render);


// -----------------------------------------------------------------------------
// 8. ROUTER / RENDER
// -----------------------------------------------------------------------------

async function render() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, sub] = raw.split('#');
  const seg = (pathPart || '').split('/');
  const r = seg[0] || '';
  const param = seg[1] || '';

  setMenu(false);
  brand();
  applyTheme();

  // Highlight the active nav link
  document.querySelectorAll('#menu a').forEach(a =>
    a.classList.toggle('on', a.getAttribute('href') === '#/' + r));

  const name = C().name || 'JNL';
  document.title = r === '' ? name + ' | Engineering, Distribution & Procurement'
    : r === 'shop' ? 'JNL Shop | ' + name
    : r === 'admin' ? 'Admin dashboard | ' + name
    : r === 'account' ? 'Your account | ' + name
    : r === 'cart' ? 'Cart | ' + name
    : r === 'checkout' ? 'Checkout | ' + name
    : r === 'order' ? 'Order | ' + name
    : r === 'engineering' ? 'Project Engineering | ' + name
    : r === 'about' ? 'About | ' + name
    : name;

  // Pick the view for the current route
  app.innerHTML =
      r === 'engineering' ? eng()
    : r === 'shop'        ? shop()
    : r === 'cart'        ? cartView()
    : r === 'checkout'    ? checkout()
    : r === 'order'       ? orderPage()
    : r === 'account'     ? account()
    : r === 'admin'       ? adminView()
    : r === 'about'       ? hero(E(C().hero), C().tag, 1,
                                  '<a class="btn" href="#/contact">Talk to us</a>', PIC.construction) + aboutSec()
    :                       home();

  // Shop: live search that keeps the caret position + carousel
  if (r === 'shop') {
    initCarousel();
    const s = $('#qs');
    if (s) s.oninput = () => {
      q = s.value.toLowerCase();
      const pos = s.selectionStart;
      render().then(() => {
        const n = $('#qs');
        if (!n) return;
        n.focus();
        n.setSelectionRange(pos, pos);
      });
    };
  }

  // Checkout: live shipping/tax quote and Stripe Elements
  if (r === 'checkout' && CO) {
    mountCard();
    ['co-postal', 'co-prov'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('change', () => { collectCO(); if (CO.postal.length >= 6) queueQuote(); });
    });
    const d = $('#co-disc');
    if (d) d.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); acts.applydisc(); } });
    if (!Q && CO.postal.length >= 6) refreshQuote();
  }

  // Order detail: loaded from the API with an ownership check
  if (r === 'order' && param && me) loadOrder(param);

  // Account dashboard
  if (r === 'account' && me) loadAccount();

  // Admin: load data once signed in
  if (r === 'admin' && atk() && !AD) {
    try { AD = await api('/admin/data', {}, 1); render(); }
    catch (e) { render(); }
    return;
  }

  // Admin: image pickers
  if (r === 'admin') {
    img('aim', 700,  d => { pend = d;                     $('#ast').innerHTML = 'Photo ready <i class="uil uil-check-circle"></i>'; });
    img('jim', 900,  d => { pend = d;                     $('#jst').innerHTML = 'Photo ready <i class="uil uil-check-circle"></i>'; });
    img('slg', 256,  d => { pend = { k: 'logo',    d };   toast('Logo ready: press Save'); });
    img('shi', 1600, d => { pend = { k: 'heroImg', d };   toast('Hero image ready: press Save'); });
  }

  // Admin: sales overview for the selected period
  if (r === 'admin' && tab === 'sales' && AD && salesKey !== sfQuery()) {
    const want = sfQuery();
    api('/admin/sales?' + want, {}, 1).then(d => {
      if (sfQuery() !== want) return;
      SALES = d; salesKey = want;
      if (location.hash === '#/admin' && tab === 'sales') render();
    }).catch(err => toast(err.message));
  }

  // Admin: orders / invoices / payments / audit
  if (r === 'admin' && AD && ['orders', 'invoices', 'payments', 'audit'].includes(tab)) {
    const need = (tab === 'orders' && !AO) || (tab === 'invoices' && !AI) ||
      (tab === 'payments' && !AP) || (tab === 'audit' && !AA && AD.role === 'super');
    if (need) loadAdminTab();
  }

  // Scroll-reveal animation
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => entries.forEach(x => {
      if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); }
    }), { threshold: .1 });
    document.querySelectorAll('.rv').forEach(x => io.observe(x));
  } else {
    document.querySelectorAll('.rv').forEach(x => x.classList.add('in'));
  }

  // Scroll position
  if (r === 'contact')                  setTimeout(() => $('#contact')?.scrollIntoView(), 0);
  else if (sub)                         setTimeout(() => $('#' + sub)?.scrollIntoView(), 0);
  else if (!(r === 'shop' && q))        scrollTo(0, 0);

  // Page-view tracking (once per hash change)
  if (!render.last || render.last !== location.hash) {
    render.last = location.hash;
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: (r || 'home') + (param ? '/' + param : '') })
    }).catch(() => { });
  }
}

// Boot
(async () => {
  initTheme();
  $('#tt').onclick = () => acts.theme();
  await Promise.all([load(), loadConfig()]);
  if (me) await loadCart();
  await render();
})().catch(() => {
  app.innerHTML = '<section><div class="wrap"><h2>Site is starting up…</h2><p>Make sure the server is running (npm start).</p></div></section>';
});