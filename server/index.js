import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { db } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { signToken, requireAuth, requireAdmin } from "./auth.js";
import {
  fetchOrders,
  fetchOrderById,
  fetchOrderNotes,
  generatePicklistPdf,
  updateOrder,
  addOrderNote,
  fetchCustomerOrderCount,
} from "./woocommerce.js";
import { getFxRates } from "./fx.js";

const isDevelopment = process.env.NODE_ENV !== "production";

if (!process.env.JWT_SECRET && isDevelopment) {
  process.env.JWT_SECRET = "ultrax-dev-jwt-secret-local-only-change-in-production";
}
if (!process.env.ENCRYPTION_KEY && isDevelopment) {
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}
if (!process.env.ADMIN_EMAIL && isDevelopment) {
  process.env.ADMIN_EMAIL = "contact@ultrax.work";
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());

if (!process.env.JWT_SECRET) { console.error("FATAL: JWT_SECRET is required"); process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error("FATAL: ENCRYPTION_KEY is required"); process.exit(1); }
if (!ADMIN_EMAIL) { console.error("FATAL: ADMIN_EMAIL is required"); process.exit(1); }

const app = express();

// ---------- GitHub auto-deploy webhook ----------
// MUST be registered BEFORE express.json() — we need the raw request body
// to verify the HMAC signature. Once express.json() consumes the stream,
// req.body becomes a parsed Object and crypto.update() throws ERR_INVALID_ARG_TYPE.
const __deployFilename = fileURLToPath(import.meta.url);
const __deployDirname = path.dirname(__deployFilename);
const DEPLOY_SCRIPT = path.resolve(__deployDirname, "..", "scripts", "deploy.sh");

app.post(
  "/api/deploy/github",
  express.raw({ type: "*/*", limit: "5mb" }),
  (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "Webhook not configured" });

    const sig = req.header("x-hub-signature-256") || "";
    // req.body is a Buffer here thanks to express.raw above.
    const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(bodyBuf).digest("hex");
    let ok = false;
    try {
      ok =
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { ok = false; }
    if (!ok) return res.status(401).json({ error: "Bad signature" });

    const event = req.header("x-github-event");
    if (event === "ping") return res.json({ pong: true });
    if (event !== "push") return res.json({ ignored: event });

    // Fire-and-forget. Detached so the deploy survives an API restart
    // (the script restarts ultrax-api itself on server/ changes).
    const child = spawn("bash", [DEPLOY_SCRIPT], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    res.status(202).json({ ok: true, started: true });
  }
);

app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: CORS_ORIGIN.includes("*") ? true : CORS_ORIGIN,
  credentials: false,
}));
app.set("trust proxy", 1);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use("/api/auth/", authLimiter);
app.use("/api/", apiLimiter);

// ---------- Schemas ----------
const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});
const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8).max(200),
});
const inviteSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(["user", "admin"]).default("user"),
});
// Return-address fields are optional at save time (lets users add them later),
// but the picklist endpoint enforces them when generating shipping_4x6 labels.
const optAddrField = (max) =>
  z.string().trim().max(max).optional().or(z.literal("")).transform((v) => v || null);
const siteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  store_url: z.string().url().max(500),
  consumer_key: z.string().min(1).max(200),
  consumer_secret: z.string().min(1).max(200),
  return_name: optAddrField(100),
  return_company: optAddrField(100),
  return_line1: optAddrField(150),
  return_line2: optAddrField(150),
  return_city: optAddrField(80),
  return_postcode: optAddrField(20),
  return_country: optAddrField(60),
});
// Return-address-only update — used by the standalone "Edit return address"
// dialog so the user can change shipping label info without ever touching
// (and never risking accidental autofill of) the WooCommerce API keys.
const returnAddressSchema = z.object({
  return_name: optAddrField(100),
  return_company: optAddrField(100),
  return_line1: optAddrField(150),
  return_line2: optAddrField(150),
  return_city: optAddrField(80),
  return_postcode: optAddrField(20),
  return_country: optAddrField(60),
});
const generateSchema = z.object({
  selections: z.array(z.object({
    site_id: z.number().int().positive(),
    order_ids: z.array(z.number().int().positive()).min(1).max(500),
  })).min(1).max(20),
  // Accept new format names AND legacy aliases
  format: z.enum([
    "picking_a4", "packing_a4", "packing_4x6",
    "shipping_4x6", "shipping_a6",
    "a4", "label4x6",
  ]).optional().default("picking_a4"),
});

// Minimum required fields for a printable return address (sender block on
// the 4x6 shipping label). Country is recommended but not strictly required
// because most labels are domestic.
function returnAddressIsComplete(s) {
  return Boolean(
    s && (s.return_name || s.return_company) &&
    s.return_line1 && s.return_city && s.return_postcode,
  );
}

const presetSchema = z.object({
  site_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
});

const VALID_STATUSES = [
  "pending", "processing", "on-hold", "completed", "cancelled",
  "refunded", "failed", "trash",
];
const bulkActionSchema = z.object({
  selections: z.array(z.object({
    site_id: z.number().int().positive(),
    order_ids: z.array(z.number().int().positive()).min(1).max(500),
  })).min(1).max(20),
});
const bulkCompleteSchema = bulkActionSchema.extend({
  notify_customer: z.boolean().optional().default(true),
});
const bulkNoteSchema = bulkActionSchema.extend({
  note: z.string().trim().min(1).max(2000),
  customer_note: z.boolean().optional().default(false),
});

// ---------- Auth ----------
app.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { email, password } = parsed.data;

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  // Auto-promote master admin if email matches
  if (email.toLowerCase() === ADMIN_EMAIL && user.role !== "admin") {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    user.role = "admin";
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// One-time bootstrap: create master admin if no users exist.
app.post("/api/auth/bootstrap", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { email, password } = parsed.data;

  const count = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (count > 0) return res.status(403).json({ error: "Already bootstrapped" });
  if (email.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Bootstrap email must match ADMIN_EMAIL" });
  }
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 chars" });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')",
  ).run(email, hash);
  const user = { id: result.lastInsertRowid, email, role: "admin" };
  const token = signToken(user);
  res.json({ token, user });
});

app.get("/api/auth/status", (_req, res) => {
  const count = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  res.json({ bootstrapped: count > 0, adminEmail: ADMIN_EMAIL });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ user });
});

// ---------- FX rates (GBP base, cached for 1h) ----------
app.get("/api/fx", requireAuth, async (_req, res) => {
  try {
    const fx = await getFxRates();
    res.json({ base: fx.base, rates: fx.rates, fetchedAt: fx.fetchedAt, source: fx.source });
  } catch (e) {
    res.status(502).json({ error: e.message || "FX unavailable" });
  }
});

// ---------- Invites ----------
app.post("/api/invites", requireAuth, requireAdmin, (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { email, role } = parsed.data;

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "User already exists" });

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO invites (email, token, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(email, token, role, req.user.id, expiresAt);

  res.json({ token, expiresAt, email, role });
});

app.get("/api/invites", requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, email, role, used_at, expires_at, created_at, token
    FROM invites ORDER BY created_at DESC
  `).all();
  res.json({ invites: rows });
});

app.delete("/api/invites/:id", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM invites WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/invites/lookup/:token", (req, res) => {
  const inv = db.prepare("SELECT email, role, used_at, expires_at FROM invites WHERE token = ?")
    .get(req.params.token);
  if (!inv) return res.status(404).json({ error: "Invalid invite" });
  if (inv.used_at) return res.status(410).json({ error: "Invite already used" });
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: "Invite expired" });
  res.json({ email: inv.email, role: inv.role });
});

app.post("/api/auth/accept-invite", async (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { token, password } = parsed.data;

  const inv = db.prepare("SELECT * FROM invites WHERE token = ?").get(token);
  if (!inv) return res.status(404).json({ error: "Invalid invite" });
  if (inv.used_at) return res.status(410).json({ error: "Invite already used" });
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: "Invite expired" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(inv.email);
  if (existing) return res.status(409).json({ error: "User already exists" });

  const hash = await bcrypt.hash(password, 12);
  const tx = db.transaction(() => {
    const result = db.prepare(
      "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
    ).run(inv.email, hash, inv.role);
    db.prepare("UPDATE invites SET used_at = datetime('now') WHERE id = ?").run(inv.id);
    return result.lastInsertRowid;
  });
  const userId = tx();
  const user = { id: userId, email: inv.email, role: inv.role };
  const jwt = signToken(user);
  res.json({ token: jwt, user });
});

// ---------- Users (admin) ----------
app.get("/api/users", requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC").all();
  res.json({ users: rows });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------- Sites (per-user) ----------
// All "return_*" columns are nullable — the user can fill them in later via
// the Edit dialog. They're required only when generating a 4x6 shipping label.
const SITE_PUBLIC_COLS =
  "id, name, store_url, created_at, " +
  "return_name, return_company, return_line1, return_line2, " +
  "return_city, return_postcode, return_country";

app.get("/api/sites", requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT ${SITE_PUBLIC_COLS} FROM sites WHERE user_id = ? ORDER BY name ASC`,
  ).all(req.user.id);
  res.json({ sites: rows });
});

app.post("/api/sites", requireAuth, (req, res) => {
  const parsed = siteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  const d = parsed.data;
  const result = db.prepare(`
    INSERT INTO sites (
      user_id, name, store_url, consumer_key_enc, consumer_secret_enc,
      return_name, return_company, return_line1, return_line2,
      return_city, return_postcode, return_country
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, d.name, d.store_url.replace(/\/+$/, ""),
    encrypt(d.consumer_key), encrypt(d.consumer_secret),
    d.return_name, d.return_company, d.return_line1, d.return_line2,
    d.return_city, d.return_postcode, d.return_country,
  );
  const row = db.prepare(`SELECT ${SITE_PUBLIC_COLS} FROM sites WHERE id = ?`).get(result.lastInsertRowid);
  res.json({ site: row });
});

app.put("/api/sites/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!owned) return res.status(404).json({ error: "Not found" });
  const parsed = siteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const d = parsed.data;
  db.prepare(`
    UPDATE sites SET
      name = ?, store_url = ?, consumer_key_enc = ?, consumer_secret_enc = ?,
      return_name = ?, return_company = ?, return_line1 = ?, return_line2 = ?,
      return_city = ?, return_postcode = ?, return_country = ?
    WHERE id = ? AND user_id = ?
  `).run(
    d.name, d.store_url.replace(/\/+$/, ""),
    encrypt(d.consumer_key), encrypt(d.consumer_secret),
    d.return_name, d.return_company, d.return_line1, d.return_line2,
    d.return_city, d.return_postcode, d.return_country,
    id, req.user.id,
  );
  const row = db.prepare(`SELECT ${SITE_PUBLIC_COLS} FROM sites WHERE id = ?`).get(id);
  res.json({ site: row });
});

// Update ONLY the return address. Keeps WooCommerce keys completely out of
// this code path so browser autofill on the address form can never overwrite
// them.
app.patch("/api/sites/:id/return-address", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!owned) return res.status(404).json({ error: "Not found" });
  const parsed = returnAddressSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  const d = parsed.data;
  db.prepare(`
    UPDATE sites SET
      return_name = ?, return_company = ?, return_line1 = ?, return_line2 = ?,
      return_city = ?, return_postcode = ?, return_country = ?
    WHERE id = ? AND user_id = ?
  `).run(
    d.return_name, d.return_company, d.return_line1, d.return_line2,
    d.return_city, d.return_postcode, d.return_country,
    id, req.user.id,
  );
  const row = db.prepare(`SELECT ${SITE_PUBLIC_COLS} FROM sites WHERE id = ?`).get(id);
  res.json({ site: row });
});

app.delete("/api/sites/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sites WHERE id = ? AND user_id = ?").run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---------- Picklist ----------
function loadSiteWithKeys(siteId, userId) {
  const row = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(siteId, userId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    store_url: row.store_url,
    consumer_key: decrypt(row.consumer_key_enc),
    consumer_secret: decrypt(row.consumer_secret_enc),
    return_address: {
      name: row.return_name,
      company: row.return_company,
      line1: row.return_line1,
      line2: row.return_line2,
      city: row.return_city,
      postcode: row.return_postcode,
      country: row.return_country,
    },
  };
}

app.get("/api/sites/:id/orders", requireAuth, async (req, res) => {
  const site = loadSiteWithKeys(Number(req.params.id), req.user.id);
  if (!site) return res.status(404).json({ error: "Not found" });

  // ?statuses=processing,on-hold (default: processing). ?repeat=1 -> compute repeat-customer flag (extra API calls).
  const requested = String(req.query.statuses || "processing")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const statuses = requested.filter((s) => VALID_STATUSES.includes(s));
  if (statuses.length === 0) statuses.push("processing");
  const computeRepeat = req.query.repeat === "1" || req.query.repeat === "true";

  // Date bounds (ISO 8601). Forwarded to WooCommerce so historical statuses
  // like "completed" don't pull thousands of irrelevant orders.
  const after = typeof req.query.after === "string" && req.query.after ? req.query.after : null;
  const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;

  try {
    const orders = await fetchOrders(site, { statuses, after, before });

    // Optionally enrich with repeat-customer counts (rate-limited concurrency)
    let repeatMap = new Map();
    if (computeRepeat) {
      const emails = Array.from(new Set(
        orders.map((o) => (o.billing?.email || "").toLowerCase()).filter(Boolean),
      ));
      const chunkSize = 4;
      for (let i = 0; i < emails.length; i += chunkSize) {
        const chunk = emails.slice(i, i + chunkSize);
        const counts = await Promise.all(chunk.map((e) => fetchCustomerOrderCount(site, e)));
        chunk.forEach((e, idx) => repeatMap.set(e, counts[idx]));
      }
    }

    res.json({
      orders: orders.map((o) => {
        const email = (o.billing?.email || "").toLowerCase();
        const ship = Array.isArray(o.shipping_lines) && o.shipping_lines.length
          ? o.shipping_lines.map((s) => s.method_title).filter(Boolean).join(" + ")
          : "";
        return {
          id: o.id,
          number: o.number,
          status: o.status,
          date_created: o.date_created,
          total: o.total,
          currency: o.currency,
          customer: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim(),
          email,
          shipping_method: ship,
          itemCount: o.line_items.reduce((s, li) => s + li.quantity, 0),
          lineCount: o.line_items.length,
          previous_completed: repeatMap.get(email) ?? null,
        };
      }),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "Upstream error" });
  }
});

// Full order detail (used by the order detail drawer in the dashboard).
app.get("/api/sites/:id/orders/:orderId", requireAuth, async (req, res) => {
  const site = loadSiteWithKeys(Number(req.params.id), req.user.id);
  if (!site) return res.status(404).json({ error: "Not found" });
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const [order, notes] = await Promise.all([
      fetchOrderById(site, orderId),
      fetchOrderNotes(site, orderId),
    ]);
    res.json({ order, notes });
  } catch (e) {
    res.status(502).json({ error: e.message || "Upstream error" });
  }
});

// ---------- Bulk actions ----------
async function processBulk(selections, userId, perOrder) {
  const results = [];
  for (const sel of selections) {
    const site = loadSiteWithKeys(sel.site_id, userId);
    if (!site) {
      results.push({ site_id: sel.site_id, error: "Site not found", succeeded: 0, failed: sel.order_ids.length });
      continue;
    }
    let succeeded = 0;
    const errors = [];
    const chunkSize = 5;
    for (let i = 0; i < sel.order_ids.length; i += chunkSize) {
      const chunk = sel.order_ids.slice(i, i + chunkSize);
      const settled = await Promise.allSettled(chunk.map((id) => perOrder(site, id)));
      settled.forEach((r, idx) => {
        if (r.status === "fulfilled") succeeded++;
        else errors.push({ id: chunk[idx], error: r.reason?.message || String(r.reason) });
      });
    }
    results.push({
      site_id: sel.site_id,
      site_name: site.name,
      succeeded,
      failed: errors.length,
      errors: errors.slice(0, 10),
    });
  }
  return results;
}

app.post("/api/orders/complete", requireAuth, async (req, res) => {
  const parsed = bulkCompleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  try {
    const results = await processBulk(parsed.data.selections, req.user.id, (site, id) =>
      // status=completed; WooCommerce default behavior emails the customer when
      // moving from processing to completed. notify_customer=false suppresses it.
      updateOrder(site, id, parsed.data.notify_customer
        ? { status: "completed" }
        : { status: "completed", _suppress_notification: true })
    );
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message || "Bulk complete failed" });
  }
});

app.post("/api/orders/note", requireAuth, async (req, res) => {
  const parsed = bulkNoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  try {
    const results = await processBulk(parsed.data.selections, req.user.id, (site, id) =>
      addOrderNote(site, id, parsed.data.note, parsed.data.customer_note)
    );
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message || "Bulk note failed" });
  }
});

app.post("/api/picklist", requireAuth, async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const requiresReturnAddress = parsed.data.format === "shipping_4x6";

  try {
    const groups = [];
    for (const sel of parsed.data.selections) {
      const site = loadSiteWithKeys(sel.site_id, req.user.id);
      if (!site) return res.status(404).json({ error: `Site ${sel.site_id} not found` });

      // Block shipping-label generation for sites without a complete return
      // address — the label literally has nowhere to print "from", and Royal
      // Mail / couriers reject labels missing a sender.
      if (requiresReturnAddress && !returnAddressIsComplete({
        return_name: site.return_address.name,
        return_company: site.return_address.company,
        return_line1: site.return_address.line1,
        return_city: site.return_address.city,
        return_postcode: site.return_address.postcode,
      })) {
        return res.status(400).json({
          error: `"${site.name}" is missing a return address. Add it under Sites → Edit → Return address before printing 4x6 shipping labels.`,
        });
      }

      const orders = [];
      const chunkSize = 5;
      for (let i = 0; i < sel.order_ids.length; i += chunkSize) {
        const chunk = sel.order_ids.slice(i, i + chunkSize);
        const results = await Promise.all(chunk.map((id) => fetchOrderById(site, id)));
        orders.push(...results);
      }
      groups.push({
        site: {
          name: site.name,
          store_url: site.store_url,
          return_address: site.return_address,
        },
        orders,
      });
    }
    const pdf = await generatePicklistPdf(groups, { format: parsed.data.format });
    const fmt = parsed.data.format;
    const suffix =
      fmt === "shipping_4x6" || fmt === "shipping_a6" ? "shipping-labels"
      : fmt === "packing_4x6" || fmt === "label4x6" ? "packing-labels"
      : fmt === "packing_a4" ? "packing-slip"
      : "picking-slip";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${suffix}-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: e.message || "PDF generation failed" });
  }
});

// ---------- Filter presets (per user, per site) ----------
app.get("/api/sites/:id/presets", requireAuth, (req, res) => {
  const siteId = Number(req.params.id);
  const owned = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.user.id);
  if (!owned) return res.status(404).json({ error: "Site not found" });
  const rows = db.prepare(
    "SELECT id, name, payload, created_at FROM filter_presets WHERE user_id = ? AND site_id = ? ORDER BY name ASC"
  ).all(req.user.id, siteId);
  res.json({
    presets: rows.map((r) => ({
      id: r.id, name: r.name, created_at: r.created_at,
      payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
    })),
  });
});

app.post("/api/presets", requireAuth, (req, res) => {
  const parsed = presetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { site_id, name, payload } = parsed.data;
  const owned = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(site_id, req.user.id);
  if (!owned) return res.status(404).json({ error: "Site not found" });
  try {
    // Upsert by (user_id, site_id, name)
    const existing = db.prepare(
      "SELECT id FROM filter_presets WHERE user_id = ? AND site_id = ? AND name = ?"
    ).get(req.user.id, site_id, name);
    if (existing) {
      db.prepare("UPDATE filter_presets SET payload = ? WHERE id = ?").run(JSON.stringify(payload), existing.id);
      res.json({ id: existing.id, updated: true });
    } else {
      const r = db.prepare(
        "INSERT INTO filter_presets (user_id, site_id, name, payload) VALUES (?, ?, ?, ?)"
      ).run(req.user.id, site_id, name, JSON.stringify(payload));
      res.json({ id: r.lastInsertRowid, created: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to save preset" });
  }
});

app.delete("/api/presets/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare(
    "DELETE FROM filter_presets WHERE id = ? AND user_id = ?"
  ).run(id, req.user.id);
  res.json({ ok: true, deleted: r.changes });
});

// ---------- Royal Mail (Phase 1: credentials + sender + test connection) ----------
// Credentials are AES-GCM encrypted at rest. Sender address is plain text.
// Phase 2-4 will add: create shipment, label retrieval, manifest, void.
const rmCredsSchema = z.object({
  // Both credential fields are optional on save so the user can update only
  // the sender address without retyping the secret. An empty string means
  // "leave unchanged"; the literal "__clear__" means "remove it".
  client_id: z.string().trim().min(1).max(200).optional(),
  client_secret: z.string().trim().min(1).max(200).optional(),
  use_sandbox: z.boolean().optional().default(false),
});
const rmSenderSchema = z.object({
  sender_name: optAddrField(100),
  sender_company: optAddrField(100),
  sender_address_line1: optAddrField(150),
  sender_address_line2: optAddrField(150),
  sender_city: optAddrField(80),
  sender_postcode: optAddrField(20),
  sender_country: z.string().trim().min(2).max(3).optional().default("GB"),
  sender_phone: optAddrField(40),
  sender_email: z.string().trim().email().max(200).optional().or(z.literal("")).transform((v) => v || null),
});

// Public-safe view: never returns the encrypted credential blobs, only flags
// indicating whether each is currently set.
function rmRowToPublic(row) {
  if (!row) {
    return {
      has_client_id: false,
      has_client_secret: false,
      use_sandbox: false,
      sender_name: null, sender_company: null,
      sender_address_line1: null, sender_address_line2: null,
      sender_city: null, sender_postcode: null,
      sender_country: "GB", sender_phone: null, sender_email: null,
      last_tested_at: null, last_test_ok: null, last_test_message: null,
    };
  }
  return {
    has_client_id: Boolean(row.client_id_enc),
    has_client_secret: Boolean(row.client_secret_enc),
    use_sandbox: Boolean(row.use_sandbox),
    sender_name: row.sender_name,
    sender_company: row.sender_company,
    sender_address_line1: row.sender_address_line1,
    sender_address_line2: row.sender_address_line2,
    sender_city: row.sender_city,
    sender_postcode: row.sender_postcode,
    sender_country: row.sender_country || "GB",
    sender_phone: row.sender_phone,
    sender_email: row.sender_email,
    last_tested_at: row.last_tested_at,
    last_test_ok: row.last_test_ok === null ? null : Boolean(row.last_test_ok),
    last_test_message: row.last_test_message,
  };
}

app.get("/api/royal-mail/settings", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ settings: rmRowToPublic(row) });
});

// Update credentials only. Empty/missing field => leave existing value alone.
// To clear a credential, send the literal string "__clear__".
app.put("/api/royal-mail/credentials", requireAuth, (req, res) => {
  const parsed = rmCredsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { client_id, client_secret, use_sandbox } = parsed.data;

  const existing = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);

  const nextClientIdEnc = client_id === "__clear__"
    ? null
    : (client_id ? encrypt(client_id) : (existing?.client_id_enc ?? null));
  const nextClientSecretEnc = client_secret === "__clear__"
    ? null
    : (client_secret ? encrypt(client_secret) : (existing?.client_secret_enc ?? null));

  if (existing) {
    db.prepare(`
      UPDATE royal_mail_credentials
      SET client_id_enc = ?, client_secret_enc = ?, use_sandbox = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(nextClientIdEnc, nextClientSecretEnc, use_sandbox ? 1 : 0, req.user.id);
  } else {
    db.prepare(`
      INSERT INTO royal_mail_credentials (user_id, client_id_enc, client_secret_enc, use_sandbox)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, nextClientIdEnc, nextClientSecretEnc, use_sandbox ? 1 : 0);
  }

  // Token cache is keyed on (user, sandbox-flag); evict both buckets so the
  // next call uses the freshly-saved credentials.
  clearRmToken(req.user.id, false);
  clearRmToken(req.user.id, true);

  const row = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ settings: rmRowToPublic(row) });
});

app.put("/api/royal-mail/sender", requireAuth, (req, res) => {
  const parsed = rmSenderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const existing = db.prepare("SELECT user_id FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  if (existing) {
    db.prepare(`
      UPDATE royal_mail_credentials
      SET sender_name = ?, sender_company = ?, sender_address_line1 = ?, sender_address_line2 = ?,
          sender_city = ?, sender_postcode = ?, sender_country = ?, sender_phone = ?, sender_email = ?,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).run(
      d.sender_name, d.sender_company, d.sender_address_line1, d.sender_address_line2,
      d.sender_city, d.sender_postcode, d.sender_country || "GB", d.sender_phone, d.sender_email,
      req.user.id,
    );
  } else {
    db.prepare(`
      INSERT INTO royal_mail_credentials (
        user_id, sender_name, sender_company, sender_address_line1, sender_address_line2,
        sender_city, sender_postcode, sender_country, sender_phone, sender_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      d.sender_name, d.sender_company, d.sender_address_line1, d.sender_address_line2,
      d.sender_city, d.sender_postcode, d.sender_country || "GB", d.sender_phone, d.sender_email,
    );
  }
  const row = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ settings: rmRowToPublic(row) });
});

// Test connection — pulls saved credentials, calls Royal Mail, persists the
// outcome so the dashboard chip shows the latest status.
app.post("/api/royal-mail/test-connection", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  if (!row || !row.client_id_enc || !row.client_secret_enc) {
    return res.status(400).json({ ok: false, error: "Add Client ID and Secret first." });
  }
  let clientId, clientSecret;
  try {
    clientId = decrypt(row.client_id_enc);
    clientSecret = decrypt(row.client_secret_enc);
  } catch {
    return res.status(500).json({ ok: false, error: "Stored credentials could not be decrypted." });
  }
  const result = await testRmConnection({
    userId: req.user.id,
    clientId,
    clientSecret,
    useSandbox: Boolean(row.use_sandbox),
  });
  db.prepare(`
    UPDATE royal_mail_credentials
    SET last_tested_at = datetime('now'), last_test_ok = ?, last_test_message = ?
    WHERE user_id = ?
  `).run(result.ok ? 1 : 0, result.message || null, req.user.id);

  const updated = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ ...result, settings: rmRowToPublic(updated) });
});

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- GitHub deploy webhook ----------
// Configure in GitHub: repo Settings -> Webhooks -> Add webhook
//   Payload URL: https://www.ultrax.work/api/deploy/github
//   Content type: application/json
//   Secret: same value as GITHUB_WEBHOOK_SECRET in server/.env
//   Events: Just the push event
//
// We verify the HMAC signature, then fire scripts/deploy.sh in the background
// and return 202 immediately so GitHub doesn't time out waiting for the build.
app.listen(PORT, () => {
  console.log(`Ultrax API listening on http://127.0.0.1:${PORT}`);
  console.log(`Master admin: ${ADMIN_EMAIL}`);
});
