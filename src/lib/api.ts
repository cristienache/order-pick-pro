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
export type Site = { id: number; name: string; store_url: string; created_at: string };
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
