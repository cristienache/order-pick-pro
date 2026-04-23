// Packeta carrier catalog sync.
//
// Packeta exposes a public JSON list of all available home-delivery and
// pickup-point carriers (per country) at:
//   https://pickup-point.api.packeta.com/v5/{apiKey}/carrier/json?lang=en
//
// Docs: https://docs.packeta.com/docs/home-delivery/carriers
//
// Note: this is the *carriers list*, NOT the (much larger) PUDO/branch feed
// at .../branch.json. We pull this once a day, the same cadence the WC
// Packeta plugin uses.
//
// The response is a flat JSON array. All boolean and numeric fields come back
// as strings (e.g. "true", "30") so we parse them defensively here.

import { db } from "./db.js";
import { normalizePacketaPassword } from "./packeta.js";

const CARRIER_FEED_URL = (apiPassword) =>
  `https://pickup-point.api.packeta.com/v5/${encodeURIComponent(
    normalizePacketaPassword(apiPassword),
  )}/carrier/json?lang=en`;

// How old the catalog can be before we auto-refresh. 24h matches the WC
// plugin's default schedule.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Coerce "true"/"false"/true/false/1/0 into a real boolean.
function toBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return v.toLowerCase() === "true" || v === "1";
  return false;
}
// Coerce string/number into a finite number, or null.
function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Fetch + parse the carrier feed. Returns { ok, carriers, error }.
// Each entry in `carriers` is the row shape we'll upsert.
export async function fetchPacketaCarriers(apiPassword) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) return { ok: false, error: "API password missing" };

  let res;
  try {
    res = await fetch(CARRIER_FEED_URL(password));
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
  // Try to read the body either way — Packeta returns JSON error envelopes
  // on 4xx that are far more useful than a generic HTTP code.
  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch (err) {
    return {
      ok: false,
      error: `Bad JSON from Packeta (HTTP ${res.status}): ${err.message}`,
    };
  }
  if (!res.ok) {
    const detail = body?.error || body?.message || raw.slice(0, 200);
    return { ok: false, error: `Packeta returned HTTP ${res.status}: ${detail}` };
  }

  // The v5 carriers feed is a flat top-level array. Older endpoints wrapped
  // the list in `{ data: [...] }` so we accept both for safety.
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.carriers)
    ? body.carriers
    : [];
  if (list.length === 0) {
    return {
      ok: false,
      error:
        "Carrier feed was empty. Check that the API password belongs to a " +
        "Packeta production account with carriers enabled.",
    };
  }

  const carriers = list
    .map((c) => {
      const id = toNum(c.id ?? c.carrierId);
      if (!Number.isFinite(id) || id <= 0) return null;
      // Country comes back lowercase in the v5 feed (e.g. "at"); normalise.
      const country = String(c.country || c.countryCode || "")
        .toUpperCase()
        .slice(0, 2);
      if (!country) return null;
      // Skip carriers Packeta has marked unavailable — they can't be used
      // for new packets anyway and would only confuse the routing UI.
      const available = c.available === undefined ? true : toBool(c.available);
      if (!available) return null;
      return {
        id: Math.trunc(id),
        name: String(c.name || c.label || c.labelName || `Carrier ${id}`).slice(0, 200),
        country,
        currency: c.currency ? String(c.currency).toUpperCase().slice(0, 8) : null,
        is_pickup_points: toBool(c.pickupPoints ?? c.isPickupPoints ?? c.is_pickup_points) ? 1 : 0,
        // The v5 feed doesn't expose "supportsCod" directly, but disallowsCod
        // is the inverse of it — we keep both columns for clarity.
        supports_cod: toBool(c.disallowsCod ?? c.disallows_cod) ? 0 : 1,
        supports_age_verification: toBool(
          c.supportsAgeVerification ?? c.supports_age_verification ?? c.requiresAgeVerification,
        ) ? 1 : 0,
        max_weight_kg: toNum(c.maxWeight ?? c.max_weight),
        disallows_cod: toBool(c.disallowsCod ?? c.disallows_cod) ? 1 : 0,
      };
    })
    .filter(Boolean);

  if (carriers.length === 0) {
    return { ok: false, error: "Carrier feed parsed but no usable rows found." };
  }
  return { ok: true, carriers };
}

// Upsert the entire carrier list into `packeta_carriers`. Rows that no
// longer appear in the feed are deleted so the catalog stays accurate.
// Returns { count, last_synced_at }.
export function persistPacketaCarriers(carriers) {
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO packeta_carriers (
      id, name, country, currency, is_pickup_points,
      supports_cod, supports_age_verification, max_weight_kg, disallows_cod,
      last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, country) DO UPDATE SET
      name = excluded.name,
      currency = excluded.currency,
      is_pickup_points = excluded.is_pickup_points,
      supports_cod = excluded.supports_cod,
      supports_age_verification = excluded.supports_age_verification,
      max_weight_kg = excluded.max_weight_kg,
      disallows_cod = excluded.disallows_cod,
      last_synced_at = excluded.last_synced_at
  `);

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      upsert.run(
        r.id,
        r.name,
        r.country,
        r.currency,
        r.is_pickup_points,
        r.supports_cod,
        r.supports_age_verification,
        r.max_weight_kg,
        r.disallows_cod,
        now,
      );
    }
    // Drop carriers that disappeared from this sync.
    db.prepare("DELETE FROM packeta_carriers WHERE last_synced_at < ?").run(now);
  });
  tx(carriers);

  return { count: carriers.length, last_synced_at: now };
}

// Combined fetch+persist. Never throws; returns a stable result object.
export async function syncPacketaCarriers(apiPassword) {
  const fetched = await fetchPacketaCarriers(apiPassword);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const persisted = persistPacketaCarriers(fetched.carriers);
  return { ok: true, ...persisted };
}

// Last sync timestamp from any row. Used to decide whether the catalog
// is stale and needs an auto-refresh.
export function getCatalogLastSyncedAt() {
  const row = db.prepare(
    "SELECT MAX(last_synced_at) AS last_synced_at FROM packeta_carriers",
  ).get();
  return row?.last_synced_at || null;
}

export function isCatalogStale() {
  const last = getCatalogLastSyncedAt();
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs > STALE_AFTER_MS;
}
