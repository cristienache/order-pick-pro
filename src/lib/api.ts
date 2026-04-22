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
  /** ISO timestamp set the first time this label was sent to a printer. */
  printed_at: string | null;
  created_at: string;
};

// Royal Mail Click & Drop services. `formats` restricts the dropdown so the
// user can't pick e.g. a Letter service for a Parcel:
//   Letter        -> STL1, STL2
//   Large Letter  -> CRL24, CRL48
//   Parcel        -> CRL24, CRL48
export type RmFormat = "L" | "F" | "P";
export type RmServiceDef = {
  code: string; label: string; maxWeight: number; formats: RmFormat[];
};
export const RM_SERVICES: RmServiceDef[] = [
  { code: "STL1",  label: "1st Class",                  maxWeight: 750,    formats: ["L"] },
  { code: "STL2",  label: "2nd Class",                  maxWeight: 750,    formats: ["L"] },
  { code: "CRL24", label: "Tracked 24",                 maxWeight: 20000,  formats: ["F", "P"] },
  { code: "CRL48", label: "Tracked 48",                 maxWeight: 20000,  formats: ["F", "P"] },
  // Legacy / OBA / Special Delivery — kept for accounts already using them
  { code: "TRM24", label: "Tracked 24 (legacy)",        maxWeight: 20000,  formats: ["F", "P"] },
  { code: "TRM48", label: "Tracked 48 (legacy)",        maxWeight: 20000,  formats: ["F", "P"] },
  { code: "SD1",   label: "Special Delivery (£1k)",     maxWeight: 20000,  formats: ["F", "P"] },
  { code: "SD2",   label: "Special Delivery (£2.5k)",   maxWeight: 20000,  formats: ["F", "P"] },
  { code: "CRL1",  label: "1st Class (OBA)",            maxWeight: 20000,  formats: ["L", "F", "P"] },
  { code: "CRL2",  label: "2nd Class (OBA)",            maxWeight: 20000,  formats: ["L", "F", "P"] },
  { code: "TPN",   label: "Tracked 24 (OBA)",           maxWeight: 20000,  formats: ["F", "P"] },
  { code: "TPM",   label: "Tracked 48 (OBA)",           maxWeight: 20000,  formats: ["F", "P"] },
  { code: "TPLN",  label: "Tracked 24 Signed (OBA)",    maxWeight: 20000,  formats: ["F", "P"] },
  { code: "TPLM",  label: "Tracked 48 Signed (OBA)",    maxWeight: 20000,  formats: ["F", "P"] },
];

export function rmServicesForFormat(format: RmFormat): RmServiceDef[] {
  return RM_SERVICES.filter((s) => s.formats.includes(format));
}

/** Tell the server these labels were just printed; auto-completes WC orders. */
export async function markShipmentsPrinted(ids: number[]): Promise<{
  printed: number; completed: number;
  completionErrors?: { site_id?: number; order_id?: number; error: string }[];
}> {
  if (ids.length === 0) return { printed: 0, completed: 0 };
  return api("/api/royal-mail/shipments/mark-printed", {
    method: "POST",
    body: { ids },
  });
}

