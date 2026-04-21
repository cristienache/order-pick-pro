// Royal Mail Shipping API v3 client.
//
// Phase 1: only the bits needed for "Test Connection" — token fetch and a
// single lightweight GET that proves the credentials work end-to-end.
// Phases 2-4 (create shipment, manifest, void) will extend this file.
//
// Two environments:
//   - Production:  https://api.royalmail.net/shipping/v3
//   - Sandbox:     https://api.royalmail.net/shipping/v3test  (per RM dev portal)
// Switched per-user via the `use_sandbox` flag on royal_mail_credentials.

const PROD_BASE = "https://api.royalmail.net/shipping/v3";
const SANDBOX_BASE = "https://api.royalmail.net/shipping/v3test";

export function rmBaseUrl(useSandbox) {
  return useSandbox ? SANDBOX_BASE : PROD_BASE;
}

// In-memory token cache keyed by user_id. Tokens are short-lived (RM issues
// ~4h tokens). On 401 from any RM call we evict and re-issue.
const tokenCache = new Map(); // user_id -> { token, expiresAt, sandbox }

function cacheKey(userId, sandbox) {
  return `${userId}:${sandbox ? 1 : 0}`;
}

export function clearRmToken(userId, sandbox) {
  tokenCache.delete(cacheKey(userId, sandbox));
}

// POST /token — exchange Client-Id + Client-Secret for a session token.
// Royal Mail's IBM API Gateway expects the credentials as headers, not form body.
async function fetchToken({ clientId, clientSecret, useSandbox }) {
  const res = await fetch(`${rmBaseUrl(useSandbox)}/token`, {
    method: "POST",
    headers: {
      "X-IBM-Client-Id": clientId,
      "X-IBM-Client-Secret": clientSecret,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.message || body?.error || body?.raw || `Token request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  // RM token responses vary by tenant. Try common shapes.
  const token = body?.token || body?.access_token || body?.authToken;
  if (!token) {
    const err = new Error("Token endpoint returned no token field");
    err.body = body;
    throw err;
  }
  // Default to 3 hours if not supplied — well under the typical 4h TTL.
  const ttlSeconds = Number(body?.expires_in || body?.expiresIn || 3 * 3600);
  return { token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

export async function getRmToken({ userId, clientId, clientSecret, useSandbox }) {
  const key = cacheKey(userId, useSandbox);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const fresh = await fetchToken({ clientId, clientSecret, useSandbox });
  tokenCache.set(key, fresh);
  return fresh.token;
}

// Shared helper for authenticated RM calls. On 401 we evict the cached token
// and retry exactly once (RM tokens occasionally expire mid-day before the
// advertised TTL). Returns { ok, status, body, raw }.
async function rmRequest({ userId, clientId, clientSecret, useSandbox, method, path, body }) {
  const url = `${rmBaseUrl(useSandbox)}${path}`;
  const doCall = async () => {
    const token = await getRmToken({ userId, clientId, clientSecret, useSandbox });
    const headers = {
      "X-IBM-Client-Id": clientId,
      "X-IBM-Client-Secret": clientSecret,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { res, body: parsed, raw: text };
  };

  let attempt = await doCall();
  if (attempt.res.status === 401) {
    clearRmToken(userId, useSandbox);
    attempt = await doCall();
  }
  return { ok: attempt.res.ok, status: attempt.res.status, body: attempt.body, raw: attempt.raw };
}

// POST /shipments — create a shipment and (usually) get the label inline.
//
// Royal Mail Shipping API v3 request shape (simplified, UK domestic):
//   {
//     shipmentInformation: {
//       shipmentDate: "YYYY-MM-DD",
//       serviceCode: "TPN",        // e.g. CRL, CRL48, TRK24, TRK48, STL1, STL2
//       serviceFormat: "P",        // P = Parcel, L = Large Letter, F = Letter
//       weight: { unitOfMeasurement: "g", value: 500 },
//       descriptionOfGoods: "Goods",
//       declaredValue: 0,
//       customerReference: "WC-123"
//     },
//     shipper: { ...address... },
//     destination: { ...address... }
//   }
//
// Response is highly tenant-dependent. We surface whatever shape RM returns;
// the caller normalizes shipmentId / trackingNumber / labelBase64.
export async function createRmShipment({
  userId, clientId, clientSecret, useSandbox, payload,
}) {
  return rmRequest({
    userId, clientId, clientSecret, useSandbox,
    method: "POST",
    path: "/shipments",
    body: payload,
  });
}

// Pull label PDF separately when the create response only returned a URI/id.
// Most RM tenants accept GET /shipments/{shipmentId}/label.
export async function getRmShipmentLabel({
  userId, clientId, clientSecret, useSandbox, shipmentId,
}) {
  return rmRequest({
    userId, clientId, clientSecret, useSandbox,
    method: "GET",
    path: `/shipments/${encodeURIComponent(shipmentId)}/label`,
  });
}

// Normalize the create-shipment response into a stable shape for the DB.
// Royal Mail tenants return slightly different field names; we try the most
// common ones in priority order.
export function normalizeShipmentResponse(body) {
  if (!body || typeof body !== "object") return {};
  const shipmentId =
    body.shipmentId || body.consignmentNumber || body.id ||
    body.shipment?.shipmentId || body.shipment?.id || null;
  const trackingNumber =
    body.trackingNumber ||
    body.shipmentTrackingNumber ||
    body.shipment?.trackingNumber ||
    (Array.isArray(body.packages) && body.packages[0]?.trackingNumber) ||
    null;
  // Label PDF as base64 — tried in priority order.
  const labelBase64 =
    body.label || body.labelImage || body.labelData ||
    body.shipment?.label || body.documents?.label ||
    (Array.isArray(body.labels) && body.labels[0]?.data) ||
    null;
  const labelUri =
    body.labelUri || body.labelUrl ||
    body.shipment?.labelUri || null;
  return { shipmentId, trackingNumber, labelBase64, labelUri };
}

// Probe the credentials against a lightweight, side-effect-free endpoint.
// Returns { ok, status, message, detail } — never throws.
//
// We try POST /token first (proves Client-Id/Secret are valid). If that
// succeeds we additionally hit GET /shipments?limit=1 to confirm the token
// is accepted by the resource APIs. Either failure is reported with the
// HTTP status so the UI can render the right hint.
export async function testRmConnection({ userId, clientId, clientSecret, useSandbox }) {
  if (!clientId || !clientSecret) {
    return { ok: false, status: 0, message: "Client ID and Secret are required" };
  }
  let token;
  try {
    token = await fetchToken({ clientId, clientSecret, useSandbox });
  } catch (err) {
    return {
      ok: false,
      status: err.status || 0,
      message: err.status === 401
        ? "Royal Mail rejected the credentials. Double-check Client ID and Secret."
        : `Token request failed: ${err.message}`,
      detail: err.body || null,
    };
  }
  try {
    const res = await fetch(`${rmBaseUrl(useSandbox)}/shipments?limit=1`, {
      headers: {
        "X-IBM-Client-Id": clientId,
        "X-IBM-Client-Secret": clientSecret,
        Authorization: `Bearer ${token.token}`,
        Accept: "application/json",
      },
    });
    if (res.ok || res.status === 404) {
      // 404 is acceptable — means the API accepted us but found no shipments.
      tokenCache.set(cacheKey(userId, useSandbox), token);
      return {
        ok: true,
        status: res.status,
        message: useSandbox ? "Connected to Royal Mail sandbox." : "Connected to Royal Mail.",
      };
    }
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      message: `Authenticated but resource API returned ${res.status}.`,
      detail: text.slice(0, 500) || null,
    };
  } catch (err) {
    return { ok: false, status: 0, message: `Network error: ${err.message}` };
  }
}
