import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { db } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { signToken, requireAuth, requireAdmin } from "./auth.js";
import { fetchProcessingOrders, fetchOrderById, generatePicklistPdf } from "./woocommerce.js";

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());

if (!process.env.JWT_SECRET) { console.error("FATAL: JWT_SECRET is required"); process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error("FATAL: ENCRYPTION_KEY is required"); process.exit(1); }
if (!ADMIN_EMAIL) { console.error("FATAL: ADMIN_EMAIL is required"); process.exit(1); }

const app = express();
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
const siteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  store_url: z.string().url().max(500),
  consumer_key: z.string().min(1).max(200),
  consumer_secret: z.string().min(1).max(200),
});
const generateSchema = z.object({
  selections: z.array(z.object({
    site_id: z.number().int().positive(),
    order_ids: z.array(z.number().int().positive()).min(1).max(500),
  })).min(1).max(20),
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
function siteToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    store_url: row.store_url,
    created_at: row.created_at,
  };
}

app.get("/api/sites", requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT id, name, store_url, created_at FROM sites WHERE user_id = ? ORDER BY name ASC",
  ).all(req.user.id);
  res.json({ sites: rows });
});

app.post("/api/sites", requireAuth, (req, res) => {
  const parsed = siteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  const { name, store_url, consumer_key, consumer_secret } = parsed.data;
  const result = db.prepare(`
    INSERT INTO sites (user_id, name, store_url, consumer_key_enc, consumer_secret_enc)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, name, store_url.replace(/\/+$/, ""), encrypt(consumer_key), encrypt(consumer_secret));
  const row = db.prepare("SELECT id, name, store_url, created_at FROM sites WHERE id = ?").get(result.lastInsertRowid);
  res.json({ site: row });
});

app.put("/api/sites/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!owned) return res.status(404).json({ error: "Not found" });
  const parsed = siteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { name, store_url, consumer_key, consumer_secret } = parsed.data;
  db.prepare(`
    UPDATE sites SET name = ?, store_url = ?, consumer_key_enc = ?, consumer_secret_enc = ?
    WHERE id = ? AND user_id = ?
  `).run(name, store_url.replace(/\/+$/, ""), encrypt(consumer_key), encrypt(consumer_secret), id, req.user.id);
  const row = db.prepare("SELECT id, name, store_url, created_at FROM sites WHERE id = ?").get(id);
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
  };
}

app.get("/api/sites/:id/orders", requireAuth, async (req, res) => {
  const site = loadSiteWithKeys(Number(req.params.id), req.user.id);
  if (!site) return res.status(404).json({ error: "Not found" });
  try {
    const orders = await fetchProcessingOrders(site);
    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        date_created: o.date_created,
        total: o.total,
        currency: o.currency,
        customer: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim(),
        itemCount: o.line_items.reduce((s, li) => s + li.quantity, 0),
        lineCount: o.line_items.length,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "Upstream error" });
  }
});

app.post("/api/picklist", requireAuth, async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  try {
    const groups = [];
    for (const sel of parsed.data.selections) {
      const site = loadSiteWithKeys(sel.site_id, req.user.id);
      if (!site) return res.status(404).json({ error: `Site ${sel.site_id} not found` });
      const orders = [];
      const chunkSize = 5;
      for (let i = 0; i < sel.order_ids.length; i += chunkSize) {
        const chunk = sel.order_ids.slice(i, i + chunkSize);
        const results = await Promise.all(chunk.map((id) => fetchOrderById(site, id)));
        orders.push(...results);
      }
      groups.push({ site: { name: site.name, store_url: site.store_url }, orders });
    }
    const pdf = await generatePicklistPdf(groups);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="picklist-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: e.message || "PDF generation failed" });
  }
});

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Ultrax API listening on http://127.0.0.1:${PORT}`);
  console.log(`Master admin: ${ADMIN_EMAIL}`);
});
