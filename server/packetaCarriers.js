// Packeta carrier catalog sync.
//
// Packeta exposes a JSON feed of all available carriers per country at:
//   https://www.zasilkovna.cz/api/v4/{apiPassword}/branch.json?lang=en
//
// The WC Packeta plugin pulls this once a day. We do the same — call the
// REST endpoint, normalise into the `packeta_carriers` table shape, and
// upsert. Old rows for carriers that disappeared from the feed are deleted
// in the same transaction so the catalog stays in sync.
//
// The feed is large (~2 MB JSON) but cached easily; we only fetch on
// explicit refresh or when `last_synced_at` is older than 24h.

import { db } from "./db.js";
import { normalizePacketaPassword } from "./packeta.js";

const CARRIER_FEED_URL = (apiPassword) =>
  `https://www.zasilkovna.cz/api/v4/${encodeURIComponent(
    normalizePacketaPassword(apiPassword),
  )}/branch.json?lang=en`;

// How old the catalog can be before we auto-refresh. 24h matches the WC
// plugin's default schedule.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  if (!res.ok) {
    return { ok: false, error: `Packeta returned HTTP ${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, error: `Bad JSON from Packeta: ${err.message}` };
  }
  // The feed shape is `{ data: [{ id, name, country, currency, ... }] }`.
  // Different Packeta endpoints use slightly different keys; we handle both
  // the v4 carriers feed and the older branch list.
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  if (list.length === 0) {
    return { ok: false, error: "Carrier feed was empty" };
  }

  const carriers = list
    .map((c) => {
      const id = Number(c.id ?? c.carrierId ?? 0);
      if (!Number.isInteger(id) || id <= 0) return null;
      const country = String(c.country || c.countryCode || "").toUpperCase().slice(0, 2);
      if (!country) return null;
      return {
        id,
        name: String(c.name || c.label || `Carrier ${id}`).slice(0, 200),
        country,
        currency: c.currency ? String(c.currency).toUpperCase().slice(0, 8) : null,
        // The feed marks pickup-point carriers (Z-Box, pickup shops) with
        // `isPickupPoints: true` or `pickupPoints: true` depending on version.
        is_pickup_points: c.isPickupPoints || c.pickupPoints || c.is_pickup_points ? 1 : 0,
        supports_cod: c.supportsCod || c.supports_cod ? 1 : 0,
        supports_age_verification:
          c.supportsAgeVerification || c.supports_age_verification ? 1 : 0,
        max_weight_kg:
          typeof c.maxWeight === "number"
            ? c.maxWeight
            : typeof c.max_weight === "number"
            ? c.max_weight
            : null,
        disallows_cod: c.disallowsCod || c.disallows_cod ? 1 : 0,
      };
    })
    .filter(Boolean);

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
