// Royal Mail Click & Drop API client.
//
// We swapped from Shipping API v3 (IBM gateway, dual client-id/secret + token
// exchange) to Click & Drop, which authenticates with a single API key the
// user generates inside their Click & Drop account:
//   Settings -> Integrations -> "Create new API key"
//
// Endpoints we use:
//   POST   /orders                                    create one order
//   GET    /orders/{orderIdentifier}/label            fetch the label PDF
//   DELETE /orders/{orderIdentifier}                  void (pre-label only)
//   GET    /version                                   lightweight health check
//   POST   /orders/despatch                           close the manifest
//
// Two environments:
//   - Production: https://api.parcel.royalmail.com/api/v1
//   - Sandbox:    https://api.parcel.royalmail.com/api/v1 with a sandbox key
//                 (Click & Drop uses one URL; the key itself is environment-
//                 scoped). We keep `useSandbox` as a UI flag so the user knows
//                 which key is in play and so we can flip to a separate URL
//                 if Royal Mail ever publishes one.

const PROD_BASE = "https://api.parcel.royalmail.com/api/v1";
const SANDBOX_BASE = "https://api.parcel.royalmail.com/api/v1";

export function rmBaseUrl(useSandbox) {
  return useSandbox ? SANDBOX_BASE : PROD_BASE;
}

// Kept as a no-op so existing call-sites in server/index.js don't need to be
// reorganised. Click & Drop has no token cache to clear.
export function clearRmToken(_userId, _sandbox) { /* no-op */ }

export function normalizeRmApiKey(apiKey) {
  return String(apiKey || "")
    .trim()
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^bearer\s+/i, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^['\"]|['\"]$/g, "")
    .trim();
}

function authHeaders(apiKey) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${normalizeRmApiKey(apiKey)}`,
  };
}

// JSON request helper. Returns { ok, status, body, raw }.
async function rmJson({ apiKey, useSandbox, method, path, body }) {
  const url = `${rmBaseUrl(useSandbox)}${path}`;
  const headers = { ...authHeaders(apiKey) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed, raw: text };
}

// Binary helper for /label PDF downloads. Returns { ok, status, buffer, body }.
// Royal Mail can return JSON even on HTTP 200 when a document is not available,
// so validate the bytes before treating the response as a PDF.
async function rmBinary({ apiKey, useSandbox, method, path, accept }) {
  const url = `${rmBaseUrl(useSandbox)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${normalizeRmApiKey(apiKey)}`,
      Accept: accept || "application/pdf",
    },
  });

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { ok: false, status: res.status, body: parsed, buffer: null };
  }

  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const looksLikePdf = buffer.length > 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF";
  if (!looksLikePdf) {
    const text = buffer.toString("utf8");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
    return {
      ok: false,
      status: 422,
      body: parsed || { message: `Royal Mail returned ${contentType || "non-PDF content"} instead of a PDF.` },
      buffer: null,
    };
  }

  return { ok: true, status: res.status, body: null, buffer };
}

// POST /orders — create a single Click & Drop order. C&D accepts a batch shape
// `{ items: [orderRequest, ...] }` where each orderRequest is a full order.
// Response: `{ createdOrders: [...], failedOrders: [...], errorsCount, ... }`.
export async function createCndOrder({ apiKey, useSandbox, order }) {
  return rmJson({
    apiKey, useSandbox,
    method: "POST",
    path: "/orders",
    body: { items: [order] },
  });
}

// GET /orders/{orderIdentifier}/label?documentType=postageLabel&documentFormat=PDF
// Royal Mail returns the PDF directly (binary). The orderIdentifier here is
// the integer C&D returns when the order is created.
export async function getCndLabel({ apiKey, useSandbox, orderIdentifier }) {
  const path =
    `/orders/${encodeURIComponent(orderIdentifier)}/label` +
    `?documentType=postageLabel&documentFormat=PDF`;
  return rmBinary({ apiKey, useSandbox, method: "GET", path });
}

// DELETE /orders — Click & Drop bulk delete. Send the orderIdentifier in
// the body. Only works while the order is still in the "Pending" tab
// (i.e. before a label has been generated and before despatch).
export async function deleteCndOrder({ apiKey, useSandbox, orderIdentifier }) {
  return rmJson({
    apiKey, useSandbox,
    method: "DELETE",
    path: "/orders",
    body: { orderIdentifiers: [Number(orderIdentifier)] },
  });
}

// POST /orders/despatch — mark the listed orders as despatched (closes the
// daily manifest for them).
export async function despatchCndOrders({ apiKey, useSandbox, orderIdentifiers }) {
  return rmJson({
    apiKey, useSandbox,
    method: "POST",
    path: "/orders/despatch",
    body: { orderIdentifiers: orderIdentifiers.map(Number) },
  });
}

// Normalise the createCndOrder response into a stable shape the route handler
// can persist. C&D returns either `createdOrders` (success) or `failedOrders`
// (per-item failure) — even when the HTTP status is 200, individual items can
// fail, so callers should check both.
export function normalizeCndCreateResponse(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Empty response from Royal Mail." };
  }
  const created = Array.isArray(body.createdOrders) ? body.createdOrders[0] : null;
  if (created) {
    return {
      ok: true,
      orderIdentifier: created.orderIdentifier ?? created.id ?? null,
      orderReference: created.orderReference ?? null,
      trackingNumber:
        created.trackingNumber ||
        created.trackingNumbers?.[0] ||
        created.consignmentNumber ||
        null,
    };
  }
  const failed = Array.isArray(body.failedOrders) ? body.failedOrders[0] : null;
  if (failed) {
    const msgs = Array.isArray(failed.errors)
      ? failed.errors.map((e) => e.errorMessage || e.message || JSON.stringify(e)).join("; ")
      : null;
    return {
      ok: false,
      error: msgs || failed.errorMessage || "Royal Mail rejected the order.",
      detail: failed,
    };
  }
  return { ok: false, error: "Unexpected response shape from Royal Mail.", detail: body };
}

// Probe the API key with the lightweight GET /version endpoint. Returns a
// stable { ok, status, message, detail } shape — never throws.
export async function testRmConnection({ apiKey, useSandbox }) {
  if (!apiKey) {
    return { ok: false, status: 0, message: "API key is required" };
  }
  // Probe with an authenticated endpoint. /version is unauthenticated on
  // Click & Drop and will return 200 even with a bogus key, which gives a
  // false-positive. /orders requires the Bearer token, so a valid key
  // returns 200 (with an order list) and an invalid key returns 401.
  try {
    const res = await rmJson({
      apiKey, useSandbox,
      method: "GET",
      path: "/orders?pageSize=1",
    });
    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        message: useSandbox
          ? "Connected to Royal Mail Click & Drop (sandbox key)."
          : "Connected to Royal Mail Click & Drop.",
        detail: { keyPrefix: apiKey.slice(0, 6), keyLength: apiKey.length },
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        message:
          "Royal Mail rejected the API key (401). Generate a new key in Click & Drop → Settings → Integrations, paste it here (no spaces), and save.",
        detail: res.body,
      };
    }
    return {
      ok: false,
      status: res.status,
      message: `Royal Mail returned ${res.status}.`,
      detail: res.body,
    };
  } catch (err) {
    return { ok: false, status: 0, message: `Network error: ${err.message}` };
  }
}
