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
