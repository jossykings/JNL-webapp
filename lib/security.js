// -----------------------------------------------------------------------------
// HTTP hardening: rate limits, security headers, cross-origin mutation guard and
// small validation helpers used by every route.
// -----------------------------------------------------------------------------
const buckets = new Map();
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

function rateLimit({ windowMs = 60_000, max = 60, name = 'general', keyFn } = {}) {
  return (req, res, next) => {
    const key = name + ':' + (keyFn ? keyFn(req) : ipOf(req));
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count++;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 120_000);
if (sweep.unref) sweep.unref();

// Reject state-changing requests that come from another origin. Tokens are sent
// in the Authorization header (never cookies), so this is defence in depth
// rather than the CSRF protection itself.
function sameOrigin(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let host = '';
  try { host = new URL(origin).host; } catch { return res.status(403).json({ error: 'Cross-origin request blocked' }); }
  const allowed = new Set([req.headers.host, process.env.SITE_URL ? new URL(process.env.SITE_URL).host : '']);
  if (![...allowed].filter(Boolean).some(h => h.split(':')[0] === host.split(':')[0])) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
}

function headers(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://js.stripe.com https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api.stripe.com https://www.google-analytics.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

// ---- validation ----
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '')) && String(v).length <= 150;
const oneOf = (v, allowed, fallback) => allowed.includes(v) ? v : fallback;
const int = (v, min, max, fallback = null) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const bool = v => v === true || v === 'true' || v === 1 || v === '1';

module.exports = { rateLimit, sameOrigin, headers, ipOf, str, isEmail, oneOf, int, bool };
