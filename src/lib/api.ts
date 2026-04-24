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

export type User = { id: number; email: string; role: "user" | "admin"; master_admin?: boolean };
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

// One connected eBay seller account. Refresh tokens never leave the server;
// the public view exposes only display metadata + the optional return address.
export type EbayAccount = {
  id: number;
  name: string;
  ebay_user_id: string | null;
  scopes: string | null;
  created_at: string;
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
  /** Phase 2: 'royal_mail' | 'packeta' */
  carrier?: string;
  packeta_packet_id?: string | null;
  packeta_barcode?: string | null;
  /** Deep link into Click & Drop's UI for this order — used as a fallback
   *  when the label PDF couldn't be retrieved (e.g. customs needs manual
   *  confirmation, non-OBA accounts). */
  click_and_drop_url?: string | null;
};

// CN22/CN23 customs declaration item. Required for international shipments.
// `unit_value` is the declared value of one unit in the parent block's
// currency; `customs_code` is the HS / commodity code; `origin_country` is
// the ISO-2 country of manufacture.
export type RmCustomsItem = {
  sku?: string;
  name: string;
  quantity: number;
  unit_value: number;
  customs_code: string;
  origin_country: string;
  customs_description?: string | null;
};
export type RmCustomsContentType =
  | "saleOfGoods"
  | "gift"
  | "documents"
  | "commercialSample"
  | "returnedGoods"
  | "mixedContent"
  | "other";
export type RmCustomsBlock = {
  content_type: RmCustomsContentType;
  currency_code: string;
  items: RmCustomsItem[];
};

// Settings returned by GET /api/royal-mail/settings.
export type RmSettings = {
  has_api_key: boolean;
  use_sandbox: boolean;
  sender_name: string | null;
  sender_company: string | null;
  sender_address_line1: string | null;
  sender_address_line2: string | null;
  sender_city: string | null;
  sender_postcode: string | null;
  sender_country: string;
  sender_phone: string | null;
  sender_email: string | null;
  /** ISO-2 country of manufacture used when creating CN22/CN23 declarations. */
  default_origin_country: string;
  /** Optional EORI number — attached to international shipments when present. */
  eori_number: string | null;
  /** Optional IOSS number — attached to international shipments when present. */
  ioss_number: string | null;
  /** Default content type for international shipments. */
  default_content_type: RmCustomsContentType;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
};

// Packeta carrier from the synced catalog.
export type PacketaCarrier = {
  id: number;
  name: string;
  country: string;
  currency: string | null;
  is_pickup_points: boolean;
  supports_cod: boolean;
  supports_age_verification: boolean;
  max_weight_kg: number | null;
  disallows_cod: boolean;
};

// Per-user country -> Packeta carrier route.
export type PacketaCountryRoute = {
  id: number;
  country: string;
  carrier_id: number;
  carrier_name: string | null;
  is_pickup_points: boolean | null;
  default_weight_kg: number;
  default_value: number;
  sort_order: number;
  updated_at: string;
};

// Royal Mail Click & Drop services. `formats` restricts the dropdown so the
// user can't pick e.g. a Letter service for a Parcel. `scope` controls
// whether a service shows for UK destinations or international ones:
//   - "domestic":      GB only
//   - "international": non-GB, non-EU (EU ships via Packeta)
// `signed` marks the service as having a signature on delivery, used for the
// "Signature required" toggle on domestic services.
export type RmFormat = "L" | "F" | "P";
export type RmScope = "domestic" | "international";
export type RmServiceDef = {
  code: string;
  label: string;
  maxWeight: number;
  formats: RmFormat[];
  scope: RmScope;
  signed?: boolean;
};
export const RM_SERVICES: RmServiceDef[] = [
  // ---- Domestic UK ----
  // Letter
  { code: "STL1",  label: "1st Class",                 maxWeight: 750,   formats: ["L"],          scope: "domestic" },
  { code: "STL2",  label: "2nd Class",                 maxWeight: 750,   formats: ["L"],          scope: "domestic" },
  // Letter / Large Letter / Parcel — signed (no tracking)
  { code: "STL1U", label: "1st Class Signed For",      maxWeight: 2000,  formats: ["L", "F", "P"], scope: "domestic", signed: true },
  { code: "STL2U", label: "2nd Class Signed For",      maxWeight: 2000,  formats: ["L", "F", "P"], scope: "domestic", signed: true },
  // Large Letter + Parcel — tracked
  { code: "CRL24", label: "Tracked 24",                maxWeight: 20000, formats: ["F", "P"],     scope: "domestic" },
  { code: "CRL48", label: "Tracked 48",                maxWeight: 20000, formats: ["F", "P"],     scope: "domestic" },

  // ---- International (non-EU) ----
  // Letter
  { code: "OLA",   label: "Int'l Standard",            maxWeight: 100,   formats: ["L", "F"],     scope: "international" },
  { code: "OTC",   label: "Int'l Tracked & Signed",    maxWeight: 2000,  formats: ["L", "F"],     scope: "international", signed: true },
  // Large Letter
  { code: "OTA",   label: "Int'l Tracked",             maxWeight: 2000,  formats: ["F"],          scope: "international" },
];

// EU country codes (ISO 3166-1 alpha-2). Orders to these are shipped via
// Packeta, so Royal Mail international services are hidden for them.
const EU_COUNTRIES = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
  "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE",
]);

export function rmDestinationScope(countryCode: string | undefined | null): RmScope | "eu" | "unknown" {
  const cc = (countryCode || "").trim().toUpperCase();
  if (!cc) return "unknown";
  if (cc === "GB" || cc === "UK") return "domestic";
  if (EU_COUNTRIES.has(cc)) return "eu";
  return "international";
}

export function rmServicesForFormat(
  format: RmFormat,
  opts?: { country?: string | null },
): RmServiceDef[] {
  const scope = rmDestinationScope(opts?.country);
  return RM_SERVICES.filter((s) => {
    if (!s.formats.includes(format)) return false;
    if (scope === "domestic") return s.scope === "domestic";
    if (scope === "international") return s.scope === "international";
    if (scope === "eu") return false; // Packeta handles these
    return true; // unknown — show everything
  });
}

// Map a base domestic service code to its signed variant. Returns null if no
// signed equivalent exists (i.e. the user must pick a signed service manually).
export function rmSignedVariant(code: string): string | null {
  switch (code.toUpperCase()) {
    case "STL1": return "STL1U";
    case "STL2": return "STL2U";
    case "CRL24": return "STL1U"; // tracked 24 -> signed for (no tracking, user choice)
    case "CRL48": return "STL2U";
    default: return null;
  }
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

// Today's orders aggregated across every site the user owns. Includes both
// "processing" and "completed" so the dashboard revenue total reflects fully
// shipped orders, not just the live backlog.
export type TodayStats = {
  count: number;
  // Map of currency code -> revenue total in that currency.
  revenue_by_currency: Record<string, number>;
};

export async function fetchTodayStats(): Promise<TodayStats> {
  return api<TodayStats>("/api/stats/today");
}

