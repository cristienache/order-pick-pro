// eBay integration helpers. Mirrors the shape of server/woocommerce.js so the
// rest of the app can treat eBay accounts and WooCommerce sites identically.
//
// Auth model: per-user OAuth 2.0 (Authorization Code flow). The app owner
// registers ONE production eBay developer app and provides three env vars:
//   EBAY_CLIENT_ID      — App ID
//   EBAY_CLIENT_SECRET  — Cert ID
//   EBAY_RUNAME         — RuName generated when configuring the redirect URL
//                         in eBay developer portal (NOT the URL itself —
//                         eBay's OAuth requires the RuName as redirect_uri).
//
// We persist refresh tokens encrypted in `ebay_accounts.refresh_token_enc`
// and lazily mint short-lived access tokens, refreshing whenever they're
// within 60 seconds of expiring.

import { encrypt, decrypt } from "./crypto.js";

const EBAY_OAUTH_HOST = "https://auth.ebay.com";
const EBAY_API_HOST = "https://api.ebay.com";

// Scopes we request. fulfillment.readonly is enough to read orders; we ask
// for the read/write fulfillment scope too so a future "mark shipped from
// Ultrax" flow doesn't require the user to reconnect.
export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];

export function ebayConfig() {
  const clientId = process.env.EBAY_CLIENT_ID || "";
  const clientSecret = process.env.EBAY_CLIENT_SECRET || "";
  const ruName = process.env.EBAY_RUNAME || "";
  return {
    clientId,
    clientSecret,
    ruName,
    configured: Boolean(clientId && clientSecret && ruName),
  };
}

function basicAuthHeader(clientId, clientSecret) {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

/**
 * Build the URL we redirect the user to so they can authorize Ultrax to
 * read their eBay orders. `state` ties the response back to the user.
 */
export function buildAuthorizeUrl(state) {
  const cfg = ebayConfig();
  if (!cfg.configured) throw new Error("eBay is not configured on the server.");
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.ruName,
    response_type: "code",
    scope: EBAY_SCOPES.join(" "),
    state,
    prompt: "login",
  });
  return `${EBAY_OAUTH_HOST}/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange the `code` returned to the OAuth callback for a refresh + access
 * token pair. Returns:
 *   { refreshToken, refreshTokenExpiresIn, accessToken, accessTokenExpiresIn }
 */
export async function exchangeCodeForTokens(code) {
  const cfg = ebayConfig();
  if (!cfg.configured) throw new Error("eBay is not configured on the server.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.ruName,
  });
  const res = await fetch(`${EBAY_API_HOST}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`eBay token exchange failed: ${msg}`);
  }
  return {
    refreshToken: data.refresh_token,
    refreshTokenExpiresIn: Number(data.refresh_token_expires_in) || 47304000, // ~18mo
    accessToken: data.access_token,
    accessTokenExpiresIn: Number(data.expires_in) || 7200,
  };
}

/**
 * Use the stored refresh token to mint a fresh access token.
 */
export async function refreshAccessToken(refreshToken) {
  const cfg = ebayConfig();
  if (!cfg.configured) throw new Error("eBay is not configured on the server.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: EBAY_SCOPES.join(" "),
  });
  const res = await fetch(`${EBAY_API_HOST}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`eBay token refresh failed: ${msg}`);
  }
  return {
    accessToken: data.access_token,
    accessTokenExpiresIn: Number(data.expires_in) || 7200,
  };
}

/**
 * Resolve a usable access token for an account row, refreshing if expired.
 * `db` and `accountRow` are passed in so this stays free of import cycles.
 *
 * Returns the access token string. Side-effect: writes the new token back to
 * `ebay_accounts` if a refresh happened.
 */
export async function getAccessToken(db, accountRow) {
  const now = Date.now();
  const expiresAtIso = accountRow.access_token_expires_at;
  const stillFresh =
    accountRow.access_token_enc &&
    expiresAtIso &&
    new Date(expiresAtIso).getTime() - now > 60_000;

  if (stillFresh) {
    return decrypt(accountRow.access_token_enc);
  }

  const refreshToken = decrypt(accountRow.refresh_token_enc);
  const { accessToken, accessTokenExpiresIn } = await refreshAccessToken(refreshToken);
  const newExpiresAt = new Date(now + accessTokenExpiresIn * 1000).toISOString();
  db.prepare(`
    UPDATE ebay_accounts
    SET access_token_enc = ?, access_token_expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(encrypt(accessToken), newExpiresAt, accountRow.id);
  return accessToken;
}

/**
 * Look up the seller's eBay user ID (their handle) using the access token.
 * Best-effort — returns null if the call fails.
 */
export async function fetchEbayUserId(accessToken) {
  try {
    const res = await fetch(`${EBAY_API_HOST}/commerce/identity/v1/user/`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.username || data.userId || null;
  } catch {
    return null;
  }
}

// ---------- Order fetching ----------

/**
 * Map the user-facing WooCommerce-style status filter to an eBay
 * Fulfillment API filter string.
 *
 * eBay order shape (relevant fields):
 *   orderFulfillmentStatus: NOT_STARTED | IN_PROGRESS | FULFILLED
 *   orderPaymentStatus:     PAID | FAILED | PENDING | PARTIALLY_REFUNDED
 *                           | FULLY_REFUNDED
 *   cancelStatus.cancelState: NONE_REQUESTED | CANCEL_PENDING
 *                           | CANCEL_CLOSED_FOR_COMMITMENT | CANCELED
 *
 * We map to:
 *   processing -> paid + not yet shipped
 *   completed  -> shipped
 *   cancelled  -> cancelled
 *   refunded   -> fully refunded
 *   on-hold    -> payment pending (treat as on-hold)
 *   pending    -> payment pending (alias of on-hold for the UI)
 *   failed     -> payment failed
 *
 * We over-fetch and filter client-side because eBay's `filter` query
 * supports only a subset of these combinations cleanly. The volume per
 * account is small enough (a few hundred orders per day at most) that
 * pulling 200 orders and filtering in JS is fine.
 */
function ebayOrderToWcStatus(o) {
  const cancel = o.cancelStatus?.cancelState;
  if (cancel === "CANCELED") return "cancelled";
  const pay = o.orderPaymentStatus;
  if (pay === "FULLY_REFUNDED") return "refunded";
  if (pay === "FAILED") return "failed";
  if (pay === "PENDING") return "on-hold";
  const ful = o.orderFulfillmentStatus;
  if (ful === "FULFILLED") return "completed";
  // Default: paid but not yet shipped == processing.
  return "processing";
}

/**
 * Fetch orders for an eBay account. Mirrors the signature of
 * woocommerce.fetchOrders so the route layer can treat both identically.
 *
 *   opts: { statuses?: string[], after?: string|null, before?: string|null,
 *           accessToken: string, maxPages?: number }
 *
 * Returns the raw eBay order objects (we normalize to OrderRow at the route
 * layer to keep this module reusable for label generation).
 */
export async function fetchOrders(account, opts = {}) {
  const accessToken = opts.accessToken;
  if (!accessToken) throw new Error("Missing access token");

  const wantedStatuses = new Set(
    (opts.statuses && opts.statuses.length ? opts.statuses : ["processing"])
      .map((s) => String(s).toLowerCase()),
  );

  // eBay supports a `filter` param with creationdate:[start..end]. Always send
  // a date window — without one the API caps results to recent orders anyway.
  const after = opts.after ? new Date(opts.after) : null;
  const before = opts.before ? new Date(opts.before) : null;

  // Default to last 90 days when no after-bound is given. eBay's window is
  // inclusive on both ends.
  const start = after || new Date(Date.now() - 90 * 24 * 3600_000);
  const end = before || new Date();

  const filter = `creationdate:[${start.toISOString()}..${end.toISOString()}]`;
  const limit = 200; // eBay max
  const maxPages = opts.maxPages || 5;
  const orders = [];
  let offset = 0;
  let page = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({
      filter,
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${EBAY_API_HOST}/sell/fulfillment/v1/order?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Accept-Language": "en-GB",
        "Content-Language": "en-GB",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`eBay API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const batch = Array.isArray(data.orders) ? data.orders : [];
    orders.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    page++;
  }

  // Filter to the requested WC-style statuses.
  return orders.filter((o) => wantedStatuses.has(ebayOrderToWcStatus(o)));
}

/**
 * Convert one raw eBay order into the shared OrderRow shape used by the
 * frontend (same fields as the WooCommerce normalizer in server/index.js).
 */
export function normalizeEbayOrder(o) {
  const status = ebayOrderToWcStatus(o);
  const fulfill = (o.fulfillmentStartInstructions || [])[0] || {};
  const ship = fulfill.shippingStep?.shipTo || {};
  const addr = ship.contactAddress || {};
  const buyer = o.buyer || {};
  const buyerName = ship.fullName || buyer.username || "eBay buyer";
  const email = buyer.taxIdentifier?.taxpayerId || ""; // eBay hides email
  const lineItems = Array.isArray(o.lineItems) ? o.lineItems : [];

  // Pick the postage option label as shipping_method.
  const shippingMethod =
    fulfill.shippingStep?.shippingServiceCode ||
    fulfill.shippingStep?.shipTo?.primaryPhone?.phoneNumber || // never used, fallback chain
    "eBay shipping";

  // Total: prefer pricingSummary.total.value, fall back to sum of line items.
  const total =
    o.pricingSummary?.total?.value ||
    String(lineItems.reduce((s, li) => s + Number(li.total?.value || 0), 0).toFixed(2));
  const currency =
    o.pricingSummary?.total?.currency ||
    lineItems[0]?.total?.currency ||
    "GBP";

  return {
    id: o.orderId, // eBay order IDs are strings (e.g. "12-34567-89012")
    number: o.orderId,
    status,
    date_created: o.creationDate,
    total,
    currency,
    customer: buyerName,
    email,
    shipping_method:
      typeof shippingMethod === "string" ? shippingMethod : "eBay shipping",
    shipping_country: (addr.countryCode || "").toUpperCase(),
    itemCount: lineItems.reduce((s, li) => s + Number(li.quantity || 0), 0),
    lineCount: lineItems.length,
    items: lineItems.map((li) => ({
      sku: String(li.sku || li.legacyItemId || ""),
      name: String(li.title || ""),
      quantity: Number(li.quantity) || 0,
    })),
    previous_completed: null,
  };
}
