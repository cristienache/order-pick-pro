// HeyShop Purchase Orders module.
//
// Mounted from server/index.js with:
//   import { mountOmsPo } from "./oms-po.js";
//   mountOmsPo(app, { requireAuth });
//
// Endpoints:
//   GET    /api/oms/suppliers
//   POST   /api/oms/suppliers
//   PUT    /api/oms/suppliers/:id
//   DELETE /api/oms/suppliers/:id
//
//   GET    /api/oms/purchase-orders
//   GET    /api/oms/purchase-orders/:id
//   POST   /api/oms/purchase-orders
//   PUT    /api/oms/purchase-orders/:id           (header + lines, only when status=draft)
//   POST   /api/oms/purchase-orders/:id/send      (draft -> sent)
//   POST   /api/oms/purchase-orders/:id/receive   (sent/partial -> partial/received, writes stock)
//   POST   /api/oms/purchase-orders/:id/cancel
//   GET    /api/oms/purchase-orders/:id/pdf       (printable A4 PDF)
//
// Persistence reuses the global SQLite database. Suppliers and POs are
// scoped per-user via a `user_id` column so each tenant only sees their own
// records (unlike products/warehouses, which are shared in the OMS scope).

import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "./db.js";

/* ---------------- Schema (idempotent) ---------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS oms_suppliers (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    postcode TEXT,
    country TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_suppliers_user ON oms_suppliers(user_id);

  CREATE TABLE IF NOT EXISTS oms_purchase_orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    po_number TEXT NOT NULL,
    supplier_id TEXT NOT NULL REFERENCES oms_suppliers(id) ON DELETE RESTRICT,
    warehouse_id TEXT REFERENCES oms_warehouses(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','sent','partial','received','cancelled')),
    currency TEXT NOT NULL DEFAULT 'GBP',
    expected_at TEXT,
    notes TEXT,
    shipping_cost REAL NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0, -- e.g. 0.2 for 20%
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_po_user ON oms_purchase_orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_po_supplier ON oms_purchase_orders(supplier_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_po_user_number
    ON oms_purchase_orders(user_id, po_number);

  CREATE TABLE IF NOT EXISTS oms_po_lines (
    id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL REFERENCES oms_purchase_orders(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES oms_products(id) ON DELETE SET NULL,
    sku TEXT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    received_quantity INTEGER NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_po_lines_po ON oms_po_lines(po_id);
`);

/* ---------------- Helpers ---------------- */

const SUPPLIER_FIELDS = [
  "name", "contact_name", "email", "phone",
  "address_line1", "address_line2", "city", "postcode", "country", "notes",
];

function sanitiseSupplierInput(body = {}) {
  const out = {};
  for (const f of SUPPLIER_FIELDS) {
    const v = body[f];
    out[f] = v == null ? null : String(v).trim().slice(0, 500) || null;
  }
  if (!out.name) out.name = null;
  return out;
}

function loadSupplier(userId, id) {
  return db.prepare(
    `SELECT * FROM oms_suppliers WHERE id = ? AND user_id = ?`,
  ).get(id, userId);
}

function nextPoNumber(userId) {
  // Year-prefixed sequential, scoped per user. e.g. PO-2025-0001.
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const last = db.prepare(
    `SELECT po_number FROM oms_purchase_orders
      WHERE user_id = ? AND po_number LIKE ?
      ORDER BY po_number DESC LIMIT 1`,
  ).get(userId, `${prefix}%`);
  let nextSeq = 1;
  if (last) {
    const tail = String(last.po_number).slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) nextSeq = n + 1;
  }
  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

function loadPoFull(userId, id) {
  const po = db.prepare(
    `SELECT * FROM oms_purchase_orders WHERE id = ? AND user_id = ?`,
  ).get(id, userId);
  if (!po) return null;
  const lines = db.prepare(
    `SELECT * FROM oms_po_lines WHERE po_id = ? ORDER BY sort_order ASC, id ASC`,
  ).all(id);
  const supplier = db.prepare(
    `SELECT * FROM oms_suppliers WHERE id = ?`,
  ).get(po.supplier_id);
  const warehouse = po.warehouse_id
    ? db.prepare(`SELECT id, name, code, address FROM oms_warehouses WHERE id = ?`)
        .get(po.warehouse_id)
    : null;
  return { ...po, lines, supplier, warehouse };
}

function computeTotals(po) {
  const subtotal = (po.lines || []).reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0),
    0,
  );
  const tax = subtotal * (Number(po.tax_rate) || 0);
  const shipping = Number(po.shipping_cost) || 0;
  const total = subtotal + tax + shipping;
  return {
    subtotal: Number(subtotal.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    shipping: Number(shipping.toFixed(2)),
    total: Number(total.toFixed(2)),
  };
}

function withTotals(po) {
  return po ? { ...po, totals: computeTotals(po) } : po;
}

/* ---------------- PDF rendering ---------------- */

async function renderPoPdf(po, branding) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 portrait

  const { width, height } = page.getSize();
  const margin = 40;
  let y = height - margin;

  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.4, 0.42, 0.48);
  const accent = rgb(0.18, 0.32, 0.85);
  const ruleC = rgb(0.85, 0.87, 0.92);

  const draw = (text, x, yy, opts = {}) => {
    page.drawText(String(text ?? ""), {
      x, y: yy,
      size: opts.size || 10,
      font: opts.bold ? bold : font,
      color: opts.color || ink,
      maxWidth: opts.maxWidth,
    });
  };

  // Header
  draw(branding?.app_name || "Purchase Order", margin, y, { size: 18, bold: true, color: accent });
  draw("PURCHASE ORDER", width - margin - 150, y, { size: 16, bold: true });
  y -= 22;
  draw(branding?.tagline || "", margin, y, { size: 9, color: muted });
  draw(`#${po.po_number}`, width - margin - 150, y, { size: 11, color: muted });
  y -= 18;

  page.drawLine({
    start: { x: margin, y }, end: { x: width - margin, y },
    color: ruleC, thickness: 1,
  });
  y -= 18;

  // Supplier + meta block
  const colW = (width - margin * 2) / 2;
  let leftY = y, rightY = y;

  draw("SUPPLIER", margin, leftY, { size: 9, bold: true, color: muted });
  leftY -= 14;
  draw(po.supplier?.name || "", margin, leftY, { size: 11, bold: true });
  leftY -= 14;
  for (const line of [
    po.supplier?.contact_name,
    po.supplier?.address_line1,
    po.supplier?.address_line2,
    [po.supplier?.city, po.supplier?.postcode].filter(Boolean).join(" "),
    po.supplier?.country,
    po.supplier?.email,
    po.supplier?.phone,
  ].filter(Boolean)) {
    draw(line, margin, leftY, { size: 10 });
    leftY -= 12;
  }

  const rightX = margin + colW + 10;
  draw("DETAILS", rightX, rightY, { size: 9, bold: true, color: muted });
  rightY -= 14;
  const metaRow = (label, value) => {
    draw(label, rightX, rightY, { size: 10, color: muted });
    draw(value || "—", rightX + 90, rightY, { size: 10 });
    rightY -= 13;
  };
  metaRow("PO Number", po.po_number);
  metaRow("Status", String(po.status || "").toUpperCase());
  metaRow("Issued", new Date(po.created_at).toLocaleDateString("en-GB"));
  metaRow("Expected", po.expected_at ? new Date(po.expected_at).toLocaleDateString("en-GB") : "—");
  metaRow("Currency", po.currency || "GBP");
  if (po.warehouse) metaRow("Ship to", `${po.warehouse.name} (${po.warehouse.code})`);

  y = Math.min(leftY, rightY) - 18;

  // Line items table
  const tableX = margin;
  const tableW = width - margin * 2;
  const cols = [
    { key: "sku", label: "SKU", w: 80 },
    { key: "name", label: "Description", w: tableW - 80 - 60 - 80 - 80 },
    { key: "qty", label: "Qty", w: 60, align: "right" },
    { key: "unit", label: "Unit cost", w: 80, align: "right" },
    { key: "line", label: "Line total", w: 80, align: "right" },
  ];

  // header bar
  page.drawRectangle({
    x: tableX, y: y - 18, width: tableW, height: 18,
    color: rgb(0.96, 0.97, 0.99),
  });
  let cx = tableX + 6;
  for (const c of cols) {
    const tx = c.align === "right" ? cx + c.w - 6 - bold.widthOfTextAtSize(c.label, 9) : cx;
    draw(c.label, tx, y - 12, { size: 9, bold: true, color: muted });
    cx += c.w;
  }
  y -= 22;

  for (const ln of po.lines || []) {
    if (y < margin + 120) {
      // start a new page if running out of room
      const np = pdfDoc.addPage([595.28, 841.89]);
      y = np.getSize().height - margin;
      break;
    }
    cx = tableX + 6;
    const lineTotal = (Number(ln.quantity) || 0) * (Number(ln.unit_cost) || 0);
    const cells = [
      ln.sku || "",
      ln.name || "",
      String(ln.quantity ?? 0),
      (Number(ln.unit_cost) || 0).toFixed(2),
      lineTotal.toFixed(2),
    ];
    cells.forEach((val, i) => {
      const c = cols[i];
      const txtW = font.widthOfTextAtSize(String(val), 10);
      const tx = c.align === "right" ? cx + c.w - 6 - txtW : cx;
      draw(val, tx, y, { size: 10, maxWidth: c.w - 6 });
      cx += c.w;
    });
    y -= 16;
    page.drawLine({
      start: { x: tableX, y: y + 4 }, end: { x: tableX + tableW, y: y + 4 },
      color: ruleC, thickness: 0.5,
    });
  }

  // Totals box
  y -= 10;
  const totals = computeTotals(po);
  const totalsX = width - margin - 220;
  const labelOf = (k) => ({
    subtotal: "Subtotal",
    tax: `Tax (${Math.round((po.tax_rate || 0) * 100)}%)`,
    shipping: "Shipping",
    total: "Total",
  })[k];
  for (const key of ["subtotal", "tax", "shipping"]) {
    draw(labelOf(key), totalsX, y, { size: 10, color: muted });
    const v = `${po.currency} ${totals[key].toFixed(2)}`;
    draw(v, width - margin - font.widthOfTextAtSize(v, 10), y, { size: 10 });
    y -= 14;
  }
  page.drawLine({
    start: { x: totalsX, y: y + 6 }, end: { x: width - margin, y: y + 6 },
    color: ink, thickness: 1,
  });
  y -= 4;
  draw("Total", totalsX, y, { size: 12, bold: true });
  const totalStr = `${po.currency} ${totals.total.toFixed(2)}`;
  draw(totalStr, width - margin - bold.widthOfTextAtSize(totalStr, 12), y, { size: 12, bold: true });
  y -= 28;

  // Notes
  if (po.notes) {
    draw("Notes", margin, y, { size: 10, bold: true, color: muted });
    y -= 14;
    const noteLines = String(po.notes).split(/\n/).slice(0, 8);
    for (const line of noteLines) {
      draw(line.slice(0, 120), margin, y, { size: 10 });
      y -= 12;
    }
    y -= 6;
  }

  // Goods-received block (printable receipt area)
  y -= 10;
  draw("GOODS RECEIVED", margin, y, { size: 9, bold: true, color: muted });
  y -= 14;
  page.drawRectangle({
    x: margin, y: y - 90, width: width - margin * 2, height: 90,
    borderColor: ruleC, borderWidth: 1, color: rgb(1, 1, 1),
  });
  draw("Received by:", margin + 10, y - 20, { size: 10, color: muted });
  draw("Date:", margin + 10, y - 50, { size: 10, color: muted });
  draw("Signature:", margin + 280, y - 20, { size: 10, color: muted });
  draw("Condition / notes:", margin + 280, y - 50, { size: 10, color: muted });

  // Footer
  const footer = `Generated by ${branding?.app_name || "HeyShop"} · ${new Date().toISOString().slice(0, 10)}`;
  draw(footer, margin, margin / 2, { size: 8, color: muted });

  return Buffer.from(await pdfDoc.save());
}

/* ---------------- Mount ---------------- */

export function mountOmsPo(app, { requireAuth }) {
  const r = "/api/oms";

  // ===== Suppliers =====
  app.get(`${r}/suppliers`, requireAuth, (req, res) => {
    const rows = db.prepare(
      `SELECT * FROM oms_suppliers WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC`,
    ).all(req.user.id);
    res.json(rows);
  });

  app.post(`${r}/suppliers`, requireAuth, (req, res) => {
    const data = sanitiseSupplierInput(req.body);
    if (!data.name) return res.status(422).json({ error: "Supplier name is required" });
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO oms_suppliers
        (id, user_id, name, contact_name, email, phone,
         address_line1, address_line2, city, postcode, country, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, req.user.id, data.name, data.contact_name, data.email, data.phone,
      data.address_line1, data.address_line2, data.city, data.postcode,
      data.country, data.notes,
    );
    res.json(loadSupplier(req.user.id, id));
  });

  app.put(`${r}/suppliers/:id`, requireAuth, (req, res) => {
    const existing = loadSupplier(req.user.id, req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const data = sanitiseSupplierInput({ ...existing, ...req.body });
    if (!data.name) return res.status(422).json({ error: "Supplier name is required" });
    db.prepare(
      `UPDATE oms_suppliers SET
         name = ?, contact_name = ?, email = ?, phone = ?,
         address_line1 = ?, address_line2 = ?, city = ?, postcode = ?,
         country = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).run(
      data.name, data.contact_name, data.email, data.phone,
      data.address_line1, data.address_line2, data.city, data.postcode,
      data.country, data.notes, req.params.id, req.user.id,
    );
    res.json(loadSupplier(req.user.id, req.params.id));
  });

  app.delete(`${r}/suppliers/:id`, requireAuth, (req, res) => {
    // Block deletion if POs reference this supplier.
    const inUse = db.prepare(
      `SELECT COUNT(*) AS c FROM oms_purchase_orders WHERE supplier_id = ?`,
    ).get(req.params.id).c;
    if (inUse > 0) {
      return res.status(409).json({
        error: `Supplier is used by ${inUse} purchase order(s)`, code: "in_use",
      });
    }
    db.prepare(`DELETE FROM oms_suppliers WHERE id = ? AND user_id = ?`)
      .run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ===== Purchase Orders =====
  app.get(`${r}/purchase-orders`, requireAuth, (req, res) => {
    const rows = db.prepare(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COUNT(*) FROM oms_po_lines WHERE po_id = po.id) AS line_count
         FROM oms_purchase_orders po
         JOIN oms_suppliers s ON s.id = po.supplier_id
        WHERE po.user_id = ?
        ORDER BY po.created_at DESC`,
    ).all(req.user.id);
    // attach computed totals lazily — list view only needs subtotal/total
    const out = rows.map((po) => {
      const lines = db.prepare(
        `SELECT quantity, unit_cost FROM oms_po_lines WHERE po_id = ?`,
      ).all(po.id);
      const subtotal = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unit_cost || 0), 0);
      const tax = subtotal * (po.tax_rate || 0);
      const total = subtotal + tax + (po.shipping_cost || 0);
      return { ...po, subtotal: Number(subtotal.toFixed(2)), total: Number(total.toFixed(2)) };
    });
    res.json(out);
  });

  app.get(`${r}/purchase-orders/:id`, requireAuth, (req, res) => {
    const po = loadPoFull(req.user.id, req.params.id);
    if (!po) return res.status(404).json({ error: "Not found" });
    res.json(withTotals(po));
  });

  app.post(`${r}/purchase-orders`, requireAuth, (req, res) => {
    const {
      supplier_id, warehouse_id, currency = "GBP", expected_at,
      notes, shipping_cost = 0, tax_rate = 0, lines = [],
    } = req.body || {};
    if (!supplier_id) return res.status(422).json({ error: "supplier_id required" });
    const supplier = loadSupplier(req.user.id, supplier_id);
    if (!supplier) return res.status(422).json({ error: "Unknown supplier" });

    const id = crypto.randomUUID();
    const number = nextPoNumber(req.user.id);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO oms_purchase_orders
          (id, user_id, po_number, supplier_id, warehouse_id, status,
           currency, expected_at, notes, shipping_cost, tax_rate)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      ).run(
        id, req.user.id, number, supplier_id, warehouse_id || null,
        String(currency).slice(0, 6).toUpperCase(),
        expected_at ? String(expected_at).slice(0, 30) : null,
        notes ? String(notes).slice(0, 4000) : null,
        Number(shipping_cost) || 0, Number(tax_rate) || 0,
      );
      const ins = db.prepare(
        `INSERT INTO oms_po_lines
          (id, po_id, product_id, sku, name, quantity, unit_cost, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      (Array.isArray(lines) ? lines : []).forEach((ln, idx) => {
        if (!ln?.name && !ln?.sku) return;
        ins.run(
          crypto.randomUUID(), id, ln.product_id || null,
          ln.sku ? String(ln.sku).slice(0, 100) : null,
          String(ln.name || ln.sku || "Item").slice(0, 200),
          Math.max(0, Math.floor(Number(ln.quantity) || 0)),
          Number(ln.unit_cost) || 0,
          idx,
        );
      });
    });
    tx();
    res.json(withTotals(loadPoFull(req.user.id, id)));
  });

  app.put(`${r}/purchase-orders/:id`, requireAuth, (req, res) => {
    const po = loadPoFull(req.user.id, req.params.id);
    if (!po) return res.status(404).json({ error: "Not found" });
    if (po.status !== "draft") {
      return res.status(409).json({ error: "Only draft POs can be edited" });
    }
    const {
      supplier_id = po.supplier_id,
      warehouse_id = po.warehouse_id,
      currency = po.currency,
      expected_at = po.expected_at,
      notes = po.notes,
      shipping_cost = po.shipping_cost,
      tax_rate = po.tax_rate,
      lines,
    } = req.body || {};
    const supplier = loadSupplier(req.user.id, supplier_id);
    if (!supplier) return res.status(422).json({ error: "Unknown supplier" });

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE oms_purchase_orders SET
           supplier_id = ?, warehouse_id = ?, currency = ?, expected_at = ?,
           notes = ?, shipping_cost = ?, tax_rate = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      ).run(
        supplier_id, warehouse_id || null,
        String(currency).slice(0, 6).toUpperCase(),
        expected_at ? String(expected_at).slice(0, 30) : null,
        notes ? String(notes).slice(0, 4000) : null,
        Number(shipping_cost) || 0, Number(tax_rate) || 0,
        req.params.id, req.user.id,
      );
      if (Array.isArray(lines)) {
        db.prepare(`DELETE FROM oms_po_lines WHERE po_id = ?`).run(req.params.id);
        const ins = db.prepare(
          `INSERT INTO oms_po_lines
            (id, po_id, product_id, sku, name, quantity, unit_cost, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        lines.forEach((ln, idx) => {
          if (!ln?.name && !ln?.sku) return;
          ins.run(
            crypto.randomUUID(), req.params.id, ln.product_id || null,
            ln.sku ? String(ln.sku).slice(0, 100) : null,
            String(ln.name || ln.sku || "Item").slice(0, 200),
            Math.max(0, Math.floor(Number(ln.quantity) || 0)),
            Number(ln.unit_cost) || 0,
            idx,
          );
        });
      }
    });
    tx();
    res.json(withTotals(loadPoFull(req.user.id, req.params.id)));
  });

  app.post(`${r}/purchase-orders/:id/send`, requireAuth, (req, res) => {
    const po = loadPoFull(req.user.id, req.params.id);
    if (!po) return res.status(404).json({ error: "Not found" });
    if (po.status !== "draft") {
      return res.status(409).json({ error: `Cannot send a PO in status ${po.status}` });
    }
    db.prepare(
      `UPDATE oms_purchase_orders SET status = 'sent', updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`,
    ).run(req.params.id, req.user.id);
    res.json(withTotals(loadPoFull(req.user.id, req.params.id)));
  });

  app.post(`${r}/purchase-orders/:id/cancel`, requireAuth, (req, res) => {
    const po = loadPoFull(req.user.id, req.params.id);
    if (!po) return res.status(404).json({ error: "Not found" });
    if (po.status === "received") {
      return res.status(409).json({ error: "Cannot cancel a fully received PO" });
    }
    db.prepare(
      `UPDATE oms_purchase_orders SET status = 'cancelled', updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`,
    ).run(req.params.id, req.user.id);
    res.json(withTotals(loadPoFull(req.user.id, req.params.id)));
  });

  // Receive stock: { receipts: [{ line_id, quantity }], warehouse_id? }
  // Writes the received quantity into oms_inventory at the PO's warehouse
  // (or the override warehouse_id), records audit rows, and updates the PO
  // line's received_quantity. Status transitions:
  //   any received < requested  → 'partial'
  //   all received >= requested → 'received'
  app.post(`${r}/purchase-orders/:id/receive`, requireAuth, (req, res) => {
    const po = loadPoFull(req.user.id, req.params.id);
    if (!po) return res.status(404).json({ error: "Not found" });
    if (!["sent", "partial"].includes(po.status)) {
      return res.status(409).json({ error: `Cannot receive a PO in status ${po.status}` });
    }
    const targetWh = req.body?.warehouse_id || po.warehouse_id;
    if (!targetWh) {
      return res.status(422).json({ error: "warehouse_id required (none on PO)" });
    }
    const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];
    if (!receipts.length) return res.status(422).json({ error: "receipts[] required" });

    const lineMap = new Map(po.lines.map((l) => [l.id, l]));
    const tx = db.transaction(() => {
      for (const r of receipts) {
        const ln = lineMap.get(r.line_id);
        if (!ln) continue;
        const qty = Math.max(0, Math.floor(Number(r.quantity) || 0));
        if (qty <= 0) continue;
        if (!ln.product_id) {
          // Free-text line: bump received counter only.
          db.prepare(
            `UPDATE oms_po_lines SET received_quantity = received_quantity + ? WHERE id = ?`,
          ).run(qty, ln.id);
          continue;
        }
        // Upsert inventory row.
        const inv = db.prepare(
          `SELECT quantity, version FROM oms_inventory
            WHERE product_id = ? AND warehouse_id = ?`,
        ).get(ln.product_id, targetWh);
        if (inv) {
          db.prepare(
            `UPDATE oms_inventory
                SET quantity = quantity + ?, version = version + 1
              WHERE product_id = ? AND warehouse_id = ?`,
          ).run(qty, ln.product_id, targetWh);
        } else {
          db.prepare(
            `INSERT INTO oms_inventory
               (product_id, warehouse_id, quantity, reserved, reorder_level, version)
             VALUES (?, ?, ?, 0, 0, 1)`,
          ).run(ln.product_id, targetWh, qty);
        }
        const newQty = (inv?.quantity || 0) + qty;
        db.prepare(
          `INSERT INTO oms_inventory_audit
             (id, product_id, warehouse_id, delta, new_qty, reason, source, actor_id)
           VALUES (?, ?, ?, ?, ?, ?, 'po_receive', ?)`,
        ).run(
          crypto.randomUUID(), ln.product_id, targetWh,
          qty, newQty, `PO ${po.po_number} receipt`, String(req.user.id),
        );
        db.prepare(
          `UPDATE oms_po_lines SET received_quantity = received_quantity + ? WHERE id = ?`,
        ).run(qty, ln.id);
      }

      // Recompute status.
      const fresh = db.prepare(
        `SELECT quantity, received_quantity FROM oms_po_lines WHERE po_id = ?`,
      ).all(req.params.id);
      const allDone = fresh.every((l) => l.received_quantity >= l.quantity);
      const anyDone = fresh.some((l) => l.received_quantity > 0);
      const next = allDone ? "received" : anyDone ? "partial" : po.status;
      db.prepare(
        `UPDATE oms_purchase_orders SET status = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`,
      ).run(next, req.params.id, req.user.id);
    });
    tx();
    res.json(withTotals(loadPoFull(req.user.id, req.params.id)));
  });

  // PDF (printable, receipt-ready)
  app.get(`${r}/purchase-orders/:id/pdf`, requireAuth, async (req, res) => {
    const po = loadPoFull(req.user.id, req.params.id);
    if (!po) return res.status(404).json({ error: "Not found" });
    const branding = (() => {
      try {
        const row = db.prepare(`SELECT app_name, tagline FROM branding WHERE id = 1`).get();
        return row || { app_name: "HeyShop", tagline: "Order ops" };
      } catch { return { app_name: "HeyShop", tagline: "Order ops" }; }
    })();
    try {
      const buf = await renderPoPdf({ ...po, totals: computeTotals(po) }, branding);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${po.po_number}.pdf"`,
      );
      res.end(buf);
    } catch (e) {
      console.error("[oms-po] pdf render failed:", e);
      res.status(500).json({ error: "PDF generation failed" });
    }
  });
}
