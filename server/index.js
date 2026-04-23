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
import jwt from "jsonwebtoken";

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
import {
  testRmConnection,
  clearRmToken,
  createCndOrder,
  getCndLabel,
  deleteCndOrder,
  normalizeCndCreateResponse,
  normalizeRmApiKey,
} from "./royalmail.js";
import {
  testPacketaConnection,
  verifyPacketaSender,
  normalizePacketaPassword,
  pickPacketaPickupPointId,
  pickPacketaCarrierId,
  pickPacketaWeightKg,
  pickPacketaDimensions,
  createPacketaPacket,
  getPacketaLabelPdf,
  getPacketaLabelsPdf,
  getPacketaCourierNumber,
  getPacketaCourierLabelPdf,
} from "./packeta.js";
import {
  syncPacketaCarriers,
  getCatalogLastSyncedAt,
  isCatalogStale,
} from "./packetaCarriers.js";
import {
  ebayConfig,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getAccessToken,
  fetchEbayUserId,
  fetchOrders as fetchEbayOrders,
  normalizeEbayOrder,
} from "./ebay.js";
import { sendContactEmail, smtpConfig } from "./mailer.js";
import { mountOms } from "./oms.js";
import { mountOmsWoo } from "./oms-woo.js";
import { mountOmsPo } from "./oms-po.js";

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

  // Block pending / rejected accounts. Master admin email is always allowed.
  if (email.toLowerCase() !== ADMIN_EMAIL) {
    if (user.status === "pending") {
      return res.status(403).json({ error: "Your account is awaiting admin approval. You'll receive an email once approved." });
    }
    if (user.status === "rejected") {
      return res.status(403).json({ error: "This account has been rejected. Please contact support." });
    }
  }

  // Auto-promote master admin if email matches
  if (email.toLowerCase() === ADMIN_EMAIL && user.role !== "admin") {
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(user.id);
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
  res.json({
    bootstrapped: count > 0,
    adminEmail: ADMIN_EMAIL,
    publicSignup: process.env.ALLOW_PUBLIC_SIGNUP !== "false", // default on
  });
});

// ---------- Public self-signup ----------
// Allows anyone to create a regular ('user') account. Bootstrap of the master
// admin is still handled separately by /api/auth/bootstrap. This endpoint is
// rate-limited via the /api/auth/ limiter and can be disabled by setting the
// env var ALLOW_PUBLIC_SIGNUP=false.
const signupSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
});
app.post("/api/auth/signup", async (req, res) => {
  if (process.env.ALLOW_PUBLIC_SIGNUP === "false") {
    return res.status(403).json({ error: "Public signup is disabled" });
  }
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { email, password } = parsed.data;

  // Master admin must use bootstrap flow, not signup.
  if (email.toLowerCase() === ADMIN_EMAIL) {
    return res.status(403).json({ error: "This email is reserved. Use first-time setup." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'user')",
  ).run(email, hash);
  const user = { id: result.lastInsertRowid, email, role: "user" };
  const token = signToken(user);
  res.json({ token, user });
});

// ---------- Public contact form ----------
// Public POST endpoint (no auth) used by /contact. Heavily rate-limited per IP
// so the form can't be abused for spam relay. Validation is strict (zod) and
// we never echo anything from the request back to the client beyond a generic
// success or error so we don't become an open oracle for typo'd addresses.
const contactLimiter = rateLimit({
  windowMs: 60 * 60_000, // 1 hour
  max: 5,                // 5 submissions per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages from this IP. Try again later." },
});
const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  // Optional: allow blank / undefined / null without failing.
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(40).regex(/^[+\d\s().-]+$/, "Invalid phone").optional(),
  ),
  subject: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(150).optional(),
  ),
  message: z.string().trim().min(10).max(5000),
  // Honeypot — real browsers leave this empty; bots tend to fill every field.
  website: z.string().max(0).optional(),
});

app.post("/api/contact", contactLimiter, async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  // Honeypot triggered — pretend success so bots don't retry.
  if (parsed.data.website) return res.json({ ok: true });

  const cfg = smtpConfig();
  if (!cfg.configured) {
    console.error("[contact] SMTP not configured (set SMTP_USER and SMTP_PASS).");
    return res.status(503).json({ error: "Contact form is not configured yet. Please email us directly." });
  }
  try {
    await sendContactEmail(parsed.data);
    res.json({ ok: true });
  } catch (e) {
    console.error("[contact] sendMail failed:", e);
    res.status(502).json({ error: "Failed to send message. Please try again or email us directly." });
  }
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

// ---------- Branding (global, single row) ----------
// Phase 1 of the page builder. Anyone signed in can READ branding so the
// app-shell can render the right name/logo/colours. Only admins can WRITE.
// Logos & favicons are stored as data URLs (PNG/SVG/ICO base64) inside the
// row to avoid a separate uploads pipeline. The frontend caps each upload
// at ~256KB so the row stays small. Colour palette + nav label overrides
// are JSON blobs.
const BRANDING_DEFAULTS = Object.freeze({
  app_name: "Ultrax",
  tagline: "Order ops",
  logo_data_url: null,
  favicon_data_url: null,
  nav_labels: {},
  colors: {},
});

function readBrandingRow() {
  const row = db.prepare(
    `SELECT app_name, tagline, logo_data_url, favicon_data_url,
            nav_labels, colors, updated_at
       FROM branding WHERE id = 1`,
  ).get();
  if (!row) return { ...BRANDING_DEFAULTS, updated_at: null };
  let nav_labels = {};
  let colors = {};
  try { nav_labels = JSON.parse(row.nav_labels || "{}"); } catch { nav_labels = {}; }
  try { colors = JSON.parse(row.colors || "{}"); } catch { colors = {}; }
  return {
    app_name: row.app_name || BRANDING_DEFAULTS.app_name,
    tagline: row.tagline || BRANDING_DEFAULTS.tagline,
    logo_data_url: row.logo_data_url || null,
    favicon_data_url: row.favicon_data_url || null,
    nav_labels,
    colors,
    updated_at: row.updated_at || null,
  };
}

// Public read — no auth so the brand applies on /login too.
app.get("/api/branding", (_req, res) => {
  res.json({ branding: readBrandingRow() });
});

const MAX_DATA_URL_BYTES = 350_000; // ~256KB binary after base64 overhead
const BrandingUpdateSchema = z.object({
  app_name: z.string().trim().min(1).max(60).optional(),
  tagline: z.string().trim().max(80).optional(),
  // null clears the asset, undefined leaves it untouched, string replaces.
  logo_data_url: z.union([z.string().max(MAX_DATA_URL_BYTES), z.null()]).optional(),
  favicon_data_url: z.union([z.string().max(MAX_DATA_URL_BYTES), z.null()]).optional(),
  nav_labels: z.record(z.string(), z.string().max(40)).optional(),
  colors: z.record(z.string(), z.string().max(80)).optional(),
});

app.put("/api/branding", requireAuth, requireAdmin, (req, res) => {
  const parsed = BrandingUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  }
  const patch = parsed.data;

  // Validate data URLs are actually data: URLs of the right image type.
  const checks = [
    ["logo_data_url", /^data:image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon);base64,/],
    ["favicon_data_url", /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,/],
  ];
  for (const [field, allowed] of checks) {
    const v = patch[field];
    if (typeof v === "string" && v.length > 0 && !allowed.test(v)) {
      return res.status(400).json({ error: `Invalid ${field}: must be a base64-encoded image data URL` });
    }
  }

  const current = readBrandingRow();
  const next = {
    app_name: patch.app_name ?? current.app_name,
    tagline: patch.tagline ?? current.tagline,
    logo_data_url: patch.logo_data_url === undefined ? current.logo_data_url : patch.logo_data_url,
    favicon_data_url: patch.favicon_data_url === undefined ? current.favicon_data_url : patch.favicon_data_url,
    nav_labels: patch.nav_labels ?? current.nav_labels,
    colors: patch.colors ?? current.colors,
  };

  db.prepare(
    `UPDATE branding
        SET app_name = ?, tagline = ?, logo_data_url = ?, favicon_data_url = ?,
            nav_labels = ?, colors = ?,
            updated_at = datetime('now'), updated_by = ?
      WHERE id = 1`,
  ).run(
    next.app_name, next.tagline, next.logo_data_url, next.favicon_data_url,
    JSON.stringify(next.nav_labels), JSON.stringify(next.colors),
    req.user.id,
  );

  res.json({ branding: readBrandingRow() });
});

// ---------- Pages (Phase 2 page builder) ----------
// Custom content pages addressed by slug at /p/<slug>. Admin-only CRUD.
// Reads of published pages are public so the same URL works for signed-out
// visitors. Admins can read drafts via the standard Bearer token.
//
// Block schema is intentionally permissive on the server — we store the
// JSON verbatim and let the renderer whitelist the block types it knows.
// This means new block types can ship as a pure frontend change.
const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const blockSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.string().min(1).max(40),
  props: z.record(z.string(), z.unknown()).default({}),
});
const pageWriteSchema = z.object({
  slug: z.string().trim().min(1).max(60).regex(PAGE_SLUG_RE, "Slug must be lowercase letters, digits or hyphens"),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional().or(z.literal("")).transform((v) => v || null),
  blocks: z.array(blockSchema).max(100).default([]),
  published: z.boolean().optional().default(false),
  show_in_nav: z.boolean().optional().default(false),
});

function rowToPage(row) {
  if (!row) return null;
  let blocks = [];
  try { blocks = JSON.parse(row.blocks || "[]"); } catch { blocks = []; }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    blocks,
    published: !!row.published,
    show_in_nav: !!row.show_in_nav,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function bearerIsAdmin(req) {
  const auth = req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    const u = db.prepare("SELECT role FROM users WHERE id = ?").get(payload.id);
    return u?.role === "admin";
  } catch { return false; }
}

// Public list — only published pages flagged show_in_nav. Used by the top nav.
app.get("/api/pages/nav", (_req, res) => {
  const rows = db.prepare(
    `SELECT id, slug, title FROM pages
      WHERE published = 1 AND show_in_nav = 1
      ORDER BY title ASC`,
  ).all();
  res.json({ pages: rows });
});

// Public read by slug. Drafts are 404 unless the caller is an admin.
app.get("/api/pages/by-slug/:slug", (req, res) => {
  const row = db.prepare("SELECT * FROM pages WHERE slug = ?").get(req.params.slug);
  if (!row) return res.status(404).json({ error: "Not found" });
  const page = rowToPage(row);
  if (!page.published && !bearerIsAdmin(req)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ page });
});

// Admin list — all pages, published or draft.
app.get("/api/pages", requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT * FROM pages ORDER BY updated_at DESC").all();
  res.json({ pages: rows.map(rowToPage) });
});

app.get("/api/pages/:id", requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM pages WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ page: rowToPage(row) });
});

app.post("/api/pages", requireAuth, requireAdmin, (req, res) => {
  const parsed = pageWriteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  }
  const d = parsed.data;
  const existing = db.prepare("SELECT id FROM pages WHERE slug = ?").get(d.slug);
  if (existing) return res.status(409).json({ error: "Slug already in use" });
  const result = db.prepare(
    `INSERT INTO pages (slug, title, description, blocks, published, show_in_nav, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.slug, d.title, d.description, JSON.stringify(d.blocks),
    d.published ? 1 : 0, d.show_in_nav ? 1 : 0,
    req.user.id, req.user.id,
  );
  const row = db.prepare("SELECT * FROM pages WHERE id = ?").get(result.lastInsertRowid);
  res.json({ page: rowToPage(row) });
});

app.put("/api/pages/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM pages WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const parsed = pageWriteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  }
  const d = parsed.data;
  const slugClash = db.prepare("SELECT id FROM pages WHERE slug = ? AND id != ?").get(d.slug, id);
  if (slugClash) return res.status(409).json({ error: "Slug already in use" });
  db.prepare(
    `UPDATE pages SET slug = ?, title = ?, description = ?, blocks = ?,
            published = ?, show_in_nav = ?,
            updated_at = datetime('now'), updated_by = ?
      WHERE id = ?`,
  ).run(
    d.slug, d.title, d.description, JSON.stringify(d.blocks),
    d.published ? 1 : 0, d.show_in_nav ? 1 : 0,
    req.user.id, id,
  );
  const row = db.prepare("SELECT * FROM pages WHERE id = ?").get(id);
  res.json({ page: rowToPage(row) });
});

app.delete("/api/pages/:id", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM pages WHERE id = ?").run(Number(req.params.id));
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
          shipping_country: (o.shipping?.country || o.billing?.country || "").toUpperCase(),
          itemCount: o.line_items.reduce((s, li) => s + li.quantity, 0),
          lineCount: o.line_items.length,
          // Compact item summary for the orders list — lets the picker see
          // what postage applies without opening each order.
          items: o.line_items.map((li) => ({
            sku: String(li.sku || ""),
            name: String(li.name || ""),
            quantity: Number(li.quantity) || 0,
          })),
          previous_completed: repeatMap.get(email) ?? null,
        };
      }),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "Upstream error" });
  }
});

// Today's order stats — count + revenue grouped by currency, across every
// site the user owns and including BOTH "processing" and "completed" so the
// dashboard total reflects fully-shipped revenue, not just live backlog.
// Lightweight: only fetches today's orders (date-bounded server-side).
app.get("/api/stats/today", requireAuth, async (req, res) => {
  try {
    const sites = db.prepare(
      "SELECT id FROM sites WHERE user_id = ?",
    ).all(req.user.id);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const afterIso = start.toISOString();

    const revenue = {};
    let count = 0;

    await Promise.all(sites.map(async (s) => {
      const site = loadSiteWithKeys(s.id, req.user.id);
      if (!site) return;
      try {
        const orders = await fetchOrders(site, {
          statuses: ["processing", "completed"],
          after: afterIso,
        });
        for (const o of orders) {
          count++;
          const v = parseFloat(o.total);
          if (!Number.isFinite(v)) continue;
          const code = (o.currency || "GBP").toUpperCase();
          revenue[code] = (revenue[code] || 0) + v;
        }
      } catch {
        /* one site failing should not poison the entire stats payload */
      }
    }));

    res.json({ count, revenue_by_currency: revenue });
  } catch (e) {
    res.status(502).json({ error: e.message || "Stats unavailable" });
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

// Edit a WooCommerce order's shipping and/or billing address from inside the
// app. Pushes the patch straight to WC via the REST API and returns the
// freshly-loaded order so the drawer can re-render with the saved values.
//
// We intentionally accept ONLY address fields here — not totals, line items,
// statuses, etc. — to keep the surface area tight.
const wcAddressSchema = z.object({
  first_name: z.string().trim().max(60).optional(),
  last_name: z.string().trim().max(60).optional(),
  company: z.string().trim().max(100).optional(),
  address_1: z.string().trim().max(200).optional(),
  address_2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postcode: z.string().trim().max(20).optional(),
  // WC stores country as ISO-2 (e.g. "GB", "NL"). Keep it lenient — some
  // legacy stores have full names — but cap length.
  country: z.string().trim().max(60).optional(),
  // billing-only fields. WC ignores them on shipping.
  email: z.string().trim().email().max(254).optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional(),
}).strict();

const orderAddressesSchema = z.object({
  shipping: wcAddressSchema.optional(),
  billing: wcAddressSchema.optional(),
}).refine((v) => v.shipping || v.billing, {
  message: "Provide a shipping and/or billing address.",
});

app.put("/api/sites/:id/orders/:orderId/addresses", requireAuth, async (req, res) => {
  const site = loadSiteWithKeys(Number(req.params.id), req.user.id);
  if (!site) return res.status(404).json({ error: "Not found" });
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const parsed = orderAddressesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const patch = {};
  if (parsed.data.shipping) {
    // WC's shipping address has no email/phone fields — strip them defensively.
    const { email: _e, phone: _p, ...shippingFields } = parsed.data.shipping;
    patch.shipping = shippingFields;
  }
  if (parsed.data.billing) {
    patch.billing = parsed.data.billing;
  }
  try {
    await updateOrder(site, orderId, patch);
    // Re-fetch so the client sees exactly what WC stored (it normalises
    // some fields, e.g. uppercases country codes).
    const [order, notes] = await Promise.all([
      fetchOrderById(site, orderId),
      fetchOrderNotes(site, orderId),
    ]);
    res.json({ order, notes });
  } catch (e) {
    res.status(502).json({ error: e.message || "Failed to update order in WooCommerce" });
  }
});
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

// ---------- Royal Mail (Click & Drop API) ----------
// We authenticate to Royal Mail Click & Drop with a single API key the user
// generates inside their Click & Drop account. Stored AES-GCM encrypted at
// rest in royal_mail_credentials.api_key_enc.
const rmCredsSchema = z.object({
  // Optional on save so the user can update only the sandbox flag without
  // retyping the key. Empty/undefined = "leave unchanged"; "__clear__" =
  // remove the saved key.
  api_key: z.string().trim().min(1).max(500).optional(),
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

// Public-safe view: never returns the encrypted credential blob, only a flag
// indicating whether a key is currently set.
function rmRowToPublic(row) {
  if (!row) {
    return {
      has_api_key: false,
      use_sandbox: false,
      sender_name: null, sender_company: null,
      sender_address_line1: null, sender_address_line2: null,
      sender_city: null, sender_postcode: null,
      sender_country: "GB", sender_phone: null, sender_email: null,
      last_tested_at: null, last_test_ok: null, last_test_message: null,
    };
  }
  return {
    has_api_key: Boolean(row.api_key_enc),
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
// To clear the saved key, send the literal string "__clear__".
app.put("/api/royal-mail/credentials", requireAuth, (req, res) => {
  const parsed = rmCredsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { api_key, use_sandbox } = parsed.data;

  const existing = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);

  const cleanApiKey = api_key && api_key !== "__clear__" ? normalizeRmApiKey(api_key) : api_key;
  const nextApiKeyEnc = cleanApiKey === "__clear__"
    ? null
    : (cleanApiKey ? encrypt(cleanApiKey) : (existing?.api_key_enc ?? null));

  if (existing) {
    db.prepare(`
      UPDATE royal_mail_credentials
      SET api_key_enc = ?, use_sandbox = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(nextApiKeyEnc, use_sandbox ? 1 : 0, req.user.id);
  } else {
    db.prepare(`
      INSERT INTO royal_mail_credentials (user_id, api_key_enc, use_sandbox)
      VALUES (?, ?, ?)
    `).run(req.user.id, nextApiKeyEnc, use_sandbox ? 1 : 0);
  }

  // Click & Drop has no token cache, but keep the call so the helper can grow
  // a cache later without touching this route.
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

// Test connection — pulls the saved API key, calls Royal Mail Click & Drop's
// /version endpoint, persists the outcome so the dashboard chip shows the
// latest status.
app.post("/api/royal-mail/test-connection", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(req.user.id);
  if (!row || !row.api_key_enc) {
    return res.status(400).json({ ok: false, error: "Add your Click & Drop API key first." });
  }
  let apiKey;
  try {
    apiKey = decrypt(row.api_key_enc);
  } catch {
    return res.status(500).json({ ok: false, error: "Stored API key could not be decrypted." });
  }
  const result = await testRmConnection({
    apiKey,
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

// ---------- Packeta (REST/XML API) ----------
// Phase 1: connect + sender address only. The API password is stored
// AES-GCM encrypted at rest in packeta_credentials.api_password_enc.
const packetaCredsSchema = z.object({
  api_password: z.string().trim().min(1).max(500).optional(),
  // Separate Widget API key (~16 chars). Required for the public carrier
  // and PUDO JSON feeds at pickup-point.api.packeta.com. Send "__clear__"
  // to remove. Empty/missing => leave existing alone.
  widget_api_key: z.string().trim().min(1).max(500).optional(),
  use_sandbox: z.boolean().optional().default(false),
});
const packetaSenderSchema = z.object({
  sender_name: optAddrField(100),
  sender_company: optAddrField(100),
  // The Packeta-assigned eshop / sender ID. REQUIRED by Packeta's createPacket
  // call as the `senderLabel` field. The user copies this from their Packeta
  // client section under Settings → Senders (e.g. "myshop", "eshop123").
  sender_label: optAddrField(60),
  sender_address_line1: optAddrField(150),
  sender_address_line2: optAddrField(150),
  sender_city: optAddrField(80),
  sender_postcode: optAddrField(20),
  sender_country: z.string().trim().min(2).max(3).optional().default("CZ"),
  sender_phone: optAddrField(40),
  sender_email: z.string().trim().email().max(200).optional().or(z.literal("")).transform((v) => v || null),
});

// Public-safe view: never returns the encrypted credential blob.
function packetaRowToPublic(row) {
  if (!row) {
    return {
      has_api_password: false,
      has_widget_api_key: false,
      use_sandbox: false,
      sender_name: null, sender_company: null, sender_label: null,
      sender_address_line1: null, sender_address_line2: null,
      sender_city: null, sender_postcode: null,
      sender_country: "CZ", sender_phone: null, sender_email: null,
      last_tested_at: null, last_test_ok: null, last_test_message: null,
    };
  }
  return {
    has_api_password: Boolean(row.api_password_enc),
    has_widget_api_key: Boolean(row.widget_api_key_enc),
    use_sandbox: Boolean(row.use_sandbox),
    sender_name: row.sender_name,
    sender_company: row.sender_company,
    sender_label: row.sender_label,
    sender_address_line1: row.sender_address_line1,
    sender_address_line2: row.sender_address_line2,
    sender_city: row.sender_city,
    sender_postcode: row.sender_postcode,
    sender_country: row.sender_country || "CZ",
    sender_phone: row.sender_phone,
    sender_email: row.sender_email,
    last_tested_at: row.last_tested_at,
    last_test_ok: row.last_test_ok === null ? null : Boolean(row.last_test_ok),
    last_test_message: row.last_test_message,
  };
}

app.get("/api/packeta/settings", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ settings: packetaRowToPublic(row) });
});

// Update credentials only. Empty/missing field => leave existing alone.
// Send the literal string "__clear__" to remove the saved password.
app.put("/api/packeta/credentials", requireAuth, (req, res) => {
  const parsed = packetaCredsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { api_password, widget_api_key, use_sandbox } = parsed.data;
  const existing = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);

  // SOAP API password — same merge rules as before.
  const cleanPassword = api_password && api_password !== "__clear__"
    ? normalizePacketaPassword(api_password)
    : api_password;
  const nextPasswordEnc = cleanPassword === "__clear__"
    ? null
    : (cleanPassword ? encrypt(cleanPassword) : (existing?.api_password_enc ?? null));

  // Widget API key — same merge rules. Reuses normalizePacketaPassword which
  // just strips whitespace/zero-width/quote chars, so it's safe for either.
  const cleanWidget = widget_api_key && widget_api_key !== "__clear__"
    ? normalizePacketaPassword(widget_api_key)
    : widget_api_key;
  const nextWidgetEnc = cleanWidget === "__clear__"
    ? null
    : (cleanWidget ? encrypt(cleanWidget) : (existing?.widget_api_key_enc ?? null));

  if (existing) {
    db.prepare(`
      UPDATE packeta_credentials
      SET api_password_enc = ?, widget_api_key_enc = ?, use_sandbox = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(nextPasswordEnc, nextWidgetEnc, use_sandbox ? 1 : 0, req.user.id);
  } else {
    db.prepare(`
      INSERT INTO packeta_credentials (user_id, api_password_enc, widget_api_key_enc, use_sandbox)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, nextPasswordEnc, nextWidgetEnc, use_sandbox ? 1 : 0);
  }

  const row = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ settings: packetaRowToPublic(row) });
});

app.put("/api/packeta/sender", requireAuth, (req, res) => {
  const parsed = packetaSenderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const existing = db.prepare("SELECT user_id FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  if (existing) {
    db.prepare(`
      UPDATE packeta_credentials
      SET sender_name = ?, sender_company = ?, sender_label = ?,
          sender_address_line1 = ?, sender_address_line2 = ?,
          sender_city = ?, sender_postcode = ?, sender_country = ?, sender_phone = ?, sender_email = ?,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).run(
      d.sender_name, d.sender_company, d.sender_label,
      d.sender_address_line1, d.sender_address_line2,
      d.sender_city, d.sender_postcode, d.sender_country || "CZ", d.sender_phone, d.sender_email,
      req.user.id,
    );
  } else {
    db.prepare(`
      INSERT INTO packeta_credentials (
        user_id, sender_name, sender_company, sender_label,
        sender_address_line1, sender_address_line2,
        sender_city, sender_postcode, sender_country, sender_phone, sender_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      d.sender_name, d.sender_company, d.sender_label,
      d.sender_address_line1, d.sender_address_line2,
      d.sender_city, d.sender_postcode, d.sender_country || "CZ", d.sender_phone, d.sender_email,
    );
  }
  const row = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ settings: packetaRowToPublic(row) });
});

// Test connection — pulls the saved password, calls Packeta, persists the
// outcome so the dashboard chip shows the latest status. Never echoes the
// password back.
app.post("/api/packeta/test-connection", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  if (!row || !row.api_password_enc) {
    return res.status(400).json({ ok: false, error: "Add your Packeta API password first." });
  }
  let apiPassword;
  try {
    apiPassword = decrypt(row.api_password_enc);
  } catch {
    return res.status(500).json({ ok: false, error: "Stored API password could not be decrypted." });
  }
  const result = await testPacketaConnection({
    apiPassword,
    useSandbox: Boolean(row.use_sandbox),
  });
  db.prepare(`
    UPDATE packeta_credentials
    SET last_tested_at = datetime('now'), last_test_ok = ?, last_test_message = ?
    WHERE user_id = ?
  `).run(result.ok ? 1 : 0, result.message || null, req.user.id);

  const updated = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  res.json({ ...result, settings: packetaRowToPublic(updated) });
});

// Verify a sender label (eshop ID) against Packeta's API. Packeta does not
// expose a "list senders" endpoint — we probe the user-supplied label via
// `senderGetReturnRouting` and surface whether it's registered.
app.post("/api/packeta/verify-sender", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT * FROM packeta_credentials WHERE user_id = ?").get(req.user.id);
  if (!row || !row.api_password_enc) {
    return res.status(400).json({ ok: false, error: "Add your Packeta API password first." });
  }
  const senderLabel = String(req.body?.sender_label || row.sender_label || "").trim();
  if (!senderLabel) {
    return res.status(400).json({ ok: false, error: "Sender ID is required." });
  }
  let apiPassword;
  try {
    apiPassword = decrypt(row.api_password_enc);
  } catch {
    return res.status(500).json({ ok: false, error: "Stored API password could not be decrypted." });
  }
  const result = await verifyPacketaSender({
    apiPassword,
    useSandbox: Boolean(row.use_sandbox),
    senderLabel,
  });
  res.json(result);
});

// ---------- Packeta carrier catalog (Phase 2) ----------
// Helper: load decrypted password for the user, or null. Used by every route
// that hits Packeta on the user's behalf.
function loadPacketaPassword(userId) {
  const row = db.prepare(
    "SELECT * FROM packeta_credentials WHERE user_id = ?",
  ).get(userId);
  if (!row || !row.api_password_enc) return null;
  try {
    let widgetApiKey = null;
    if (row.widget_api_key_enc) {
      try { widgetApiKey = decrypt(row.widget_api_key_enc); } catch { /* ignore */ }
    }
    return {
      row,
      apiPassword: decrypt(row.api_password_enc),
      widgetApiKey,
      useSandbox: Boolean(row.use_sandbox),
    };
  } catch {
    return null;
  }
}

// Fire-and-forget background sync. Triggered when the catalog is stale and
// the UI requests carriers. Never rejects. Skips silently if the user
// hasn't saved a Widget API key yet (the carriers feed requires it).
async function maybeBackgroundSyncCarriers(userId) {
  if (!isCatalogStale()) return;
  const creds = loadPacketaPassword(userId);
  if (!creds || !creds.widgetApiKey) return;
  try {
    await syncPacketaCarriers(creds.widgetApiKey);
  } catch (e) {
    console.warn("[packeta] background carrier sync failed:", e.message);
  }
}

// List carriers from the catalog. Optionally filter by ?country=XX. Kicks
// off a background refresh if the catalog is stale (>24h).
app.get("/api/packeta/carriers", requireAuth, async (req, res) => {
  const country = String(req.query.country || "").toUpperCase().slice(0, 2);
  // Don't await — the user gets the cached list immediately, the next call
  // will pick up the refreshed data.
  void maybeBackgroundSyncCarriers(req.user.id);

  const rows = country
    ? db.prepare(
        `SELECT * FROM packeta_carriers WHERE country = ? ORDER BY name COLLATE NOCASE`,
      ).all(country)
    : db.prepare(
        `SELECT * FROM packeta_carriers ORDER BY country, name COLLATE NOCASE`,
      ).all();

  res.json({
    carriers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      currency: r.currency,
      is_pickup_points: Boolean(r.is_pickup_points),
      supports_cod: Boolean(r.supports_cod),
      supports_age_verification: Boolean(r.supports_age_verification),
      max_weight_kg: r.max_weight_kg,
      disallows_cod: Boolean(r.disallows_cod),
    })),
    last_synced_at: getCatalogLastSyncedAt(),
    stale: isCatalogStale(),
  });
});

// Manual "Refresh now" trigger from the /packeta page.
app.post("/api/packeta/carriers/sync", requireAuth, async (req, res) => {
  const creds = loadPacketaPassword(req.user.id);
  if (!creds) return res.status(400).json({ error: "Add your Packeta API password first." });
  if (!creds.widgetApiKey) {
    return res.status(400).json({
      error:
        "Add your Packeta Widget API key first. " +
        "It's a separate credential from the SOAP API password — " +
        "find it in the Packeta client section under Settings → API.",
    });
  }
  const result = await syncPacketaCarriers(creds.widgetApiKey);
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

// ---------- Packeta country routing (Phase 2) ----------
const packetaRouteSchema = z.object({
  country: z.string().trim().min(2).max(2)
    .transform((v) => v.toUpperCase()),
  carrier_id: z.number().int().positive(),
  default_weight_kg: z.number().positive().max(50).default(0.5),
  default_value: z.number().min(0).max(1_000_000).default(0),
  sort_order: z.number().int().min(0).max(1000).optional().default(0),
});

function packetaRouteToPublic(row) {
  return {
    id: row.id,
    country: row.country,
    carrier_id: row.carrier_id,
    default_weight_kg: row.default_weight_kg,
    default_value: row.default_value,
    sort_order: row.sort_order,
    updated_at: row.updated_at,
  };
}

app.get("/api/packeta/country-routes", requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, c.name AS carrier_name, c.is_pickup_points
     FROM packeta_country_routes r
     LEFT JOIN packeta_carriers c
       ON c.id = r.carrier_id AND c.country = r.country
     WHERE r.user_id = ?
     ORDER BY r.sort_order, r.country`,
  ).all(req.user.id);
  res.json({
    routes: rows.map((r) => ({
      ...packetaRouteToPublic(r),
      carrier_name: r.carrier_name || null,
      is_pickup_points: r.is_pickup_points === null ? null : Boolean(r.is_pickup_points),
    })),
  });
});

app.post("/api/packeta/country-routes", requireAuth, (req, res) => {
  const parsed = packetaRouteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  // Validate the carrier exists in the catalog for this country.
  const carrier = db.prepare(
    "SELECT id FROM packeta_carriers WHERE id = ? AND country = ?",
  ).get(d.carrier_id, d.country);
  if (!carrier) {
    return res.status(400).json({
      error: `Carrier ${d.carrier_id} is not available for ${d.country}. Refresh the carrier list first.`,
    });
  }
  try {
    const result = db.prepare(`
      INSERT INTO packeta_country_routes (
        user_id, country, carrier_id, default_weight_kg, default_value, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, d.country, d.carrier_id, d.default_weight_kg, d.default_value, d.sort_order);
    const row = db.prepare(
      "SELECT * FROM packeta_country_routes WHERE id = ?",
    ).get(result.lastInsertRowid);
    res.json({ route: packetaRouteToPublic(row) });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      return res.status(409).json({
        error: `${d.country} already has a route for this carrier — edit it instead.`,
      });
    }
    throw e;
  }
});

app.put("/api/packeta/country-routes/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(
    "SELECT * FROM packeta_country_routes WHERE id = ? AND user_id = ?",
  ).get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: "Route not found" });

  const parsed = packetaRouteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const carrier = db.prepare(
    "SELECT id FROM packeta_carriers WHERE id = ? AND country = ?",
  ).get(d.carrier_id, d.country);
  if (!carrier) {
    return res.status(400).json({
      error: `Carrier ${d.carrier_id} is not available for ${d.country}.`,
    });
  }
  db.prepare(`
    UPDATE packeta_country_routes
    SET country = ?, carrier_id = ?, default_weight_kg = ?, default_value = ?,
        sort_order = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(d.country, d.carrier_id, d.default_weight_kg, d.default_value, d.sort_order, id, req.user.id);
  const row = db.prepare("SELECT * FROM packeta_country_routes WHERE id = ?").get(id);
  res.json({ route: packetaRouteToPublic(row) });
});

app.delete("/api/packeta/country-routes/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare(
    "DELETE FROM packeta_country_routes WHERE id = ? AND user_id = ?",
  ).run(id, req.user.id);
  if (r.changes === 0) return res.status(404).json({ error: "Route not found" });
  res.json({ ok: true });
});

// ---------- Packeta per-order labels (Phase 2) ----------
// Build the createPacket payload for a single Woo order. The caller resolves
// `addressId`, `isPickup`, `weight`, and `value` upfront so this function
// stays a pure XML-payload builder.
function buildPacketaPacketAttrs({ order, sender, addressId, weight, value }) {
  const ship = (order.shipping && (order.shipping.address_1 || order.shipping.first_name))
    ? order.shipping
    : (order.billing || {});
  const billing = order.billing || {};

  // Packeta requires `eshop` to be the sender ID (a.k.a. "senderLabel") that
  // the user has registered in their Packeta client section. It is NOT a
  // free-text company name — passing the wrong value yields:
  //   "eshop_id: ...: Sender is not given. Please choose a sender."
  // We use the dedicated sender_label column. Without it we cannot continue.
  const eshopId = String(sender.sender_label || "").trim();

  const attrs = {
    number: String(order.number || order.id),
    name: String(ship.first_name || billing.first_name || "").slice(0, 32),
    surname: String(ship.last_name || billing.last_name || "").slice(0, 32),
    email: String(billing.email || ship.email || sender.sender_email || "").slice(0, 255),
    phone: String(billing.phone || ship.phone || "").slice(0, 30),
    addressId,
    company: String(ship.company || "").slice(0, 60),
    street: String(ship.address_1 || "").slice(0, 60),
    houseNumber: "",
    city: String(ship.city || "").slice(0, 50),
    zip: String(ship.postcode || "").replace(/\s+/g, ""),
    currency: String(order.currency || sender.currency || "CZK").toUpperCase(),
    cod: 0,
    value,
    weight,
    eshop: eshopId,
  };

  return attrs;
}

// Resolve which Packeta carrier (addressId) and whether it's a pickup-point
// carrier, for a given WC order. Strategy:
//
//   1. Trust the WC Packeta plugin first. If the order carries
//      `packetery_carrier_id` meta, use it — that's exactly what the customer
//      picked at checkout. We look it up in our local catalog only to learn
//      whether it's a pickup-point carrier; if missing from the catalog we
//      fall back to "is pickup if the order has a pickup point ID".
//      The literal value "zpoint" / "packeta" means the generic Packeta
//      pickup-point service — those always require a pickup point ID, and
//      the addressId we send to createPacket is the pickup point ID itself.
//   2. Otherwise, fall back to the country-routing table the user configured
//      in HeyShop. (Useful for sites that don't have the WC plugin installed
//      or for orders pre-dating the plugin.)
//
// Returns { ok: true, addressId, isPickup, source } on success, or
// { ok: false, status, error } on failure.
function resolvePacketaCarrierForOrder({ userId, order, country, pickupPointId }) {
  const fromPlugin = pickPacketaCarrierId(order);
  if (fromPlugin) {
    const lower = fromPlugin.toLowerCase();
    // Generic Packeta pickup-point pseudo-carrier — addressId IS the pickup
    // point ID, not the carrier ID.
    if (lower === "zpoint" || lower === "packeta") {
      if (!pickupPointId) {
        return {
          ok: false,
          status: 400,
          error:
            `Order ${order.number} uses a Packeta pickup point but no pickup point ID is on the order. ` +
            `Customers normally pick this at checkout via the Packeta WooCommerce plugin.`,
        };
      }
      return { ok: true, addressId: pickupPointId, isPickup: true, source: "wc-plugin" };
    }

    // Specific carrier — look up in catalog to learn pickup-vs-home, fall
    // back to "pickup if the order has a point ID" if the catalog is empty.
    const carrier = db.prepare(
      `SELECT id, is_pickup_points FROM packeta_carriers
       WHERE id = ? AND country = ?`,
    ).get(fromPlugin, country);
    const isPickup = carrier
      ? Boolean(carrier.is_pickup_points)
      : Boolean(pickupPointId);
    if (isPickup && !pickupPointId) {
      return {
        ok: false,
        status: 400,
        error:
          `Order ${order.number} ships to a pickup-point carrier but no pickup point ID was found on the order.`,
      };
    }
    return {
      ok: true,
      addressId: isPickup ? pickupPointId : fromPlugin,
      isPickup,
      source: "wc-plugin",
    };
  }

  // Fallback: user-configured country routing in HeyShop. A country can have
  // multiple routes (Home delivery + Pickup point) — pick based on whether
  // the order has a pickup point ID.
  const candidates = db.prepare(
    `SELECT r.*, c.is_pickup_points
     FROM packeta_country_routes r
     LEFT JOIN packeta_carriers c
       ON c.id = r.carrier_id AND c.country = r.country
     WHERE r.user_id = ? AND r.country = ?
     ORDER BY r.sort_order, r.id`,
  ).all(userId, country);
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        `Order ${order.number} has no Packeta carrier on the WooCommerce order ` +
        `(packetery_carrier_id meta) and no fallback route is configured for ${country}. ` +
        `Either install the Packeta WC plugin so the carrier is saved on each order, or ` +
        `add a fallback route on the Packeta page.`,
    };
  }
  const route =
    (pickupPointId
      ? candidates.find((r) => Boolean(r.is_pickup_points))
      : candidates.find((r) => !r.is_pickup_points)) || candidates[0];
  const isPickup = Boolean(route.is_pickup_points);
  if (isPickup && !pickupPointId) {
    return {
      ok: false,
      status: 400,
      error:
        `Order ${order.number} ships to a pickup-point carrier but no pickup point ID was found on the order.`,
    };
  }
  return {
    ok: true,
    addressId: isPickup ? pickupPointId : route.carrier_id,
    isPickup,
    source: "country-route",
    route, // exposed so the caller can pick up default_weight/default_value
  };
}

// Core single-label creator. Returns { status, body } so it can be used by
// the per-order route AND the bulk endpoint without duplicating logic.
async function createPacketaLabelForOrder({ userId, siteId, orderId, creds, sender }) {
  const site = loadSiteWithKeys(siteId, userId);
  if (!site) return { status: 404, body: { error: "Site not found" } };

  // Reuse cached label if one exists.
  const existing = db.prepare(`
    SELECT * FROM shipments
    WHERE user_id = ? AND site_id = ? AND woocommerce_order_id = ?
      AND carrier = 'packeta' AND voided = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, siteId, orderId);
  if (existing && existing.label_pdf_base64) {
    return {
      status: 200,
      body: { shipment: rmShipmentToPublic(existing), reused: true },
    };
  }

  let order;
  try {
    order = await fetchOrderById(site, orderId);
  } catch (e) {
    return { status: 502, body: { error: `Could not load order from WooCommerce: ${e.message}` } };
  }
  if (!order) return { status: 404, body: { error: "Order not found in WooCommerce" } };

  const country = String(order.shipping?.country || order.billing?.country || "")
    .toUpperCase()
    .slice(0, 2);
  if (!country) {
    return { status: 400, body: { error: "Order has no destination country." } };
  }

  const orderPickupPointId = pickPacketaPickupPointId(order);
  const resolved = resolvePacketaCarrierForOrder({
    userId,
    order,
    country,
    pickupPointId: orderPickupPointId,
  });
  if (!resolved.ok) {
    return { status: resolved.status, body: { error: resolved.error } };
  }

  if (!sender || !String(sender.sender_label || "").trim()) {
    return {
      status: 400,
      body: {
        error:
          "Packeta sender ID is missing. Open the Packeta integration page and " +
          "fill in the \"Sender ID (eshop)\" field — copy it from your Packeta " +
          "client section under Settings → Senders.",
      },
    };
  }

  // Weight: prefer the WC Packeta plugin's `packetery_weight` meta, then
  // any country-route default, then a 0.5 kg safety floor.
  const pluginWeight = pickPacketaWeightKg(order);
  const routeWeight = resolved.route?.default_weight_kg;
  const weight =
    pluginWeight && pluginWeight > 0 ? pluginWeight :
    routeWeight && routeWeight > 0 ? routeWeight : 0.5;

  // Value: order total wins, fall back to country-route default, then 0.
  const value = Number(order.total) || resolved.route?.default_value || 0;

  const packet = buildPacketaPacketAttrs({
    order,
    sender,
    addressId: resolved.addressId,
    weight,
    value,
  });

  const created = await createPacketaPacket({
    apiPassword: creds.apiPassword,
    useSandbox: creds.useSandbox,
    packet,
  });
  if (!created.ok) {
    return { status: 422, body: { error: created.error || "Packeta rejected the packet.", detail: created.detail } };
  }

  // Try to fetch the OFFICIAL CARRIER label first (DHL / bpost / DPD / PPL /
  // ...) — this is the label the Packeta admin UI prints for routed packets.
  // If Packeta hasn't yet routed the packet to a carrier (common for pickup
  // points or right after creation), fall back to the generic Packeta label.
  let labelBuffer = null;
  let labelKind = "packeta"; // "courier" if we got the carrier's official label
  let courierTrackingNumber = null;
  let labelWarning = null;

  const courierNum = await getPacketaCourierNumber({
    apiPassword: creds.apiPassword,
    useSandbox: creds.useSandbox,
    packetId: created.packetId,
  });
  if (courierNum.ok && courierNum.courierNumber) {
    courierTrackingNumber = courierNum.courierNumber;
    const courierLabel = await getPacketaCourierLabelPdf({
      apiPassword: creds.apiPassword,
      useSandbox: creds.useSandbox,
      packetId: created.packetId,
      courierNumber: courierNum.courierNumber,
      format: "A6 on A6",
    });
    if (courierLabel.ok && courierLabel.buffer) {
      labelBuffer = courierLabel.buffer;
      labelKind = "courier";
    } else {
      labelWarning = courierLabel.error || null;
    }
  }
  if (!labelBuffer) {
    const label = await getPacketaLabelPdf({
      apiPassword: creds.apiPassword,
      useSandbox: creds.useSandbox,
      packetId: created.packetId,
      format: "A6 on A6",
    });
    if (label.ok && label.buffer) {
      labelBuffer = label.buffer;
    } else {
      labelWarning = labelWarning || label.error || "Label PDF could not be fetched yet.";
    }
  }
  const labelBase64 = labelBuffer ? labelBuffer.toString("base64") : null;
  const trackingForCustomer = courierTrackingNumber || created.barcode || created.barcodeText || null;

  const insert = db.prepare(`
    INSERT INTO shipments (
      user_id, site_id, woocommerce_order_id, woocommerce_store_url,
      tracking_number, service_code, label_pdf_base64,
      carrier, packeta_packet_id, packeta_barcode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'packeta', ?, ?)
  `).run(
    userId, siteId, orderId, site.store_url,
    trackingForCustomer,
    `PACKETA:${resolved.route?.carrier_id ?? resolved.addressId ?? "wc-plugin"}${labelKind === "courier" ? ":COURIER" : ""}`,
    labelBase64,
    created.packetId,
    created.barcode || null,
  );

  // Notify the customer with the tracking number (customer_note=true emails them)
  // and best-effort mark the order as completed in WooCommerce.
  if (trackingForCustomer) {
    const trackingLine = courierTrackingNumber
      ? `Packeta label created. Carrier tracking: ${courierTrackingNumber}` +
        (created.barcode ? ` (Packeta: ${created.barcode})` : "")
      : `Packeta label created. Tracking: ${created.barcode}`;
    try {
      await addOrderNote(site, orderId, trackingLine, true);
    } catch (e) {
      console.warn(`[packeta] WC customer note failed for order ${orderId}: ${e.message}`);
    }
  }
  try {
    await updateOrder(site, orderId, { status: "completed" });
  } catch (e) {
    console.warn(`[packeta] WC complete failed for order ${orderId}: ${e.message}`);
  }

  const saved = db.prepare("SELECT * FROM shipments WHERE id = ?").get(insert.lastInsertRowid);
  return {
    status: 200,
    body: {
      shipment: rmShipmentToPublic(saved),
      packet_id: created.packetId,
      barcode: created.barcode || null,
      courier_number: courierTrackingNumber,
      label_kind: labelKind,
      label_warning: labelBuffer ? null : labelWarning,
    },
  };
}

app.post("/api/packeta/orders/:siteId/:orderId/label", requireAuth, async (req, res) => {
  const siteId = Number(req.params.siteId);
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(siteId) || !Number.isInteger(orderId)) {
    return res.status(400).json({ error: "Invalid site/order ID" });
  }
  const creds = loadPacketaPassword(req.user.id);
  if (!creds) return res.status(400).json({ error: "Add your Packeta API password first." });
  const sender = creds.row;
  if (!sender.sender_address_line1 || !sender.sender_city || !sender.sender_postcode) {
    return res.status(400).json({ error: "Add a sender address on the Packeta page first." });
  }
  const result = await createPacketaLabelForOrder({
    userId: req.user.id, siteId, orderId, creds, sender,
  });
  res.status(result.status).json(result.body);
});

// Bulk: create labels and return a single merged PDF. Skips orders that
// can't be labelled and reports them via X-Packeta-Skipped header.
app.post("/api/packeta/orders/bulk-labels", requireAuth, async (req, res) => {
  const Schema = z.object({
    selections: z.array(z.object({
      site_id: z.number().int().positive(),
      order_ids: z.array(z.number().int().positive()).min(1).max(200),
    })).min(1).max(10),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const creds = loadPacketaPassword(req.user.id);
  if (!creds) return res.status(400).json({ error: "Add your Packeta API password first." });
  const sender = creds.row;
  if (!sender.sender_address_line1 || !sender.sender_city || !sender.sender_postcode) {
    return res.status(400).json({ error: "Add a sender address on the Packeta page first." });
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;
  for (const sel of parsed.data.selections) {
    for (const orderId of sel.order_ids) {
      const r = await createPacketaLabelForOrder({
        userId: req.user.id,
        siteId: sel.site_id,
        orderId,
        creds,
        sender,
      });
      if (r.status === 200 && r.body.shipment) {
        results.push({
          site_id: sel.site_id,
          order_id: orderId,
          ok: true,
          shipment: r.body.shipment,
        });
        succeeded++;
      } else {
        results.push({
          site_id: sel.site_id,
          order_id: orderId,
          ok: false,
          error: r.body?.error || `Failed (${r.status})`,
        });
        failed++;
      }
    }
  }

  res.json({ succeeded, failed, results });
});

// Stream a saved Packeta label PDF (for "Reprint").
app.get("/api/packeta/shipments/:id/label.pdf", requireAuth, (req, res) => {
  const row = db.prepare(
    `SELECT label_pdf_base64, tracking_number FROM shipments
     WHERE id = ? AND user_id = ? AND carrier = 'packeta'`,
  ).get(Number(req.params.id), req.user.id);
  if (!row || !row.label_pdf_base64) return res.status(404).json({ error: "Label not found" });
  const buf = Buffer.from(row.label_pdf_base64, "base64");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="packeta-${row.tracking_number || "label"}.pdf"`,
  );
  res.send(buf);
});

// Bulk merged-PDF download for already-created Packeta shipments. Used by
// the orders bulk-print flow after createPacketaLabelForOrder returns.
app.get("/api/packeta/shipments/bulk/labels.pdf", requireAuth, async (req, res) => {
  const raw = String(req.query.ids || "").trim();
  if (!raw) return res.status(400).json({ error: "ids query param required" });
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.status(400).json({ error: "No valid shipment IDs" });
  if (ids.length > 200) return res.status(400).json({ error: "Too many shipments (max 200)" });

  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, label_pdf_base64, packeta_packet_id FROM shipments
     WHERE user_id = ? AND carrier = 'packeta' AND id IN (${placeholders})`,
  ).all(req.user.id, ...ids);

  if (rows.length === 0) return res.status(404).json({ error: "No shipments found" });

  // Try Packeta's native multi-label PDF first (better tiling, single billing
  // event). Fall back to merging cached PDFs if any packet isn't accepted.
  const creds = loadPacketaPassword(req.user.id);
  const packetIds = rows.map((r) => r.packeta_packet_id).filter(Boolean);
  if (creds && packetIds.length === rows.length) {
    const merged = await getPacketaLabelsPdf({
      apiPassword: creds.apiPassword,
      useSandbox: creds.useSandbox,
      packetIds,
      format: "A6 on A6",
    });
    if (merged.ok) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(merged.buffer.length));
      res.setHeader(
        "Content-Disposition",
        `inline; filename="packeta-labels-${new Date().toISOString().slice(0, 10)}.pdf"`,
      );
      return res.send(merged.buffer);
    }
  }

  // Fallback: stitch the cached PDFs together with pdf-lib.
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (const r of rows) {
    if (!r.label_pdf_base64) continue;
    try {
      const src = await PDFDocument.load(Buffer.from(r.label_pdf_base64, "base64"));
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) doc.addPage(p);
    } catch { /* skip broken page */ }
  }
  if (doc.getPageCount() === 0) {
    return res.status(422).json({ error: "No printable Packeta labels found." });
  }
  const bytes = await doc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="packeta-labels-${new Date().toISOString().slice(0, 10)}.pdf"`,
  );
  res.send(Buffer.from(bytes));
});

// Lookup the Packeta shipment for a given Woo order — used by the order
// drawer to render "Label created" vs "Create label".
app.get("/api/packeta/shipments/by-order/:siteId/:orderId", requireAuth, (req, res) => {
  const siteId = Number(req.params.siteId);
  const orderId = Number(req.params.orderId);
  const row = db.prepare(`
    SELECT * FROM shipments
    WHERE user_id = ? AND site_id = ? AND woocommerce_order_id = ?
      AND carrier = 'packeta' AND voided = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(req.user.id, siteId, orderId);
  res.json({ shipment: row ? rmShipmentToPublic(row) : null });
});

// ---------- Royal Mail shipments / labels (Click & Drop) ----------
// Click & Drop accepts many service codes and the valid set depends on the
// customer's account (OBA contracts vs OLP "pay as you go", returns, etc.).
// serviceCode is optional in the official schema, so we allow blank/"auto" and
// let Click & Drop apply the account's postage rules/defaults when omitted.

const shipmentSchema = z.object({
  site_id: z.number().int().positive(),
  woocommerce_order_id: z.number().int().positive(),
  // Echoed back as the Click & Drop "orderReference".
  customer_reference: z.string().trim().min(1).max(40),
  service_code: z.string().trim().max(10).optional().or(z.literal(""))
    .transform((v) => (v && v.toLowerCase() !== "auto" ? v.toUpperCase() : null)),
  // Click & Drop "packageFormat": parcel | letter | largeLetter | etc.
  // L = Letter, F = Large Letter, P = Parcel (matches Click & Drop UI order).
  service_format: z.enum(["P", "L", "F"]).default("P"),
  weight_grams: z.number().int().min(1).max(30000),
  length_mm: z.number().int().min(0).max(2000).optional(),
  width_mm: z.number().int().min(0).max(2000).optional(),
  height_mm: z.number().int().min(0).max(2000).optional(),
  safe_place: z.string().trim().max(120).optional().or(z.literal("")).transform((v) => v || null),
  description_of_goods: z.string().trim().max(60).default("Goods"),
  // Optional pre-built line items. If omitted, the server fetches them from
  // WooCommerce so the SKU appears on the label.
  line_items: z.array(z.object({
    sku: z.string().trim().max(60).optional().or(z.literal("")).transform((v) => v || ""),
    name: z.string().trim().max(120).optional().or(z.literal("")).transform((v) => v || ""),
    quantity: z.number().int().min(1).max(999).default(1),
  })).max(50).optional(),
  recipient: z.object({
    name: z.string().trim().min(1).max(100),
    company: z.string().trim().max(100).optional().or(z.literal("")).transform((v) => v || null),
    line1: z.string().trim().min(1).max(150),
    line2: z.string().trim().max(150).optional().or(z.literal("")).transform((v) => v || null),
    city: z.string().trim().min(1).max(80),
    county: z.string().trim().max(80).optional().or(z.literal("")).transform((v) => v || null),
    postcode: z.string().trim().min(2).max(20),
    country_code: z.string().trim().length(2).default("GB"),
    phone: z.string().trim().max(40).optional().or(z.literal("")).transform((v) => v || null),
    email: z.string().trim().max(200).optional().or(z.literal("")).transform((v) => v || null),
  }),
});

// Map our internal P/L/F flag to the Click & Drop packageFormat enum.
//   L → letter, F → largeLetter, P → parcel
function cndPackageFormat(serviceFormat) {
  switch (serviceFormat) {
    case "L": return "letter";
    case "F": return "largeLetter";
    case "P":
    default:  return "parcel";
  }
}

// UK postcode validator — used only as a soft client-side guard before we
// hand the data to Royal Mail (their own validator is the authority).
function isValidUkPostcode(pc) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i.test(String(pc || "").trim());
}

function loadRmCreds(userId) {
  const row = db.prepare("SELECT * FROM royal_mail_credentials WHERE user_id = ?").get(userId);
  if (!row || !row.api_key_enc) return null;
  return {
    row,
    apiKey: decrypt(row.api_key_enc),
    useSandbox: Boolean(row.use_sandbox),
  };
}

// Build the Click & Drop `contents[]` for a package from WooCommerce line items.
// Royal Mail prints `quantity x SKU` (or name if no SKU) on the label, so we
// surface the actual product SKUs the user is shipping. Falls back to a single
// generic "Goods" line if there's nothing to show.
function buildCndContents({ lineItems, fallbackName, totalWeightGrams }) {
  const items = Array.isArray(lineItems)
    ? lineItems
        .map((li) => ({
          // Display priority on the label: SKU > name > "Goods".
          name: String(li.sku || li.name || fallbackName || "Goods").slice(0, 60),
          SKU: String(li.sku || "").slice(0, 60),
          quantity: Math.max(1, Math.min(999, Number(li.quantity) || 1)),
          unitValue: 0,
          // Spread weight across units so the package total still matches.
          unitWeightInGrams: 0,
        }))
        .filter((c) => c.name)
    : [];

  if (items.length === 0) {
    return [{
      name: fallbackName || "Goods",
      SKU: "",
      quantity: 1,
      unitValue: 0,
      unitWeightInGrams: totalWeightGrams || 0,
    }];
  }

  // Distribute the parcel weight across the first item — Click & Drop only
  // needs the package weight to match its total, but unitWeightInGrams must
  // sum to something sensible.
  const totalUnits = items.reduce((s, c) => s + c.quantity, 0);
  const perUnit = totalUnits > 0 ? Math.floor((totalWeightGrams || 0) / totalUnits) : 0;
  for (const c of items) c.unitWeightInGrams = perUnit;
  return items;
}

// Fetch the WooCommerce order's line items and reduce them to the small shape
// we ship to Click & Drop. Best-effort — failures return null and the caller
// falls back to the generic "Goods" description.
async function loadOrderLineItemsForLabel(site, orderId) {
  try {
    const order = await fetchOrderById(site, orderId);
    if (!order || !Array.isArray(order.line_items)) return null;
    return order.line_items.map((li) => ({
      sku: String(li.sku || ""),
      name: String(li.name || ""),
      quantity: Math.max(1, Number(li.quantity) || 1),
    }));
  } catch {
    return null;
  }
}

function rmShipmentToPublic(s) {
  return {
    id: s.id,
    woocommerce_order_id: s.woocommerce_order_id,
    woocommerce_store_url: s.woocommerce_store_url,
    royal_mail_shipment_id: s.royal_mail_shipment_id,
    tracking_number: s.tracking_number,
    service_code: s.service_code,
    has_label: Boolean(s.label_pdf_base64),
    manifested: Boolean(s.manifested),
    manifest_id: s.manifest_id,
    voided: Boolean(s.voided),
    printed_at: s.printed_at || null,
    created_at: s.created_at,
    carrier: s.carrier || "royal_mail",
    packeta_packet_id: s.packeta_packet_id || null,
    packeta_barcode: s.packeta_barcode || null,
  };
}

// List shipments for the current user, newest first.
app.get("/api/royal-mail/shipments", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM shipments WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
  `).all(req.user.id);
  res.json({ shipments: rows.map(rmShipmentToPublic) });
});

// Lookup any existing shipment for a given Woo order. Used by the order
// drawer to decide between "Create label" vs "Show existing label".
app.get("/api/royal-mail/shipments/by-order/:siteId/:orderId", requireAuth, (req, res) => {
  const siteId = Number(req.params.siteId);
  const orderId = Number(req.params.orderId);
  const row = db.prepare(`
    SELECT * FROM shipments
    WHERE user_id = ? AND site_id = ? AND woocommerce_order_id = ? AND voided = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(req.user.id, siteId, orderId);
  res.json({ shipment: row ? rmShipmentToPublic(row) : null });
});

// Bulk lookup: shipments for many Woo orders at once. Powers the "Printed"
// badge on the orders list — one round-trip instead of N. Body shape:
//   { selections: [{ site_id, order_ids: [...] }] }
// Response: { shipments: { [`${site_id}:${order_id}`]: RmShipment | null } }
app.post("/api/royal-mail/shipments/by-orders", requireAuth, (req, res) => {
  const Schema = z.object({
    selections: z.array(z.object({
      site_id: z.number().int().positive(),
      order_ids: z.array(z.number().int().positive()).min(1).max(500),
    })).min(1).max(20),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const out = {};
  for (const sel of parsed.data.selections) {
    if (sel.order_ids.length === 0) continue;
    const placeholders = sel.order_ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT * FROM shipments
      WHERE user_id = ? AND site_id = ? AND voided = 0
        AND woocommerce_order_id IN (${placeholders})
      ORDER BY created_at DESC
    `).all(req.user.id, sel.site_id, ...sel.order_ids);
    // Newest row wins per order.
    const seen = new Set();
    for (const r of rows) {
      const key = `${sel.site_id}:${r.woocommerce_order_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[key] = rmShipmentToPublic(r);
    }
  }
  res.json({ shipments: out });
});

// List unprinted (non-voided, has-label, printed_at IS NULL) shipments for
// the current user. Used by the orders toolbar's "Print all unprinted" CTA.
app.get("/api/royal-mail/shipments/unprinted", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM shipments
    WHERE user_id = ?
      AND voided = 0
      AND printed_at IS NULL
      AND label_pdf_base64 IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 500
  `).all(req.user.id);
  res.json({ shipments: rows.map(rmShipmentToPublic) });
});

// Mark a batch of shipments as printed. Side-effects:
//   1. shipments.printed_at = now()
//   2. The associated WooCommerce order is moved to "completed" (best-effort —
//      individual failures are logged and reported back so the user can fix
//      them, but never fail the whole batch).
// Body: { ids: number[] }
// Response: { printed: number, completed: number, completionErrors: [...] }
app.post("/api/royal-mail/shipments/mark-printed", requireAuth, async (req, res) => {
  const Schema = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const { ids } = parsed.data;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, site_id, woocommerce_order_id FROM shipments
     WHERE user_id = ? AND id IN (${placeholders})`
  ).all(req.user.id, ...ids);

  if (rows.length === 0) {
    return res.status(404).json({ error: "No shipments found" });
  }

  const now = new Date().toISOString();
  const update = db.prepare(
    "UPDATE shipments SET printed_at = ? WHERE id = ? AND user_id = ?"
  );
  let printed = 0;
  for (const r of rows) {
    const result = update.run(now, r.id, req.user.id);
    if (result.changes > 0) printed++;
  }

  // Best-effort: mark each WooCommerce order as completed. Group by site to
  // avoid loading credentials more than once.
  const bySite = new Map();
  for (const r of rows) {
    if (!r.site_id || !r.woocommerce_order_id) continue;
    const arr = bySite.get(r.site_id) || [];
    arr.push(r.woocommerce_order_id);
    bySite.set(r.site_id, arr);
  }

  let completed = 0;
  const completionErrors = [];
  for (const [siteId, orderIds] of bySite.entries()) {
    const site = loadSiteWithKeys(siteId, req.user.id);
    if (!site) {
      completionErrors.push({ site_id: siteId, order_ids: orderIds, error: "Site not found" });
      continue;
    }
    for (const orderId of orderIds) {
      try {
        await updateOrder(site, orderId, { status: "completed" });
        completed++;
      } catch (e) {
        completionErrors.push({
          site_id: siteId,
          order_id: orderId,
          error: e.message || "Update failed",
        });
      }
    }
  }

  res.json({ printed, completed, completionErrors });
});

// Stream a saved label PDF.
app.get("/api/royal-mail/shipments/:id/label.pdf", requireAuth, (req, res) => {
  const row = db.prepare(
    "SELECT label_pdf_base64, tracking_number FROM shipments WHERE id = ? AND user_id = ?"
  ).get(Number(req.params.id), req.user.id);
  if (!row || !row.label_pdf_base64) return res.status(404).json({ error: "Label not found" });
  const buf = Buffer.from(row.label_pdf_base64, "base64");
  const looksLikePdf = buf.length > 4 && buf.subarray(0, 4).toString("latin1") === "%PDF";
  if (!looksLikePdf) {
    return res.status(422).json({ error: "Saved Royal Mail label is not a valid PDF. Open Click & Drop to generate/print this label." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="rm-${row.tracking_number || "label"}.pdf"`,
  );
  res.send(buf);
});

// Core: create one Click & Drop shipment for an already-validated payload.
// Returns { status, body } where body is what we'd JSON-respond with. Used by
// both the single-order and bulk endpoints so behaviour stays in lock-step
// (duplicate guard, line-item enrichment, WC note, persistence).
async function createShipmentForUser({ userId, data: input, creds }) {
  const d = { ...input };

  if (d.recipient.country_code === "GB" && !isValidUkPostcode(d.recipient.postcode)) {
    return { status: 400, body: { error: "Recipient UK postcode looks invalid." } };
  }

  const existing = db.prepare(`
    SELECT id, tracking_number FROM shipments
    WHERE user_id = ? AND site_id = ? AND woocommerce_order_id = ? AND voided = 0
  `).get(userId, d.site_id, d.woocommerce_order_id);
  if (existing) {
    return {
      status: 409,
      body: {
        error: "A label already exists for this order. Void it first to create a new one.",
        shipment_id: existing.id,
        tracking_number: existing.tracking_number,
      },
    };
  }

  const site = loadSiteWithKeys(d.site_id, userId);
  if (!site) return { status: 404, body: { error: "Site not found" } };

  const { row: rm, apiKey, useSandbox } = creds;
  if (!rm.sender_address_line1 || !rm.sender_city || !rm.sender_postcode) {
    return { status: 400, body: { error: "Add a sender address under Royal Mail settings first." } };
  }

  // Pull line items from WooCommerce if the client didn't pre-supply them, so
  // the printed label shows real SKUs.
  if (!Array.isArray(d.line_items) || d.line_items.length === 0) {
    const fetched = await loadOrderLineItemsForLabel(site, d.woocommerce_order_id);
    if (fetched && fetched.length > 0) d.line_items = fetched;
  }

  const cndOrder = {
    orderReference: d.customer_reference,
    isRecipientABusiness: false,
    recipient: {
      address: {
        fullName: d.recipient.name,
        companyName: d.recipient.company || "",
        addressLine1: d.recipient.line1,
        addressLine2: d.recipient.line2 || "",
        addressLine3: "",
        city: d.recipient.city,
        county: d.recipient.county || "",
        postcode: d.recipient.postcode,
        countryCode: d.recipient.country_code,
      },
      phoneNumber: d.recipient.phone || "",
      emailAddress: d.recipient.email || "",
    },
    sender: {
      tradingName: rm.sender_company || rm.sender_name || "",
      phoneNumber: rm.sender_phone || "",
      emailAddress: rm.sender_email || "",
      address: {
        fullName: rm.sender_name || "",
        companyName: rm.sender_company || "",
        addressLine1: rm.sender_address_line1,
        addressLine2: rm.sender_address_line2 || "",
        addressLine3: "",
        city: rm.sender_city,
        county: "",
        postcode: rm.sender_postcode,
        countryCode: rm.sender_country || "GB",
      },
    },
    packages: [
      {
        weightInGrams: d.weight_grams,
        packageFormatIdentifier: cndPackageFormat(d.service_format),
        ...(d.length_mm && d.width_mm && d.height_mm ? {
          dimensions: {
            heightInMms: d.height_mm,
            widthInMms: d.width_mm,
            depthInMms: d.length_mm,
          },
        } : {}),
        contents: buildCndContents({
          lineItems: d.line_items,
          fallbackName: d.description_of_goods,
          totalWeightGrams: d.weight_grams,
        }),
      },
    ],
    orderDate: new Date().toISOString(),
    subtotal: 0,
    shippingCostCharged: 0,
    total: 0,
    currencyCode: "GBP",
    ...(d.service_code ? {
      postageDetails: {
        serviceCode: d.service_code,
        ...(d.safe_place ? { safePlace: d.safe_place } : {}),
      },
    } : d.safe_place ? {
      postageDetails: { safePlace: d.safe_place },
    } : {}),
    label: {
      includeLabelInResponse: false,
      includeCN: false,
      includeReturnsLabel: false,
    },
  };

  let result;
  try {
    result = await createCndOrder({ apiKey, useSandbox, order: cndOrder });
  } catch (e) {
    return { status: 502, body: { error: `Royal Mail request failed: ${e.message}` } };
  }

  if (!result.ok) {
    const baseMsg =
      result.body?.message ||
      result.body?.error ||
      result.body?.errors?.[0]?.errorMessage ||
      `Royal Mail returned ${result.status}`;
    const msg = result.status === 401
      ? "Royal Mail rejected the API key (401). Open Royal Mail settings, click Test, and re-paste a fresh API key from Click & Drop → Settings → Integrations."
      : baseMsg;
    console.warn(
      `[rm] create order failed: status=${result.status} sandbox=${useSandbox} ` +
      `keyPrefix=${apiKey.slice(0, 6)} keyLen=${apiKey.length}`,
    );
    return {
      status: result.status === 401 ? 401 : 422,
      body: { error: msg, status: result.status, detail: result.body },
    };
  }

  const norm = normalizeCndCreateResponse(result.body);
  if (!norm.ok) {
    return { status: 422, body: { error: norm.error, detail: norm.detail || result.body } };
  }

  const orderIdentifier = norm.orderIdentifier;
  const trackingNumber = norm.trackingNumber || null;
  let labelBase64 = null;

  if (orderIdentifier) {
    try {
      const lab = await getCndLabel({ apiKey, useSandbox, orderIdentifier });
      if (lab.ok && lab.buffer) {
        labelBase64 = lab.buffer.toString("base64");
      } else if (!lab.ok) {
        console.warn(
          `[rm] Could not fetch label for C&D order ${orderIdentifier}: ${lab.status} ${
            JSON.stringify(lab.body || {}).slice(0, 200)
          }`,
        );
      }
    } catch (e) {
      console.warn(`[rm] Label fetch threw for order ${orderIdentifier}: ${e.message}`);
    }
  }

  const insert = db.prepare(`
    INSERT INTO shipments (
      user_id, site_id, woocommerce_order_id, woocommerce_store_url,
      royal_mail_shipment_id, tracking_number, service_code, label_pdf_base64
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, d.site_id, d.woocommerce_order_id, site.store_url,
    orderIdentifier ? String(orderIdentifier) : null,
    trackingNumber || null,
    d.service_code,
    labelBase64 || null,
  );

  if (trackingNumber) {
    try {
      await addOrderNote(
        site,
        d.woocommerce_order_id,
        `Royal Mail ${d.service_code || "label"} created. Tracking: ${trackingNumber}`,
        false,
      );
    } catch (e) {
      console.warn(`[rm] Could not write WC note for order ${d.woocommerce_order_id}: ${e.message}`);
    }
  }

  const saved = db.prepare("SELECT * FROM shipments WHERE id = ?").get(insert.lastInsertRowid);
  return { status: 200, body: { shipment: rmShipmentToPublic(saved) } };
}

// Create a Royal Mail shipment for a single Woo order via Click & Drop.
app.post("/api/royal-mail/shipments", requireAuth, async (req, res) => {
  const parsed = shipmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const creds = loadRmCreds(req.user.id);
  if (!creds) return res.status(400).json({ error: "Royal Mail credentials are not configured." });

  const { status, body } = await createShipmentForUser({
    userId: req.user.id,
    data: parsed.data,
    creds,
  });
  res.status(status).json(body);
});

// Bulk: create labels for many Woo orders at once. Each order uses the same
// shared shipping params (service / format / weight). Per-order details are
// pulled from WooCommerce server-side so the client only needs to send the
// site + order IDs and the shared form values.
const bulkShipmentSchema = z.object({
  // Shared shipping params. Same shape as the single-order schema, minus the
  // per-order fields (recipient, woocommerce_order_id, customer_reference,
  // line_items).
  service_code: z.string().trim().max(10).optional().or(z.literal(""))
    .transform((v) => (v && v.toLowerCase() !== "auto" ? v.toUpperCase() : null)),
  service_format: z.enum(["P", "L", "F"]).default("P"),
  weight_grams: z.number().int().min(1).max(30000),
  length_mm: z.number().int().min(0).max(2000).optional(),
  width_mm: z.number().int().min(0).max(2000).optional(),
  height_mm: z.number().int().min(0).max(2000).optional(),
  safe_place: z.string().trim().max(120).optional().or(z.literal("")).transform((v) => v || null),
  description_of_goods: z.string().trim().max(60).default("Goods"),
  selections: z.array(z.object({
    site_id: z.number().int().positive(),
    order_ids: z.array(z.number().int().positive()).min(1).max(200),
  })).min(1).max(10),
});

// Map a WC address to the recipient shape expected by createShipmentForUser.
function recipientFromWcOrder(order) {
  const a = (order.shipping && (order.shipping.address_1 || order.shipping.first_name))
    ? order.shipping
    : (order.billing || {});
  return {
    name: `${a.first_name || ""} ${a.last_name || ""}`.trim() || "Customer",
    company: a.company || null,
    line1: a.address_1 || "",
    line2: a.address_2 || null,
    city: a.city || "",
    county: a.state || null,
    postcode: (a.postcode || "").toUpperCase(),
    country_code: (a.country || "GB").toUpperCase().slice(0, 2),
    phone: order.billing?.phone || null,
    email: order.billing?.email || null,
  };
}

app.post("/api/royal-mail/shipments/bulk", requireAuth, async (req, res) => {
  const parsed = bulkShipmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const creds = loadRmCreds(req.user.id);
  if (!creds) return res.status(400).json({ error: "Royal Mail credentials are not configured." });

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const sel of d.selections) {
    const site = loadSiteWithKeys(sel.site_id, req.user.id);
    if (!site) {
      for (const oid of sel.order_ids) {
        results.push({ site_id: sel.site_id, order_id: oid, ok: false, error: "Site not found" });
        failed++;
      }
      continue;
    }

    for (const orderId of sel.order_ids) {
      let order;
      try {
        order = await fetchOrderById(site, orderId);
      } catch (e) {
        results.push({ site_id: sel.site_id, order_id: orderId, ok: false, error: `Could not load order: ${e.message}` });
        failed++;
        continue;
      }
      if (!order) {
        results.push({ site_id: sel.site_id, order_id: orderId, ok: false, error: "Order not found in WooCommerce" });
        failed++;
        continue;
      }

      const lineItems = (order.line_items || []).map((li) => ({
        sku: String(li.sku || ""),
        name: String(li.name || ""),
        quantity: Math.max(1, Number(li.quantity) || 1),
      }));

      const data = {
        site_id: sel.site_id,
        woocommerce_order_id: orderId,
        customer_reference: String(order.number || orderId).slice(0, 40),
        service_code: d.service_code,
        service_format: d.service_format,
        weight_grams: d.weight_grams,
        length_mm: d.length_mm,
        width_mm: d.width_mm,
        height_mm: d.height_mm,
        safe_place: d.safe_place,
        description_of_goods: d.description_of_goods,
        line_items: lineItems,
        recipient: recipientFromWcOrder(order),
      };

      try {
        const r = await createShipmentForUser({ userId: req.user.id, data, creds });
        if (r.status === 200 && r.body.shipment) {
          results.push({
            site_id: sel.site_id,
            order_id: orderId,
            order_number: order.number,
            ok: true,
            shipment: r.body.shipment,
          });
          succeeded++;
        } else {
          results.push({
            site_id: sel.site_id,
            order_id: orderId,
            order_number: order.number,
            ok: false,
            error: r.body?.error || `Failed (${r.status})`,
          });
          failed++;
        }
      } catch (e) {
        results.push({ site_id: sel.site_id, order_id: orderId, ok: false, error: e.message });
        failed++;
      }
    }
  }

  res.json({ succeeded, failed, results });
});

// Bulk: merge multiple shipment label PDFs into a single multi-page PDF.
// Accepts shipment IDs as a comma-separated `ids` query param. Skips
// shipments without a printable PDF and reports them in a header so the
// client can warn the user.
app.get("/api/royal-mail/shipments/bulk/labels.pdf", requireAuth, async (req, res) => {
  const raw = String(req.query.ids || "").trim();
  if (!raw) return res.status(400).json({ error: "ids query param required" });
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.status(400).json({ error: "No valid shipment IDs" });
  if (ids.length > 200) return res.status(400).json({ error: "Too many shipments (max 200)" });

  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, label_pdf_base64, tracking_number FROM shipments
     WHERE user_id = ? AND id IN (${placeholders})`
  ).all(req.user.id, ...ids);

  if (rows.length === 0) return res.status(404).json({ error: "No shipments found" });

  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  const skipped = [];
  // Preserve the order the caller asked for, not the SQL row order.
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const id of ids) {
    const row = byId.get(id);
    if (!row || !row.label_pdf_base64) {
      skipped.push({ id, reason: "no_pdf" });
      continue;
    }
    const buf = Buffer.from(row.label_pdf_base64, "base64");
    const looksLikePdf = buf.length > 4 && buf.subarray(0, 4).toString("latin1") === "%PDF";
    if (!looksLikePdf) {
      skipped.push({ id, reason: "invalid_pdf" });
      continue;
    }
    try {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    } catch (e) {
      skipped.push({ id, reason: `merge_error: ${e.message}` });
    }
  }

  if (merged.getPageCount() === 0) {
    return res.status(422).json({
      error: "None of the selected shipments have a printable PDF.",
      skipped,
    });
  }

  const bytes = await merged.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="rm-labels-${new Date().toISOString().slice(0, 10)}.pdf"`,
  );
  if (skipped.length > 0) {
    res.setHeader("X-Skipped-Shipments", JSON.stringify(skipped).slice(0, 4000));
  }
  res.send(Buffer.from(bytes));
});

// Void a Click & Drop order (only works before label/despatch). Marks the
// local shipments row as voided so the order detail can offer "Create label"
// again.
app.delete("/api/royal-mail/shipments/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  // `?force=true` means: still mark the local row voided even if Click & Drop
  // refuses the delete (typical when the order already has a label generated
  // server-side, or when the remote order has been removed manually). This is
  // what powers the "Cancel label" button in the label viewer — the user
  // wants to abandon the broken/half-created shipment and start over.
  const force = String(req.query.force || "").toLowerCase() === "true";

  const row = db.prepare("SELECT * FROM shipments WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!row) return res.status(404).json({ error: "Shipment not found" });
  if (row.voided) return res.json({ ok: true, alreadyVoided: true });

  const creds = loadRmCreds(req.user.id);
  if (!creds) return res.status(400).json({ error: "Royal Mail credentials are not configured." });

  let remoteWarning = null;
  if (row.royal_mail_shipment_id) {
    try {
      const result = await deleteCndOrder({
        apiKey: creds.apiKey,
        useSandbox: creds.useSandbox,
        orderIdentifier: row.royal_mail_shipment_id,
      });
      if (!result.ok && result.status !== 404) {
        const msg = result.body?.message || `Royal Mail returned ${result.status}`;
        if (!force) {
          return res.status(422).json({ error: msg, detail: result.body });
        }
        remoteWarning = msg;
      }
    } catch (e) {
      if (!force) {
        return res.status(502).json({ error: `Royal Mail request failed: ${e.message}` });
      }
      remoteWarning = `Royal Mail request failed: ${e.message}`;
    }
  }

  db.prepare("UPDATE shipments SET voided = 1 WHERE id = ?").run(id);
  res.json({ ok: true, ...(remoteWarning ? { remoteWarning } : {}) });
});



// ============================================================================
// eBay (per-user OAuth 2.0)
// ----------------------------------------------------------------------------
// The app owner registers ONE production eBay developer app and provides:
//   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME
// in env vars. End-users click "Connect eBay" on the integrations page; we
// redirect them to eBay, exchange the authorization code for a refresh
// token, and store it AES-GCM encrypted in `ebay_accounts.refresh_token_enc`.
// Access tokens are minted lazily by server/ebay.js and cached on the row.
// ============================================================================

const ebayCreateAccountSchema = z.object({
  // Display name shown in the integrations list and orders toggle.
  name: z.string().trim().min(1).max(100),
});
const ebayUpdateAddressSchema = z.object({
  return_name: optAddrField(100),
  return_company: optAddrField(100),
  return_line1: optAddrField(150),
  return_line2: optAddrField(150),
  return_city: optAddrField(80),
  return_postcode: optAddrField(20),
  return_country: optAddrField(60),
});

const EBAY_PUBLIC_COLS =
  "id, name, ebay_user_id, scopes, created_at, " +
  "return_name, return_company, return_line1, return_line2, " +
  "return_city, return_postcode, return_country";

// Public-safe view: NEVER returns the encrypted token blob.
function ebayRowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ebay_user_id: row.ebay_user_id,
    scopes: row.scopes,
    created_at: row.created_at,
    return_name: row.return_name,
    return_company: row.return_company,
    return_line1: row.return_line1,
    return_line2: row.return_line2,
    return_city: row.return_city,
    return_postcode: row.return_postcode,
    return_country: row.return_country,
  };
}

// ----- Configuration check (used by the UI to enable/disable Connect btn) -----
app.get("/api/ebay/config", requireAuth, (_req, res) => {
  const cfg = ebayConfig();
  res.json({ configured: cfg.configured });
});

// ----- List the user's connected eBay accounts -----
app.get("/api/ebay/accounts", requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT ${EBAY_PUBLIC_COLS} FROM ebay_accounts WHERE user_id = ? ORDER BY name ASC`,
  ).all(req.user.id);
  res.json({ accounts: rows });
});

// ----- Start OAuth: returns the eBay authorize URL the browser should open -----
// We pre-create a placeholder ebay_oauth_states row keyed by a random `state`
// token. eBay echoes that token back on the callback so we can match the
// response to the requesting user and the chosen account display name.
app.post("/api/ebay/oauth/authorize", requireAuth, (req, res) => {
  const cfg = ebayConfig();
  if (!cfg.configured) {
    return res.status(503).json({
      error: "eBay is not configured on the server. Ask an admin to set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME.",
    });
  }
  const parsed = ebayCreateAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const state = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO ebay_oauth_states (state, user_id, name, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(state, req.user.id, parsed.data.name, expiresAt);

  // Garbage-collect expired states so the table doesn't grow forever.
  db.prepare("DELETE FROM ebay_oauth_states WHERE expires_at < datetime('now')").run();

  try {
    const url = buildAuthorizeUrl(state);
    res.json({ url, state });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to build authorize URL" });
  }
});

// ----- OAuth callback (eBay redirects the BROWSER here) -----
// eBay's redirect URL is configured to the RuName, which resolves on their
// end to whatever URL the developer entered ("Auth Accepted URL"). That URL
// must point here. We exchange the code, save the refresh token, and bounce
// the user back to /integrations with a result query param.
//
// NOTE: This route is intentionally NOT behind requireAuth — the user's
// browser arrives here from eBay without our JWT in the header. Authorization
// is enforced by validating the `state` token against ebay_oauth_states.
app.get("/api/ebay/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const errorParam = typeof req.query.error === "string" ? req.query.error : "";

  // Helper: build a redirect back to /integrations with a status query.
  const back = (params) => {
    const qs = new URLSearchParams({ ebay: "callback", ...params }).toString();
    return res.redirect(302, `/integrations?${qs}`);
  };

  if (errorParam) return back({ status: "declined", error: errorParam });
  if (!code || !state) return back({ status: "error", error: "Missing code or state" });

  const stateRow = db.prepare(
    "SELECT * FROM ebay_oauth_states WHERE state = ?",
  ).get(state);
  if (!stateRow) return back({ status: "error", error: "Unknown OAuth state" });
  if (new Date(stateRow.expires_at) < new Date()) {
    db.prepare("DELETE FROM ebay_oauth_states WHERE state = ?").run(state);
    return back({ status: "error", error: "OAuth state expired" });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const ebayUserId = await fetchEbayUserId(tokens.accessToken);
    const now = Date.now();
    const accessExp = new Date(now + tokens.accessTokenExpiresIn * 1000).toISOString();
    const refreshExp = new Date(now + tokens.refreshTokenExpiresIn * 1000).toISOString();

    db.prepare(`
      INSERT INTO ebay_accounts (
        user_id, name, ebay_user_id,
        refresh_token_enc, refresh_token_expires_at,
        access_token_enc, access_token_expires_at,
        scopes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stateRow.user_id,
      stateRow.name,
      ebayUserId,
      encrypt(tokens.refreshToken),
      refreshExp,
      encrypt(tokens.accessToken),
      accessExp,
      // Persist the scopes we asked for so the UI can show what's authorized.
      "fulfillment.readonly fulfillment",
    );

    db.prepare("DELETE FROM ebay_oauth_states WHERE state = ?").run(state);
    return back({ status: "connected", name: stateRow.name });
  } catch (e) {
    console.error("[ebay] OAuth callback failed:", e);
    return back({ status: "error", error: e.message || "Token exchange failed" });
  }
});

// ----- Update the return address used when shipping eBay orders -----
app.patch("/api/ebay/accounts/:id/return-address", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare(
    "SELECT id FROM ebay_accounts WHERE id = ? AND user_id = ?",
  ).get(id, req.user.id);
  if (!owned) return res.status(404).json({ error: "Not found" });

  const parsed = ebayUpdateAddressSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  db.prepare(`
    UPDATE ebay_accounts SET
      return_name = ?, return_company = ?, return_line1 = ?, return_line2 = ?,
      return_city = ?, return_postcode = ?, return_country = ?,
      updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(
    d.return_name, d.return_company, d.return_line1, d.return_line2,
    d.return_city, d.return_postcode, d.return_country,
    id, req.user.id,
  );
  const row = db.prepare(
    `SELECT ${EBAY_PUBLIC_COLS} FROM ebay_accounts WHERE id = ?`,
  ).get(id);
  res.json({ account: row });
});

// ----- Delete a connected account (revokes our local copy of the token) -----
app.delete("/api/ebay/accounts/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM ebay_accounts WHERE id = ? AND user_id = ?")
    .run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ----- Fetch orders for one eBay account -----
// Mirrors GET /api/sites/:id/orders so the frontend can use the same code
// path. Same query params: ?statuses=... &after=... &before=...
app.get("/api/ebay/accounts/:id/orders", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const account = db.prepare(
    "SELECT * FROM ebay_accounts WHERE id = ? AND user_id = ?",
  ).get(id, req.user.id);
  if (!account) return res.status(404).json({ error: "Not found" });

  const requested = String(req.query.statuses || "processing")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const statuses = requested.filter((s) => VALID_STATUSES.includes(s));
  if (statuses.length === 0) statuses.push("processing");

  const after = typeof req.query.after === "string" && req.query.after ? req.query.after : null;
  const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;

  try {
    const accessToken = await getAccessToken(db, account);
    const orders = await fetchEbayOrders(account, { statuses, after, before, accessToken });
    res.json({ orders: orders.map(normalizeEbayOrder) });
  } catch (e) {
    res.status(502).json({ error: e.message || "eBay error" });
  }
});


// ---------- GitHub deploy webhook ----------
// Configure in GitHub: repo Settings -> Webhooks -> Add webhook
//   Payload URL: https://www.ultrax.work/api/deploy/github
//   Content type: application/json
//   Secret: same value as GITHUB_WEBHOOK_SECRET in server/.env
//   Events: Just the push event
//
// We verify the HMAC signature, then fire scripts/deploy.sh in the background
// and return 202 immediately so GitHub doesn't time out waiting for the build.
// ---------- HeyShop Inventory ("OMS") module ----------
// All /api/oms/* endpoints. Schema, seed, and handlers live in ./oms.js.
mountOms(app, { requireAuth });
// WooCommerce ↔ Inventory bridge (sync, bulk-edit, push, backups).
mountOmsWoo(app, { requireAuth });
// Purchase orders + suppliers + receive-stock + printable PDF.
mountOmsPo(app, { requireAuth });

app.listen(PORT, () => {
  console.log(`Ultrax API listening on http://127.0.0.1:${PORT}`);
  console.log(`Master admin: ${ADMIN_EMAIL}`);
});
