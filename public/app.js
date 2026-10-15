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

let cart = JSON.parse(localStorage.getItem('cart') || '[]');
let me   = JSON.parse(localStorage.getItem('me')   || 'null');

// Shorthands
const C     = () => S.c;
const money = n  => E(C().cur) + Number(n).toLocaleString();
const v     = id => $('#' + id).value;
const atk   = () => sessionStorage.getItem('atk');      // admin token

// API wrapper (pass admin=true to use the admin token)
async function api(path, opts = {}, admin) {
  const token = admin ? atk() : localStorage.getItem('tk') || '';
  const r = await fetch('/api' + path, {
    method:  opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body:    opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (admin && r.status === 401) sessionStorage.removeItem('atk');
    throw new Error(j.error || 'Something went wrong');
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

const saveCart = () => {
  localStorage.setItem('cart', JSON.stringify(cart));
  brand();
};

const load = async () => { S = await api('/site'); };


// -----------------------------------------------------------------------------
// 2. ARTWORK (SVG)
// -----------------------------------------------------------------------------

const grid =
  '<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse">' +
  '<path d="M40 0H0V40" fill="none" stroke="#fff" stroke-opacity=".07"/></pattern></defs>' +
  '<rect width="800" height="500" fill="url(#g)"/>';

// Opening <svg> with gradient background + grid (caller closes the </svg>)
const skyline = (id, endColor) => `
  <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${id == 'a1' ? '#10224a' : '#2b1a0c'}"/>
        <stop offset="1" stop-color="${endColor}"/>
      </linearGradient>
    </defs>
    <rect width="800" height="500" fill="url(#${id})"/>${grid}`;

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
      <rect width="800" height="500" fill="url(#h)"/>${grid}
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

  $('#fn').textContent = c.name + '. All rights reserved.';
  $('#yr').textContent = new Date().getFullYear();
  $('#ft').textContent = (c.email || '') + ' · ' + (c.phone || '');

  // Footer columns
  const set = (id, txt) => { const el = $('#' + id); if (el) el.textContent = txt || ''; };
  const fl = $('#fblurb'); if (fl) fl.textContent = c.tag || '';
  set('fem',   c.email && '📧 ' + c.email);
  set('fph',   c.phone && '📞 ' + c.phone);
  set('faddr', c.addr  && '📍 ' + c.addr);
  set('fhrs',  c.hours && '🕒 ' + c.hours);
  $('#cc').textContent = cart.reduce((a, b) => a + b.qty, 0);
  document.title = c.name + ' | Engineering, Distribution & Procurement';

  // Floating WhatsApp button
  const w = $('#wa');
  if (c.whatsapp) {
    w.href = 'https://wa.me/' + c.whatsapp.replace(/\D/g, '') +
             '?text=' + encodeURIComponent('Hello, I have an enquiry.');
    w.classList.remove('hid');
  } else {
    w.classList.add('hid');
  }

  $('#acct').textContent = me ? '👤 ' + me.name.split(' ')[0] : 'Account';

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
          <p>📧 ${E(email)}<br>📞 ${E(phone)}<br>📍 ${E(C().addr)}<br>🕒 ${E(C().hours)}</p>
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

const pcard = p => `
  <div class="card">
    <div class="pimg">${p.img ? `<img alt="${E(p.n)}" src="${E(p.img)}">` : E(p.ic || '📦')}</div>
    <div class="tag">${E(p.cat)}</div>
    <h3>${E(p.n)}</h3>
    <p>${E(p.d)}</p>
    <div class="price">${money(p.pr)}</div>
    <p></p>
    <button class="btn s" data-a="add" data-id="${p.id}">Add to cart</button>
    ${C().whatsapp
      ? `<a class="btn s d" target="_blank" rel="noopener"
            href="https://wa.me/${C().whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent('Hi, I want to order: ' + p.n)}">WhatsApp</a>`
      : ''}
  </div>`;


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
             <p>Design, installation, commissioning and project management.</p>
             <span class="btn s">Explore →</span>
           </div>
         </a>
         <a class="div" href="#/shop">
           <img class="bg" alt="" src="${PIC.warehouse}">
           <div class="t">
             <span class="dtag">02 — Supply</span>
             <h3>Distribution &amp; Procurement</h3>
             <p>An online shop of quality products at clear prices.</p>
             <span class="btn s">Shop now →</span>
           </div>
         </a>
       </div>
     </div>
   </section>` +

  (S.products.length
    ? `<section><div class="wrap rv">
         <span class="eyebrow">Featured</span>
         <h2>From the shop</h2>
         <p class="sub"></p>
         <div class="grid">${S.products.slice(0, 3).map(pcard).join('')}</div>
       </div></section>`
    : '') +

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
  ['📐',  'Design & Consulting',          'Feasibility, detailed design and technical studies.'],
  ['⚙️', 'Installation & Commissioning', 'Mechanical, electrical and process installation.'],
  ['📋',  'Project Management',           'Planning, cost control and site supervision.'],
  ['🛠️', 'Maintenance',                  'Scheduled and emergency maintenance support.']
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
     <div class="grid">
       ${SERVICES.map(s => `<div class="card"><div class="ic">${s[0]}</div><h3>${s[1]}</h3><p>${s[2]}</p></div>`).join('')}
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
function shop() {
  const cats = ['All', ...new Set(S.products.map(p => p.cat).filter(Boolean))];
  if (!cats.includes(cat)) cat = 'All';

  const list = S.products.filter(p =>
    (cat === 'All' || p.cat === cat) && (p.n + p.d).toLowerCase().includes(q)
  );

  return hero('Online <em>Shop</em>', 'Distribution & procurement: quality products, clear prices.', 1,
              '<a class="btn" href="#/cart">View cart</a>', PIC.logistics) +

    `<div class="subnav"><div class="wrap">
       ${cats.map(c => `<button class="${c === cat ? 'on' : ''}" data-a="cat" data-v="${E(c)}">${E(c)}</button>`).join('')}
       <input id="qs" placeholder="Search products…" value="${E(q)}">
     </div></div>
     <section><div class="wrap">
       <div class="grid">${list.map(pcard).join('') || '<p class="empty">🔍<br>No products match your search.</p>'}</div>
     </div></section>` +

    contact('Shop contact', C().shopEmail, C().shopPhone);
}


// ---- Cart & checkout ----
function cartView() {
  const lines = cart
    .map(l => ({ ...l, p: S.products.find(p => p.id === l.id) }))
    .filter(l => l.p);
  const total = lines.reduce((a, l) => a + l.p.pr * l.qty, 0);

  const body = lines.length
    ? `<div class="card">
         ${lines.map(l => `
           <div class="row">
             <span>${E(l.p.ic)} ${E(l.p.n)} · ${money(l.p.pr)}</span>
             <span>
               <button class="btn s d" data-a="qty" data-id="${l.id}" data-d="-1">−</button>
               ${l.qty}
               <button class="btn s d" data-a="qty" data-id="${l.id}" data-d="1">+</button>
               <button class="btn s d" data-a="rm"  data-id="${l.id}">✕</button>
             </span>
           </div>`).join('')}
         <h3 style="text-align:right">Total: ${money(total)}</h3>
       </div>

       <h2 style="margin-top:36px">Checkout</h2>
       <div class="card">
         <div class="f">
           <input id="on" placeholder="Full name" value="${E(me?.name)}">
           <input id="op" placeholder="Phone">
           <input id="oe" placeholder="Email" value="${E(me?.email)}">
         </div>
         <textarea id="oa" rows="2" placeholder="Delivery address"></textarea>
         <p></p>
         <select id="om">
           <option value="cod">Pay on delivery</option>
           <option value="bank">Bank transfer</option>
           ${C().card ? '<option value="card">Card (online)</option>' : ''}
         </select>
         <p></p>
         <button class="btn" data-a="order">Place order</button>
       </div>`
    : '<p>Your cart is empty. <a href="#/shop"><b>Browse the shop →</b></a></p>';

  return hero('Your <em>Cart</em>', 'Review your items and check out.', 1, '') +
         `<section><div class="wrap">${body}</div></section>`;
}

// ---- Thank-you page ----
const thanks = () => {
  const o = JSON.parse(sessionStorage.getItem('last') || '{}');
  return hero('Thank <em>you</em>', 'Your order has been received.', 1, '') + `
    <section><div class="wrap"><div class="card">
      <h3>Order ${E(o.id || '')}</h3>
      <p>We'll contact you shortly to confirm.</p>
      ${o.method === 'bank' ? `<p><b>Bank details:</b> ${E(C().bank)}</p>` : ''}
      <a class="btn s" href="#/shop">Continue shopping</a>
    </div></div></section>`;
};

// ---- Customer account ----
function account() {
  if (!me) {
    const login = authMode === 'login';
    return hero('Your <em>Account</em>', 'Sign in to view your orders.', 1, '') + `
      <section><div class="wrap">
        <div class="card auth">
          <h3>${login ? 'Sign in' : 'Create account'}</h3>
          ${login ? '' : field('rn', 'Full name')}
          ${field('re', 'Email', 'email')}
          ${field('rp', 'Password (8+ characters)', 'password')}
          <p></p>
          <button class="btn" data-a="auth">${login ? 'Sign in' : 'Register'}</button>
          <button class="btn d" data-a="swap">${login ? 'New here? Register' : 'Have an account? Sign in'}</button>
        </div>
      </div></section>`;
  }

  return hero('Hello, <em>' + E(me.name.split(' ')[0]) + '</em>', 'Your order history.', 1,
              '<button class="btn o" data-a="logout">Sign out</button>') +
    `<section><div class="wrap"><div id="myo" class="card">Loading…</div></div></section>`;
}


// -----------------------------------------------------------------------------
// 5. ADMIN VIEW
// -----------------------------------------------------------------------------

const ORDER_STATUSES = ['new', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled'];
const QUOTE_STATUSES = ['new', 'contacted', 'won', 'closed'];
const ADMIN_TABS     = ['sales', 'products', 'orders', 'quotes', 'messages', 'projects', 'staff', 'settings', 'stats'];
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
  ['cur',          'Currency symbol'],
  ['currencyCode', 'Currency code (usd, ngn, eur)'],
  ['email',        'Main email'],
  ['phone',        'Main phone'],
  ['shopEmail',    'Shop email'],
  ['shopPhone',    'Shop phone'],
  ['whatsapp',     'WhatsApp number (with country code)'],
  ['gaId',         'Google Analytics ID (G-XXXX)'],
  ['hours',        'Business hours'],
  ['addr',         'Address']
];
const SETTINGS_TEXTAREAS = [
  ['hero',  'Hero headline'],
  ['tag',   'Hero tagline'],
  ['about', 'About text'],
  ['bank',  'Bank transfer details']
];

const option = (value, current) => `<option ${value === current ? 'selected' : ''}>${value}</option>`;

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
      <button class="chip dl" data-a="scsv">⬇ Download CSV</button>
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
        <span>${E(p.ic || '📦')} ${E(p.name)}${p.cat ? ' · ' + E(p.cat) : ''}</span>
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
      <span><b>${money(o.total)}</b> ${o.paid ? '· ✅ paid' : '· ⏳ unpaid'} · ${E(o.status)}</span>
    </div>`).join('') || '<p>No orders in this period.</p>'}`;
  },

  products: () => `
    <div class="adm">
      <div class="f">
        <input id="an"  placeholder="Product name">
        <input id="ap2" type="number" step="any" placeholder="Price">
        <input id="ac"  placeholder="Category">
        <input id="ai"  placeholder="Emoji">
        <input id="astk" type="number" min="0" placeholder="Units in stock">
      </div>
      <input id="ad" placeholder="Description">
      <input type="hidden" id="aid">
      <p></p>
      <label class="btn s d">📷 Photo<input id="aim" type="file" accept="image/*" hidden></label>
      <span id="ast"></span>
      <button class="btn s" data-a="psave">Save product</button>
    </div>
    ${S.products.map(p => `
      <div class="row">
        <span>${p.img ? '🖼️' : E(p.ic)} ${E(p.n)} · ${money(p.pr)} · ${E(p.cat)} · ${Number.isFinite(p.stock) ? p.stock : 0} in stock</span>
        <span>
          <button class="btn s d" data-a="pedit" data-id="${p.id}">Edit</button>
          <button class="btn s d" data-a="pdel"  data-id="${p.id}">Delete</button>
        </span>
      </div>`).join('')}`,

  orders: () => d.orders.map(o => `
    <div class="card" style="margin-bottom:12px">
      <b>#${o.id}</b> · ${new Date(o.date).toLocaleString()} · <b>${money(o.total)}</b> · ${o.method}${o.paid ? ' · ✅ paid' : ''}<br>
      ${E(o.name)} · ${E(o.phone)} · ${E(o.email)}<br>
      ${E(o.address)}<br>
      <small>${o.lines.map(l => E(l.n) + ' ×' + l.qty).join(', ')}</small>
      <p></p>
      <select data-a="ostat" data-id="${o.id}">${ORDER_STATUSES.map(s => option(s, o.status)).join('')}</select>
      <button class="btn s d" data-a="opaid" data-id="${o.id}" data-p="${o.paid ? '' : '1'}">${o.paid ? 'Mark unpaid' : 'Mark paid'}</button>
    </div>`).join('') || '<p>No orders yet.</p>',

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
      <label class="btn s d">📷 Photo<input id="jim" type="file" accept="image/*" hidden></label>
      <span id="jst"></span>
      <button class="btn s" data-a="jsave">Add project</button>
    </div>
    ${S.projects.map(p => `
      <div class="row">
        <span>${p.img ? '🖼️' : '🏗️'} ${E(p.t)}</span>
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
      <span>${s.role === 'super' ? '⭐' : '🛡️'} <b>${E(s.name)}</b> · ${E(s.email)} · ${E(s.role === 'super' ? 'Super admin' : 'Admin')}</span>
      <span>
        <button class="btn s d" data-a="strole" data-id="${s.id}" data-v="${s.role === 'super' ? 'admin' : 'super'}">${s.role === 'super' ? 'Demote to admin' : 'Promote to super'}</button>
        <button class="btn s d" data-a="stdelete" data-id="${s.id}">Remove</button>
      </span>
    </div>`).join('') || '<p>No staff accounts yet — you are signed in with the master key.</p>'}`,

  settings: () => `
    <div class="card">
      <div class="f">
        ${SETTINGS_INPUTS.map(x => `<label>${x[1]}<input id="s_${x[0]}" value="${E(C()[x[0]])}"></label>`).join('')}
      </div>
      ${SETTINGS_TEXTAREAS.map(x => `<label>${x[1]}<textarea id="s_${x[0]}" rows="2">${E(C()[x[0]])}</textarea></label>`).join('')}
      <p></p>
      <label class="btn s d">🏷️ Logo<input id="slg" type="file" accept="image/*" hidden></label>
      <label class="btn s d">🖼️ Hero image<input id="shi" type="file" accept="image/*" hidden></label>
      <button class="btn s d" data-a="rmhero">Remove hero image</button>
      <button class="btn s" data-a="ssave">Save settings</button>
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

  // The staff tab is reserved for super admins
  const tabs = ADMIN_TABS.filter(t => t !== 'staff' || AD.role === 'super');
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

const acts = {

  // ---- Shop / navigation ----
  cat:     d => { cat = d.v; render(); },
  explore: () => { $('#svc').classList.remove('hid'); $('#svc').scrollIntoView(); },

  // ---- Cart ----
  add: d => {
    const l = cart.find(x => x.id === d.id);
    l ? l.qty++ : cart.push({ id: d.id, qty: 1 });
    saveCart();
    toast('Added to cart');
  },
  qty: d => {
    const l = cart.find(x => x.id === d.id);
    l.qty = Math.max(1, l.qty + +d.d);
    saveCart();
    render();
  },
  rm: d => {
    cart = cart.filter(x => x.id !== d.id);
    saveCart();
    render();
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
  order: async () => {
    const r = await api('/orders', {
      method: 'POST',
      body: { items: cart, name: v('on'), phone: v('op'), email: v('oe'), address: v('oa'), method: v('om') }
    });
    sessionStorage.setItem('last', JSON.stringify({ id: r.id, method: v('om') }));
    cart = [];
    saveCart();
    if (r.url) return location.href = r.url;     // online card payment
    location.hash = '#/thanks';
  },

  // ---- Customer auth ----
  swap: () => { authMode = authMode === 'login' ? 'register' : 'login'; render(); },
  auth: async () => {
    const r = await api('/auth/' + authMode, {
      method: 'POST',
      body: { name: authMode === 'register' ? v('rn') : '', email: v('re'), password: v('rp') }
    });
    localStorage.setItem('tk', r.token);
    me = r.user;
    localStorage.setItem('me', JSON.stringify(me));
    render();
  },
  logout: () => {
    localStorage.removeItem('tk');
    localStorage.removeItem('me');
    me = null;
    render();
  },

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
    $('#ai').value  = p.ic;
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

// Status dropdowns in the admin (orders / quotes)
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
  mb.textContent = open ? '✕' : '☰';
  mb.setAttribute('aria-expanded', String(open));
};

$('#mb').onclick = () => setMenu(!$('#menu').classList.contains('open'));
$('#menu').onclick = e => { if (e.target.closest('a')) setMenu(false); };
addEventListener('hashchange', render);


// -----------------------------------------------------------------------------
// 8. ROUTER / RENDER
// -----------------------------------------------------------------------------

async function render() {
  const [h, sub] = location.hash.replace('#/', '').split('#');
  const r = h || '';

  setMenu(false);
  brand();

  // Highlight the active nav link
  document.querySelectorAll('#menu a').forEach(a =>
    a.classList.toggle('on', a.getAttribute('href') === '#/' + r));

  // The cart shortcut only appears while shopping
  $('#cartli')?.classList.toggle('hid', r !== 'shop' && r !== 'cart');

  // Pick the view for the current route
  app.innerHTML =
      r === 'engineering' ? eng()
    : r === 'shop'        ? shop()
    : r === 'cart'        ? cartView()
    : r === 'thanks'      ? thanks()
    : r === 'account'     ? account()
    : r === 'admin'       ? adminView()
    : r === 'about'       ? hero(E(C().hero), C().tag, 1,
                                  '<a class="btn" href="#/contact">Talk to us</a>', PIC.construction) + aboutSec()
    :                       home();

  // Shop: live search that keeps the caret position
  if (r === 'shop') {
    const s = $('#qs');
    s.oninput = () => {
      q = s.value.toLowerCase();
      const pos = s.selectionStart;
      render().then(() => {
        const n = $('#qs');
        n.focus();
        n.setSelectionRange(pos, pos);
      });
    };
  }

  // Admin: load data once signed in
  if (r === 'admin' && atk() && !AD) {
    try { AD = await api('/admin/data', {}, 1); render(); }
    catch (e) { render(); }
    return;
  }

  // Admin: image pickers
  if (r === 'admin') {
    img('aim', 700,  d => { pend = d;                     $('#ast').textContent = 'Photo ready ✓'; });
    img('jim', 900,  d => { pend = d;                     $('#jst').textContent = 'Photo ready ✓'; });
    img('slg', 256,  d => { pend = { k: 'logo',    d };   toast('Logo ready: press Save'); });
    img('shi', 1600, d => { pend = { k: 'heroImg', d };   toast('Hero image ready: press Save'); });
  }

  // Admin: load the sales overview for the selected period (skips when fresh)
  if (r === 'admin' && tab === 'sales' && AD && salesKey !== sfQuery()) {
    const want = sfQuery();
    api('/admin/sales?' + want, {}, 1).then(d => {
      if (sfQuery() !== want) return;                // a newer filter superseded this one
      SALES = d; salesKey = want;
      if (location.hash === '#/admin' && tab === 'sales') render();
    }).catch(err => toast(err.message));
  }

  // Account: load order history
  if (r === 'account' && me) {
    api('/me/orders')
      .then(orders => {
        $('#myo').innerHTML = orders.length
          ? orders.map(x => `<div class="row"><span>#${x.id} · ${new Date(x.date).toLocaleDateString()} · ${money(x.total)}</span><b>${E(x.status)}</b></div>`).join('')
          : 'No orders yet.';
      })
      .catch(() => acts.logout());
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
  if (r === 'contact')                  setTimeout(() => $('#contact').scrollIntoView(), 0);
  else if (sub)                         setTimeout(() => $('#' + sub)?.scrollIntoView(), 0);
  else if (!(r === 'shop' && q))        scrollTo(0, 0);

  // Page-view tracking (once per hash change)
  if (!render.last || render.last !== location.hash) {
    render.last = location.hash;
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: r || 'home' })
    }).catch(() => { });
  }
}

// Boot
load()
  .then(render)
  .catch(() => {
    app.innerHTML = '<section><div class="wrap"><h2>Site is starting up…</h2><p>Make sure the server is running (npm start).</p></div></section>';
  });