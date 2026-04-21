// API client — talks to the backend at /api/*.
// In local development you can set VITE_API_BASE, but we only honor it on localhost.

const isLocalBrowser = typeof window !== "undefined"
  && ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_BASE = isLocalBrowser ? (import.meta.env.VITE_API_BASE || "") : "";
const TOKEN_KEY = "ultrax_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

type Options = {
  method?: string;
  body?: unknown;
  raw?: boolean;
};

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (opts.raw) return res as unknown as T;

  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : `Request failed (${res.status})`);
    throw new Error(msg);
  }
  return data as T;
}

export async function apiBlob(path: string, opts: Options = {}): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.blob();
}

export type User = { id: number; email: string; role: "user" | "admin" };
export type Site = {
  id: number;
  name: string;
  store_url: string;
  created_at: string;
  // Return / sender address — printed on 4x6 shipping labels.
  // All fields are nullable: the user can fill them in later.
  return_name: string | null;
  return_company: string | null;
  return_line1: string | null;
  return_line2: string | null;
  return_city: string | null;
  return_postcode: string | null;
  return_country: string | null;
};
export type Invite = {
  id: number; email: string; role: string; used_at: string | null;
  expires_at: string; created_at: string; token: string;
};
export type FilterPreset = {
  id: number;
  name: string;
  created_at: string;
  payload: Record<string, unknown>;
};

// Shipments saved after a successful Royal Mail label creation. The PDF is
// fetched lazily via /api/royal-mail/shipments/:id/label.pdf so we only ship
// metadata here.
export type RmShipment = {
  id: number;
  woocommerce_order_id: number;
  woocommerce_store_url: string | null;
  royal_mail_shipment_id: string | null;
  tracking_number: string | null;
  service_code: string | null;
  has_label: boolean;
  manifested: boolean;
  manifest_id: string | null;
  voided: boolean;
  created_at: string;
};

// Suggested Royal Mail Click & Drop service codes shown in the dialog as a
// datalist. The valid codes for any given account depend on its contract
// (OBA, OLP, Tracked Returns, etc.), so this is just a starter list — users
// can type any code their Click & Drop account is enabled for.
//   OBA contract  : CRL1 / CRL2 (1st / 2nd Class), TPN / TPM (Tracked 24 / 48),
//                   TPLN / TPLM (Tracked 24 / 48 Signed)
//   OLP / pay-as-you-go (more common for small senders):
//     STL1 / STL2 — Standard 1st / 2nd Class
//     TRM24 / TRM48 — Tracked 24 / 48
//     SD1 / SD2 / SD5 — Special Delivery Guaranteed (£1k / £2.5k / £500)
export const RM_SERVICES: Array<{
  code: string; label: string; maxWeight: number;
}> = [
  // OLP (pay-as-you-go) — what most personal/small business accounts use
  { code: "STL1",  label: "1st Class",                maxWeight: 20000 },
  { code: "STL2",  label: "2nd Class",                maxWeight: 20000 },
  { code: "TRM24", label: "Tracked 24",               maxWeight: 20000 },
  { code: "TRM48", label: "Tracked 48",               maxWeight: 20000 },
  { code: "SD1",   label: "Special Delivery (£1k)",   maxWeight: 20000 },
  { code: "SD2",   label: "Special Delivery (£2.5k)", maxWeight: 20000 },
  // OBA (contract account)
  { code: "CRL1",  label: "1st Class (OBA)",          maxWeight: 20000 },
  { code: "CRL2",  label: "2nd Class (OBA)",          maxWeight: 20000 },
  { code: "TPN",   label: "Tracked 24 (OBA)",         maxWeight: 20000 },
  { code: "TPM",   label: "Tracked 48 (OBA)",         maxWeight: 20000 },
  { code: "TPLN",  label: "Tracked 24 Signed (OBA)",  maxWeight: 20000 },
  { code: "TPLM",  label: "Tracked 48 Signed (OBA)",  maxWeight: 20000 },
];

