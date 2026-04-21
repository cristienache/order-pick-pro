// Lightweight FX rates module.
// Pulls GBP-base rates from exchangerate.host (free, no key) and caches them
// in memory for 1 hour. Falls back to a small static table if the upstream
// is unreachable so the dashboard never breaks.

const FALLBACK_GBP = {
  GBP: 1,
  EUR: 1.17,   // 1 EUR ~= 1.17 GBP -- ballpark only
  USD: 1.27,
  AUD: 1.95,
  CAD: 1.74,
  NZD: 2.10,
  CHF: 1.13,
  SEK: 13.6,
  NOK: 13.8,
  DKK: 8.7,
  JPY: 195,
};

let cache = { fetchedAt: 0, base: "GBP", rates: null };
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns: { base: "GBP", rates: { USD: 1.27, EUR: 1.17, ... }, fetchedAt, source }
 * Each rate is "1 GBP = N <code>".
 */
export async function getFxRates() {
  const now = Date.now();
  if (cache.rates && now - cache.fetchedAt < TTL_MS) return cache;

  try {
    // exchangerate.host has been spotty for some endpoints recently; try the
    // simple "latest" endpoint first.
    const res = await fetch("https://api.exchangerate.host/latest?base=GBP", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== "object" || !json.rates) {
      throw new Error("Bad payload");
    }
    cache = {
      fetchedAt: now,
      base: "GBP",
      rates: { GBP: 1, ...json.rates },
      source: "exchangerate.host",
    };
    return cache;
  } catch (e) {
    // Fall back gracefully — keep stale cache if we have one, else use static table.
    if (cache.rates) {
      return { ...cache, source: cache.source + " (stale)" };
    }
    cache = {
      fetchedAt: now,
      base: "GBP",
      rates: { ...FALLBACK_GBP },
      source: "fallback",
    };
    return cache;
  }
}

/**
 * Convert `amount` from `currency` into GBP. Returns null if rate unknown.
 */
export function toGbp(amount, currency, rates) {
  const code = (currency || "GBP").toUpperCase();
  if (code === "GBP") return amount;
  const rate = rates?.[code];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
  // rates are "1 GBP = N <code>"; so amount in <code> / rate = GBP
  return amount / rate;
}
