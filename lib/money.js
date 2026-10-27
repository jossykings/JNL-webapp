// All money is handled as integer minor units (cents). Only string formatting
// happens at the edges, so no floating point maths ever touches a total.
const CURRENCIES = { cad: 'CAD', usd: 'USD' };

const toCents = v => {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100);
  }
  const s = String(v ?? '').replace(/[^0-9.\-]/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const clampCents = (v, min = 0) => Math.max(min, Math.round(Number(v) || 0));

const fmt = (cents, cur = '$', currency = 'cad') => {
  const n = (Number(cents) || 0) / 100;
  const s = n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur + s + (String(currency).toLowerCase() === 'cad' ? ' CAD' : '');
};

// Plain decimal string for CSV/PDF output (no currency symbol)
const dec = cents => ((Number(cents) || 0) / 100).toFixed(2);

module.exports = { toCents, clampCents, fmt, dec, CURRENCIES };
