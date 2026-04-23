// Packeta API client (REST/XML endpoint).
//
// Packeta exposes a single XML-over-HTTP endpoint that accepts a request
// envelope of the form:
//
//   <methodName>
//     <apiPassword>{{apiPassword}}</apiPassword>
//     ...
//   </methodName>
//
// And returns:
//
//   <response>
//     <status>ok|fault</status>
//     ...
//   </response>
//
// Phase 1 only needs to:
//   1. Save / clear the API password
//   2. Test that the password is valid by calling a lightweight authenticated
//      method (`senderGetReturnRouting`) — fault.code "WrongApiPassword"
//      tells us the password is bad; "SenderNotExists" / "InvalidSender"
//      tells us the password is fine but the sender label we sent isn't
//      registered, which is still proof of authentication.
//
// Production endpoint:  https://www.zasilkovna.cz/api/rest
// Sandbox endpoint:     same host — Packeta does not publish a separate
//                       sandbox URL, but a separate test-environment API
//                       password can be issued on request. We keep the
//                       `useSandbox` flag for UI clarity and so we can flip
//                       URLs if Packeta ever exposes one.

const PROD_BASE = "https://www.zasilkovna.cz/api/rest";
const SANDBOX_BASE = "https://www.zasilkovna.cz/api/rest";

export function packetaBaseUrl(useSandbox) {
  return useSandbox ? SANDBOX_BASE : PROD_BASE;
}

// Strip whitespace, surrounding quotes and zero-width characters from a
// pasted password. Mirrors normalizeRmApiKey in royalmail.js.
export function normalizePacketaPassword(password) {
  return String(password || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

// Minimal XML escaper for values we substitute into the request body.
function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Pull the contents of a single <tag>...</tag> from a Packeta response.
// Packeta responses are flat enough that a regex is sufficient — we don't
// want to drag in an XML parser for Phase 1.
function pickTag(xml, tag) {
  if (typeof xml !== "string") return null;
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

// Test connection. Returns a stable { ok, status, message, detail } shape —
// never throws. We probe with `senderGetReturnRouting` because it requires
// authentication; an invalid password yields fault.code = "WrongApiPassword"
// while a missing/unknown sender label yields a different fault that still
// proves the password was accepted.
export async function testPacketaConnection({ apiPassword, useSandbox }) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) {
    return { ok: false, status: 0, message: "API password is required" };
  }

  const url = packetaBaseUrl(Boolean(useSandbox));
  const body =
    `<senderGetReturnRouting>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<senderLabel>__connection_test__</senderLabel>` +
    `</senderGetReturnRouting>`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        Accept: "text/xml, application/xml",
      },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, message: `Network error: ${err.message}` };
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `Packeta returned HTTP ${res.status}.`,
      detail: text.slice(0, 500),
    };
  }

  const status = (pickTag(text, "status") || "").toLowerCase();
  const faultCode = pickTag(text, "fault") || pickTag(text, "code");
  const faultMessage = pickTag(text, "string") || pickTag(text, "message");

  // Status "ok" — password works AND the bogus sender label happened to
  // match (very unlikely). Either way: authentication succeeded.
  if (status === "ok") {
    return {
      ok: true,
      status: res.status,
      message: useSandbox
        ? "Connected to Packeta (sandbox key)."
        : "Connected to Packeta.",
    };
  }

  // The classic auth failure — wrong password.
  if (faultCode && /WrongApiPassword|InvalidApiPassword|NotAuthenticated/i.test(faultCode)) {
    return {
      ok: false,
      status: res.status,
      message:
        "Packeta rejected the API password. Generate a new password in your Packeta client section and paste it here (no spaces).",
      detail: faultMessage || faultCode,
    };
  }

  // Any other fault (e.g. "SenderNotExists", "InvalidSender",
  // "SenderLabelNotFound") means the password was accepted but the test
  // sender label wasn't recognised — which is the expected outcome of our
  // probe. Treat it as a successful authentication.
  if (faultCode || faultMessage) {
    return {
      ok: true,
      status: res.status,
      message: useSandbox
        ? "Connected to Packeta (sandbox key)."
        : "Connected to Packeta.",
      detail: faultMessage || faultCode,
    };
  }

  // Unknown shape — surface the raw response head so the user can report it.
  return {
    ok: false,
    status: res.status,
    message: "Unexpected response from Packeta.",
    detail: text.slice(0, 500),
  };
}

// Verify a sender label (eshop ID) against Packeta. Packeta's API does NOT
// expose a "list senders" method — `senderGetReturnRouting` is the only
// sender-related endpoint, and it accepts a single label and returns either
// the routing strings (sender exists) or a `SenderNotExists` fault.
//
// Return shape mirrors testPacketaConnection so the UI can reuse the same
// rendering logic.
export async function verifyPacketaSender({ apiPassword, useSandbox, senderLabel }) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) {
    return { ok: false, status: 0, message: "API password is required" };
  }
  const label = String(senderLabel || "").trim();
  if (!label) {
    return { ok: false, status: 0, message: "Sender ID is required" };
  }

  const url = packetaBaseUrl(Boolean(useSandbox));
  const body =
    `<senderGetReturnRouting>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<senderLabel>${xmlEscape(label)}</senderLabel>` +
    `</senderGetReturnRouting>`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        Accept: "text/xml, application/xml",
      },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, message: `Network error: ${err.message}` };
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `Packeta returned HTTP ${res.status}.`,
      detail: text.slice(0, 500),
    };
  }

  const status = (pickTag(text, "status") || "").toLowerCase();
  const faultCode = pickTag(text, "fault") || pickTag(text, "code");
  const faultMessage = pickTag(text, "string") || pickTag(text, "message");

  if (status === "ok") {
    return {
      ok: true,
      status: res.status,
      message: `Sender "${label}" is registered in your Packeta account.`,
    };
  }

  if (faultCode && /WrongApiPassword|InvalidApiPassword|NotAuthenticated/i.test(faultCode)) {
    return {
      ok: false,
      status: res.status,
      message: "Packeta rejected the API password. Save a valid password first.",
      detail: faultMessage || faultCode,
    };
  }

  if (faultCode && /SenderNotExists|InvalidSender|SenderLabelNotFound/i.test(faultCode)) {
    return {
      ok: false,
      status: res.status,
      message: `Packeta does not recognise sender "${label}". Check the exact code in Packeta client section → Settings → Senders.`,
      detail: faultMessage || faultCode,
    };
  }

  if (faultCode || faultMessage) {
    return {
      ok: false,
      status: res.status,
      message: faultMessage || faultCode || "Packeta rejected the sender.",
      detail: faultMessage || faultCode,
    };
  }

  return {
    ok: false,
    status: res.status,
    message: "Unexpected response from Packeta.",
    detail: text.slice(0, 500),
  };
}

// ---------- Phase 2: createPacket + label PDF ----------

// Generic order-meta reader. Walks order.meta_data and every shipping line's
// meta_data and returns the first value whose lowercased key is in `keys`.
function readOrderMeta(order, keys) {
  if (!order || typeof order !== "object") return null;
  const set = new Set(keys.map((k) => String(k).toLowerCase()));
  const tryRead = (arr) => {
    if (!Array.isArray(arr)) return null;
    for (const m of arr) {
      const k = String(m?.key || "").toLowerCase().trim();
      if (set.has(k)) {
        const v = m.value;
        if (v == null || v === "") continue;
        const str = String(v).trim();
        if (str) return str;
      }
    }
    return null;
  };
  const fromOrder = tryRead(order.meta_data);
  if (fromOrder) return fromOrder;
  if (Array.isArray(order.shipping_lines)) {
    for (const line of order.shipping_lines) {
      const v = tryRead(line.meta_data);
      if (v) return v;
    }
  }
  return null;
}

// Read the WC Packeta plugin's pickup-point ID off a WooCommerce order.
// Stored in order/shipping-line meta as `packetery_point_id` (and a few
// historical aliases).
export function pickPacketaPickupPointId(order) {
  return readOrderMeta(order, [
    "packetery_point_id",
    "_packetery_point_id",
    "packeta_point_id",
    "_packeta_point_id",
    "packetery point id",
  ]);
}

// Carrier ID chosen by the customer at checkout via the Packeta WC plugin.
// Stored in `packetery_carrier_id` meta. May be:
//   - a numeric Packeta carrier code (e.g. "106" for CZ Home Delivery)
//   - the literal string "zpoint" / "packeta" for Packeta pickup points
// We pass it through verbatim; the caller decides whether to look it up in
// our carrier catalog.
export function pickPacketaCarrierId(order) {
  return readOrderMeta(order, [
    "packetery_carrier_id",
    "_packetery_carrier_id",
    "packeta_carrier_id",
  ]);
}

// Order weight (kg) saved by the WC Packeta plugin. Falls back to null if
// not present so the caller can use its own default.
export function pickPacketaWeightKg(order) {
  const raw = readOrderMeta(order, ["packetery_weight", "_packetery_weight"]);
  if (raw == null) return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Order dimensions (cm) saved by the WC Packeta plugin. Returns
// { length, width, height } with each value either a positive number or null.
export function pickPacketaDimensions(order) {
  const read = (keys) => {
    const raw = readOrderMeta(order, keys);
    if (raw == null) return null;
    const n = Number(String(raw).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    length: read(["packetery_length", "_packetery_length"]),
    width: read(["packetery_width", "_packetery_width"]),
    height: read(["packetery_height", "_packetery_height"]),
  };
}


// POST createPacket. `packet` should already be normalised — see
// buildCreatePacketBody below.
export async function createPacketaPacket({ apiPassword, useSandbox, packet }) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) {
    return { ok: false, status: 0, error: "API password missing" };
  }

  const fields = Object.entries(packet)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join("");

  const body =
    `<createPacket>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<packetAttributes>${fields}</packetAttributes>` +
    `</createPacket>`;

  let res;
  try {
    res = await fetch(packetaBaseUrl(Boolean(useSandbox)), {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }

  const text = await res.text().catch(() => "");
  const status = (pickTag(text, "status") || "").toLowerCase();

  if (status === "ok") {
    const result = pickTag(text, "result") || text;
    const packetId = pickTag(result, "id") || pickTag(text, "id");
    const barcode = pickTag(result, "barcode") || pickTag(text, "barcode");
    const barcodeText = pickTag(result, "barcodeText") || pickTag(text, "barcodeText");
    return {
      ok: true,
      status: res.status,
      packetId: packetId ? String(packetId).trim() : null,
      barcode: barcode ? String(barcode).trim() : null,
      barcodeText: barcodeText ? String(barcodeText).trim() : null,
    };
  }

  // Fault — extract a useful message for the UI.
  const fault = pickTag(text, "fault") || "fault";
  const message = pickTag(text, "string") || pickTag(text, "message") || fault;
  // Per-attribute errors are nested in <detail><attributes><fault><name/><fault/></fault>...
  const detailRaw = pickTag(text, "detail") || "";
  const fieldErrors = [];
  if (detailRaw) {
    const re = /<fault[^>]*>\s*<name>([^<]+)<\/name>\s*<fault>([^<]+)<\/fault>/gi;
    let m;
    while ((m = re.exec(detailRaw)) !== null) {
      fieldErrors.push(`${m[1]}: ${m[2]}`);
    }
  }
  return {
    ok: false,
    status: res.status,
    error: fieldErrors.length > 0 ? fieldErrors.join("; ") : message,
    detail: text.slice(0, 800),
  };
}

// GET packetLabelPdf. Format defaults to A6 on A6 (4×6" thermal). Returns
// { ok, status, buffer | error }.
//
// Packeta supports several label formats; we expose only the thermal-friendly
// 4×6"-equivalent. Other documented formats include:
//   - A6 on A6        — single label per A6 page (~4×6 inches). DEFAULT.
//   - A6 on A4        — four labels per A4 page (saves paper for laser).
//   - 105x148 on A7   — narrow thermal.
export async function getPacketaLabelPdf({
  apiPassword,
  useSandbox,
  packetId,
  format = "A6 on A6",
  offset = 0,
}) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) return { ok: false, status: 0, error: "API password missing" };
  if (!packetId) return { ok: false, status: 0, error: "Packet ID required" };

  const body =
    `<packetLabelPdf>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<packetId>${xmlEscape(packetId)}</packetId>` +
      `<format>${xmlEscape(format)}</format>` +
      `<offset>${xmlEscape(String(offset))}</offset>` +
    `</packetLabelPdf>`;

  let res;
  try {
    res = await fetch(packetaBaseUrl(Boolean(useSandbox)), {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }

  const text = await res.text().catch(() => "");
  const status = (pickTag(text, "status") || "").toLowerCase();
  if (status !== "ok") {
    const message = pickTag(text, "string") || pickTag(text, "message") || "Packeta refused the label request.";
    return { ok: false, status: res.status, error: message, detail: text.slice(0, 500) };
  }
  // <result> contains base64-encoded PDF bytes.
  const b64 = (pickTag(text, "result") || "").replace(/\s+/g, "");
  if (!b64) {
    return { ok: false, status: res.status, error: "Packeta returned an empty label." };
  }
  let buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch (err) {
    return { ok: false, status: res.status, error: `Bad base64 from Packeta: ${err.message}` };
  }
  const looksLikePdf = buffer.length > 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF";
  if (!looksLikePdf) {
    return { ok: false, status: res.status, error: "Packeta returned a non-PDF document." };
  }
  return { ok: true, status: res.status, buffer };
}

// Fetch the carrier (courier) tracking number assigned by Packeta after the
// packet has been routed to an external carrier (DHL, bpost, DPD, PPL, ...).
// Returns { ok, status, courierNumber | error }. A "PacketNotRouted" / similar
// fault means Packeta has not yet handed the packet over to the carrier — the
// caller should fall back to the generic Packeta label in that case.
export async function getPacketaCourierNumber({ apiPassword, useSandbox, packetId }) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) return { ok: false, status: 0, error: "API password missing" };
  if (!packetId) return { ok: false, status: 0, error: "Packet ID required" };

  const body =
    `<packetCourierNumber>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<packetId>${xmlEscape(packetId)}</packetId>` +
    `</packetCourierNumber>`;

  let res;
  try {
    res = await fetch(packetaBaseUrl(Boolean(useSandbox)), {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }
  const text = await res.text().catch(() => "");
  const status = (pickTag(text, "status") || "").toLowerCase();
  if (status !== "ok") {
    const message = pickTag(text, "string") || pickTag(text, "message") || "Packeta refused the courier-number request.";
    return { ok: false, status: res.status, error: message };
  }
  const courierNumber = pickTag(text, "result") || "";
  if (!courierNumber) {
    return { ok: false, status: res.status, error: "Packeta returned an empty courier number." };
  }
  return { ok: true, status: res.status, courierNumber };
}

// GET packetCourierLabelPdf — the OFFICIAL CARRIER LABEL (DHL, bpost, DPD,
// PPL, etc.) generated by the third-party carrier and proxied through Packeta.
// This is the label the Packeta admin UI shows / prints for routed packets.
//
// `courierNumber` is the carrier-assigned tracking number from
// `packetCourierNumber`. Format defaults to A6 on A6 (4×6" thermal).
//
// Returns { ok, status, buffer | error }. If Packeta has not yet routed the
// packet to a carrier (or no carrier label exists), this returns ok=false and
// the caller should fall back to `getPacketaLabelPdf`.
export async function getPacketaCourierLabelPdf({
  apiPassword,
  useSandbox,
  packetId,
  courierNumber,
  format = "A6 on A6",
  offset = 0,
}) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) return { ok: false, status: 0, error: "API password missing" };
  if (!packetId) return { ok: false, status: 0, error: "Packet ID required" };
  if (!courierNumber) return { ok: false, status: 0, error: "Courier number required" };

  const body =
    `<packetCourierLabelPdf>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<packetId>${xmlEscape(packetId)}</packetId>` +
      `<courierNumber>${xmlEscape(courierNumber)}</courierNumber>` +
      `<format>${xmlEscape(format)}</format>` +
      `<offset>${xmlEscape(String(offset))}</offset>` +
    `</packetCourierLabelPdf>`;

  let res;
  try {
    res = await fetch(packetaBaseUrl(Boolean(useSandbox)), {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }
  const text = await res.text().catch(() => "");
  const status = (pickTag(text, "status") || "").toLowerCase();
  if (status !== "ok") {
    const message = pickTag(text, "string") || pickTag(text, "message") || "Packeta refused the courier-label request.";
    return { ok: false, status: res.status, error: message, detail: text.slice(0, 500) };
  }
  const b64 = (pickTag(text, "result") || "").replace(/\s+/g, "");
  if (!b64) {
    return { ok: false, status: res.status, error: "Packeta returned an empty courier label." };
  }
  let buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch (err) {
    return { ok: false, status: res.status, error: `Bad base64 from Packeta: ${err.message}` };
  }
  const looksLikePdf = buffer.length > 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF";
  if (!looksLikePdf) {
    return { ok: false, status: res.status, error: "Packeta returned a non-PDF document." };
  }
  return { ok: true, status: res.status, buffer };
}

// Fetch a single merged PDF for many packets in one call. Avoids one round
// trip per label and lets Packeta tile labels on shared pages.
export async function getPacketaLabelsPdf({
  apiPassword,
  useSandbox,
  packetIds,
  format = "A6 on A6",
}) {
  const password = normalizePacketaPassword(apiPassword);
  if (!password) return { ok: false, status: 0, error: "API password missing" };
  if (!Array.isArray(packetIds) || packetIds.length === 0) {
    return { ok: false, status: 0, error: "No packet IDs supplied" };
  }

  const idsXml = packetIds
    .map((id) => `<packetId>${xmlEscape(id)}</packetId>`)
    .join("");
  const body =
    `<packetsLabelsPdf>` +
      `<apiPassword>${xmlEscape(password)}</apiPassword>` +
      `<packetIds>${idsXml}</packetIds>` +
      `<format>${xmlEscape(format)}</format>` +
      `<offset>0</offset>` +
    `</packetsLabelsPdf>`;

  let res;
  try {
    res = await fetch(packetaBaseUrl(Boolean(useSandbox)), {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }
  const text = await res.text().catch(() => "");
  const status = (pickTag(text, "status") || "").toLowerCase();
  if (status !== "ok") {
    const message = pickTag(text, "string") || pickTag(text, "message") || "Packeta refused the labels request.";
    return { ok: false, status: res.status, error: message };
  }
  const b64 = (pickTag(text, "result") || "").replace(/\s+/g, "");
  if (!b64) return { ok: false, status: res.status, error: "Empty labels response." };
  const buffer = Buffer.from(b64, "base64");
  const looksLikePdf = buffer.length > 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF";
  if (!looksLikePdf) {
    return { ok: false, status: res.status, error: "Packeta returned a non-PDF document." };
  }
  return { ok: true, status: res.status, buffer };
}

