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
