// -----------------------------------------------------------------------------
// Canadian delivery: postal-code validation, zone-based shipping, destination
// taxes and serviceability checks. Every rule here reads from db.settings so an
// administrator can change rates without touching code.
// -----------------------------------------------------------------------------
const { db } = require('./db');

const PROVINCES = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon']
];
const PROVINCE_CODES = PROVINCES.map(p => p[0]);

// First letter of a Canadian FSA -> province / territory
const LETTER_PROVINCE = {
  A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC',
  K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON',
  R: 'MB', S: 'SK', T: 'AB', V: 'BC', X: 'NT', Y: 'YT'
};

// Canada Post rules: no D, F, I, O, Q, U, W or Z as the first letter
const POSTAL_RE = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ] ?\d[ABCEGHJKLMNPRSTVWXYZ]\d$/;

function normalizePostal(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 6 ? s.slice(0, 3) + ' ' + s.slice(3) : s;
}

function validPostal(raw) {
  return POSTAL_RE.test(normalizePostal(raw));
}

// Returns { ok, province, reason }
function checkDestination({ postalCode, province }) {
  const pc = normalizePostal(postalCode);
  if (!pc) return { ok: false, reason: 'Enter your Canadian postal code to calculate delivery.' };
  if (!validPostal(pc)) return { ok: false, reason: 'That postal code is not a valid Canadian postal code (e.g. M5V 3L9).' };
  const expected = LETTER_PROVINCE[pc[0]];
  const prov = String(province || '').toUpperCase();
  if (!PROVINCE_CODES.includes(prov)) return { ok: false, reason: 'Choose your province or territory.', province: expected };
  if (prov !== expected) {
    return { ok: false, reason: `Postal code ${pc} belongs to ${expected}, not ${prov}.`, province: expected };
  }
  return { ok: true, postalCode: pc, province: prov };
}

const settings = () => db.settings.shipping;

// Longest matching prefix wins, so admins can add a "M5V" rule that overrides "M"
function zoneFor(postalCode) {
  const pc = normalizePostal(postalCode).replace(' ', '');
  let best = null;
  for (const z of settings().zones || []) {
    for (const raw of z.prefixes || []) {
      const pre = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (pre && pc.startsWith(pre) && (!best || pre.length > best.prefix.length)) {
        best = { zone: z, prefix: pre };
      }
    }
  }
  return best;
}

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Shipping options for a cart. `lines` come from the server-priced quote.
function shippingOptions({ subtotalCents, weightKg, postalCode, province }) {
  const cfg = settings();
  const dest = checkDestination({ postalCode, province });
  if (!dest.ok) return { ok: false, error: dest.reason, options: [], free: false };
  const match = zoneFor(dest.postalCode);
  if (!match) {
    return { ok: false, serviceable: false, postalCode: dest.postalCode, province: dest.province,
      error: `Sorry — we do not deliver to ${dest.postalCode} yet.`, options: [], free: false };
  }
  const weight = Math.max(0, Number(weightKg) || 0);
  if (weight > cfg.maxWeightKg) {
    return { ok: false, error: `Orders over ${cfg.maxWeightKg} kg need a custom freight quote — please contact us.`, options: [] };
  }
  const free = cfg.freeOverCents > 0 && subtotalCents >= cfg.freeOverCents;
  const extraKg = Math.max(0, Math.ceil(weight - 1));
  const base = match.zone.cents + extraKg * (cfg.perKgCents || 0);
  const options = (cfg.methods || []).map(m => ({
    id: m.id,
    label: m.label,
    days: m.days,
    zone: match.zone.label,
    cents: free ? 0 : Math.round(base * (Number(m.multiplier) || 1))
  }));
  return { ok: true, serviceable: true, postalCode: dest.postalCode, province: dest.province,
    zone: match.zone.label, weightKg: round2(weight), free, options };
}

// Destination tax. Configurable per province; returns a labelled breakdown.
function taxFor({ province, taxableCents }) {
  const cfg = db.settings.tax || {};
  const rate = cfg.rates?.[String(province || '').toUpperCase()];
  if (!rate || !rate.rate) return { cents: 0, label: '', rate: 0, lines: [] };
  const cents = Math.round(taxableCents * (rate.rate / 100));
  return { cents, label: rate.label, rate: rate.rate, lines: [{ label: rate.label, rate: rate.rate, cents }] };
}

module.exports = {
  PROVINCES, PROVINCE_CODES, LETTER_PROVINCE, normalizePostal, validPostal,
  checkDestination, zoneFor, shippingOptions, taxFor, settings
};
