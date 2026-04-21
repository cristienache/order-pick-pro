import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function authHeader(key, secret) {
  const token = Buffer.from(`${key}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

/**
 * Fetch orders with optional status filter (comma-separated WC statuses, default "processing").
 */
export async function fetchOrders(site, opts = {}) {
  const statuses = opts.statuses && opts.statuses.length ? opts.statuses.join(",") : "processing";
  const orders = [];
  let page = 1;
  const perPage = 100;
  const base = normalizeUrl(site.store_url);

  while (page <= 5) {
    const url = `${base}/wp-json/wc/v3/orders?status=${encodeURIComponent(statuses)}&per_page=${perPage}&page=${page}&orderby=date&order=asc`;
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(site.consumer_key, site.consumer_secret),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WooCommerce API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const batch = await res.json();
    orders.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return orders;
}

// Backwards-compat alias used elsewhere
export const fetchProcessingOrders = (site) => fetchOrders(site, { statuses: ["processing"] });

export async function fetchOrderById(site, id) {
  const base = normalizeUrl(site.store_url);
  const res = await fetch(`${base}/wp-json/wc/v3/orders/${id}`, {
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch order ${id}: ${res.status}`);
  return res.json();
}

/**
 * Update an order (e.g. mark as completed). `body` is the WC order patch.
 */
export async function updateOrder(site, id, body) {
  const base = normalizeUrl(site.store_url);
  const res = await fetch(`${base}/wp-json/wc/v3/orders/${id}`, {
    method: "PUT",
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Failed to update order ${id}: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Add a note to an order. `customerNote` true => emails the customer.
 */
export async function addOrderNote(site, orderId, note, customerNote = false) {
  const base = normalizeUrl(site.store_url);
  const res = await fetch(`${base}/wp-json/wc/v3/orders/${orderId}/notes`, {
    method: "POST",
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ note, customer_note: customerNote }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Failed to add note: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch all notes for an order (for the order detail drawer).
 * Returns [] on failure (non-fatal).
 */
export async function fetchOrderNotes(site, orderId) {
  try {
    const base = normalizeUrl(site.store_url);
    const res = await fetch(`${base}/wp-json/wc/v3/orders/${orderId}/notes`, {
      headers: {
        Authorization: authHeader(site.consumer_key, site.consumer_secret),
        Accept: "application/json",
      },
    });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Count completed orders for a customer email (used for "repeat customer" badge).
 * Returns 0 on any failure (non-fatal).
 */
export async function fetchCustomerOrderCount(site, email) {
  if (!email) return 0;
  try {
    const base = normalizeUrl(site.store_url);
    const url = `${base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&status=completed&per_page=10`;
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(site.consumer_key, site.consumer_secret),
        Accept: "application/json",
      },
    });
    if (!res.ok) return 0;
    const list = await res.json();
    return Array.isArray(list)
      ? list.filter((o) => (o.billing?.email || "").toLowerCase() === email.toLowerCase()).length
      : 0;
  } catch {
    return 0;
  }
}

function extractAttributes(item) {
  if (!item.meta_data || item.meta_data.length === 0) return "";
  return item.meta_data
    .filter((m) => !m.key.startsWith("_") && (m.display_key || m.key) && (m.display_value ?? m.value))
    .map((m) => {
      const k = (m.display_key || m.key).replace(/^pa_/, "");
      const v = String(m.display_value ?? m.value).replace(/<[^>]+>/g, "");
      return `${k}: ${v}`;
    })
    .join(" | ");
}

const charMap = {
  "\u2018": "'", "\u2019": "'", "\u201A": ",", "\u201B": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
  "\u2032": "'", "\u2033": '"', "\u2034": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2026": "...", "\u00D7": "x", "\u2715": "x", "\u2716": "x",
  "\u2022": "*", "\u00A0": " ", "\u200B": "",
  "\u2122": "(TM)", "\u00AE": "(R)", "\u00A9": "(C)",
};

function formatAddress(order) {
  const a = order.shipping && (order.shipping.address_1 || order.shipping.city || order.shipping.postcode)
    ? order.shipping
    : order.billing;
  if (!a) return [];
  const name = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim();
  const company = a.company || "";
  const line1 = a.address_1 || "";
  const line2 = a.address_2 || "";
  const cityLine = [a.city, a.state, a.postcode].filter(Boolean).join(", ");
  const country = a.country || "";
  return [name, company, line1, line2, cityLine, country].filter((s) => s && s.trim());
}

function sanitize(input) {
  if (!input) return "";
  let out = "";
  for (const ch of input) {
    if (ch in charMap) { out += charMap[ch]; continue; }
    const code = ch.charCodeAt(0);
    if ((code >= 0x20 && code <= 0x7E) || (code >= 0xA0 && code <= 0xFF)) out += ch;
    else out += "?";
  }
  return out;
}

function shippingMethodTitle(order) {
  if (Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0) {
    return order.shipping_lines.map((s) => s.method_title).filter(Boolean).join(" + ");
  }
  return "";
}

/**
 * Generate a PDF in one of these formats:
 *  - "picking_a4":   warehouse picking slip (SKUs + attributes + qty), A4
 *  - "packing_a4":   customer-facing packing slip, A4 (no SKUs)
 *  - "packing_4x6":  customer-facing packing slip, 4x6" labels (one per order)
 *  - "shipping_4x6": Royal Mail-style shipping label, 4x6" (102x152 mm), one per order
 *  - "shipping_a6":  Address label sheet — 21 labels (60x40 mm) per A4, 3 cols x 7 rows
 *
 * Backwards-compat aliases:
 *  - "a4"       -> "picking_a4"
 *  - "label4x6" -> "packing_4x6"
 */
export async function generatePicklistPdf(groups, opts = {}) {
  const raw = opts.format || "picking_a4";
  const format = raw === "a4" ? "picking_a4" : raw === "label4x6" ? "packing_4x6" : raw;
  if (format === "shipping_4x6") return generateShippingLabelPdf(groups, { size: "4x6" });
  if (format === "shipping_a6") return generateAddressLabelSheetPdf(groups);
  if (format === "packing_4x6") return generate4x6Pdf(groups, { mode: "packing" });
  if (format === "packing_a4") return generateA4Pdf(groups, { mode: "packing" });
  return generateA4Pdf(groups, { mode: "picking" });
}

/**
 * Royal Mail-style shipping label. One label per page.
 * Sizes:
 *  - "4x6": 102 x 152 mm (288 x 432 pt)
 *  - "a6":  105 x 148 mm (297.64 x 419.53 pt) -- next smallest RM-approved size
 *
 * Layout: large recipient name + address (zoned, scannable from a distance),
 * sender block, postcode in oversized text, order ref + service.
 * NOTE: This is NOT a Royal Mail-issued label with their carrier barcode.
 * It is a clear shipping-address label suitable for hand-applied 2D barcodes
 * or use alongside a Click & Drop barcode sticker.
 */
async function generateShippingLabelPdf(groups, { size }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const wrapText = wrapTextFactory(font);

  // Page dimensions
  const pageWidth = size === "a6" ? 297.64 : 288;
  const pageHeight = size === "a6" ? 419.53 : 432;
  const margin = 14;
  const usableWidth = pageWidth - margin * 2;

  const flat = [];
  for (const group of groups) {
    const sortedOrders = [...group.orders].sort((a, b) => Number(a.number) - Number(b.number));
    for (const order of sortedOrders) flat.push({ site: group.site, order });
  }

  for (const { site, order } of flat) {
    const page = pdf.addPage([pageWidth, pageHeight]);

    // Outer border (helps cutting / alignment)
    page.drawRectangle({
      x: 4, y: 4, width: pageWidth - 8, height: pageHeight - 8,
      borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.5,
    });

    // ---- Header strip: site (sender) + service ----
    const headerHeight = 38;
    let y = pageHeight - margin;
    page.drawRectangle({
      x: margin, y: y - headerHeight, width: usableWidth, height: headerHeight,
      color: rgb(0.1, 0.1, 0.12),
    });
    page.drawText("FROM", {
      x: margin + 8, y: y - 12, size: 7, font: fontBold, color: rgb(0.65, 0.65, 0.7),
    });
    const senderName = sanitize(site.name).slice(0, 40);
    page.drawText(senderName, {
      x: margin + 8, y: y - 24, size: 11, font: fontBold, color: rgb(1, 1, 1),
    });
    const ship = sanitize(shippingMethodTitle(order)) || "Standard delivery";
    const shipShort = ship.length > 28 ? ship.slice(0, 27) + "..." : ship;
    const sw = font.widthOfTextAtSize(shipShort, 9);
    page.drawText(shipShort, {
      x: margin + usableWidth - sw - 8, y: y - 14, size: 9, font, color: rgb(0.85, 0.85, 0.9),
    });
    const ref = `Ref: #${order.number}`;
    const rw = font.widthOfTextAtSize(ref, 8);
    page.drawText(ref, {
      x: margin + usableWidth - rw - 8, y: y - 28, size: 8, font, color: rgb(0.7, 0.7, 0.75),
    });
    y -= headerHeight + 14;

    // ---- "DELIVER TO" label ----
    page.drawText("DELIVER TO", {
      x: margin, y, size: 8, font: fontBold, color: rgb(0.4, 0.4, 0.4),
    });
    y -= 14;

    // ---- Address block: name big, then lines, postcode oversized ----
    const a = order.shipping && (order.shipping.address_1 || order.shipping.city || order.shipping.postcode)
      ? order.shipping
      : (order.billing || {});
    const recipName = sanitize(`${a.first_name ?? ""} ${a.last_name ?? ""}`.trim()) || "Recipient";
    const company = sanitize(a.company || "");
    const line1 = sanitize(a.address_1 || "");
    const line2 = sanitize(a.address_2 || "");
    const cityState = sanitize([a.city, a.state].filter(Boolean).join(", "));
    const postcode = sanitize((a.postcode || "").toUpperCase());
    const country = sanitize(a.country || "");

    // Recipient name (bold, large)
    const nameLines = wrapText(recipName, usableWidth, 16, fontBold);
    for (const nl of nameLines) {
      page.drawText(nl, { x: margin, y: y - 14, size: 16, font: fontBold });
      y -= 18;
    }

    if (company) {
      const cl = wrapText(company, usableWidth, 11);
      for (const l of cl) {
        page.drawText(l, { x: margin, y: y - 11, size: 11, font, color: rgb(0.2, 0.2, 0.2) });
        y -= 14;
      }
    }

    for (const line of [line1, line2, cityState].filter(Boolean)) {
      const wrapped = wrapText(line, usableWidth, 12);
      for (const wl of wrapped) {
        page.drawText(wl, { x: margin, y: y - 12, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
        y -= 15;
      }
    }

    y -= 6;

    // Postcode — oversized, bold (scannable / sortable)
    if (postcode) {
      const pcSize = postcode.length > 8 ? 22 : 26;
      const pcWidth = fontBold.widthOfTextAtSize(postcode, pcSize);
      // Light background bar behind postcode
      page.drawRectangle({
        x: margin, y: y - pcSize - 4, width: usableWidth, height: pcSize + 8,
        color: rgb(0.96, 0.96, 0.98),
      });
      page.drawText(postcode, {
        x: margin + (usableWidth - pcWidth) / 2,
        y: y - pcSize + 2,
        size: pcSize, font: fontBold, color: rgb(0, 0, 0),
      });
      y -= pcSize + 12;
    }

    if (country) {
      const cw = fontBold.widthOfTextAtSize(country.toUpperCase(), 11);
      page.drawText(country.toUpperCase(), {
        x: margin + (usableWidth - cw) / 2, y: y - 11,
        size: 11, font: fontBold, color: rgb(0.15, 0.15, 0.15),
      });
      y -= 16;
    }

    // ---- Footer: order summary ----
    const itemTotal = order.line_items.reduce((s, li) => s + li.quantity, 0);
    const footerY = margin + 14;
    page.drawLine({
      start: { x: margin, y: footerY + 14 }, end: { x: margin + usableWidth, y: footerY + 14 },
      thickness: 0.4, color: rgb(0.7, 0.7, 0.7),
    });
    const left = `Order #${order.number}  -  ${order.line_items.length} lines  -  ${itemTotal} items`;
    page.drawText(sanitize(left), {
      x: margin, y: footerY, size: 8, font, color: rgb(0.4, 0.4, 0.4),
    });
    const dateStr = new Date(order.date_created).toLocaleDateString("en-GB");
    const dw = font.widthOfTextAtSize(dateStr, 8);
    page.drawText(dateStr, {
      x: margin + usableWidth - dw, y: footerY, size: 8, font, color: rgb(0.4, 0.4, 0.4),
    });
  }

  return Buffer.from(await pdf.save());
}

/**
 * Address label sheet — 21 labels per A4 page (3 cols x 7 rows), each 60x40 mm.
 * A4 = 210 x 297 mm. Side margins 15 mm, top/bottom margins 8.5 mm, no gutter.
 * Each label shows: recipient name (bold), address lines, postcode, country,
 * and order ref. Designed for self-adhesive label sheets.
 */
async function generateAddressLabelSheetPdf(groups) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const wrapText = wrapTextFactory(font);

  // mm -> pt
  const mm = (n) => (n * 72) / 25.4;
  const pageWidth = mm(210);
  const pageHeight = mm(297);
  const labelW = mm(60);
  const labelH = mm(40);
  const cols = 3;
  const rows = 7;
  const sideMargin = mm(15);   // (210 - 3*60) / 2
  const topMargin = mm(8.5);   // (297 - 7*40) / 2
  const padX = 4;              // inner padding pt
  const padY = 4;

  // Flatten all orders across groups
  const flat = [];
  for (const group of groups) {
    const sortedOrders = [...group.orders].sort((a, b) => Number(a.number) - Number(b.number));
    for (const order of sortedOrders) flat.push({ site: group.site, order });
  }

  if (flat.length === 0) {
    pdf.addPage([pageWidth, pageHeight]);
    return Buffer.from(await pdf.save());
  }

  let page = null;
  let slotIndex = 0;
  const slotsPerPage = cols * rows;

  for (const { order } of flat) {
    if (slotIndex % slotsPerPage === 0) {
      page = pdf.addPage([pageWidth, pageHeight]);
    }
    const slot = slotIndex % slotsPerPage;
    const col = slot % cols;
    const row = Math.floor(slot / cols);

    // Top-left corner of the label (PDF y is from bottom)
    const x0 = sideMargin + col * labelW;
    const yTop = pageHeight - topMargin - row * labelH;

    // Faint border (cut guide)
    page.drawRectangle({
      x: x0, y: yTop - labelH, width: labelW, height: labelH,
      borderColor: rgb(0.9, 0.9, 0.9), borderWidth: 0.3,
    });

    const innerW = labelW - padX * 2;
    let y = yTop - padY;

    // Address source
    const a = order.shipping && (order.shipping.address_1 || order.shipping.city || order.shipping.postcode)
      ? order.shipping
      : (order.billing || {});
    const recipName = sanitize(`${a.first_name ?? ""} ${a.last_name ?? ""}`.trim()) || "Recipient";
    const company = sanitize(a.company || "");
    const line1 = sanitize(a.address_1 || "");
    const line2 = sanitize(a.address_2 || "");
    const cityState = sanitize([a.city, a.state].filter(Boolean).join(", "));
    const postcode = sanitize((a.postcode || "").toUpperCase());
    const country = sanitize((a.country || "").toUpperCase());

    // Recipient name (bold, slightly larger)
    const nameLines = wrapText(recipName, innerW, 9, fontBold).slice(0, 2);
    for (const nl of nameLines) {
      page.drawText(nl, { x: x0 + padX, y: y - 9, size: 9, font: fontBold });
      y -= 11;
    }

    // Address lines (compact)
    const addrLines = [];
    if (company) addrLines.push(company);
    if (line1) addrLines.push(line1);
    if (line2) addrLines.push(line2);
    if (cityState) addrLines.push(cityState);

    for (const line of addrLines) {
      const wrapped = wrapText(line, innerW, 8).slice(0, 1);
      for (const wl of wrapped) {
        // Stop if we'd overflow the label
        if (y - 9 < yTop - labelH + 18) break;
        page.drawText(wl, { x: x0 + padX, y: y - 8, size: 8, font, color: rgb(0.1, 0.1, 0.1) });
        y -= 10;
      }
    }

    // Postcode (bold)
    if (postcode && y - 11 >= yTop - labelH + 14) {
      page.drawText(postcode, {
        x: x0 + padX, y: y - 10, size: 10, font: fontBold, color: rgb(0, 0, 0),
      });
      y -= 12;
    }

    // Country (small caps)
    if (country && y - 8 >= yTop - labelH + 12) {
      page.drawText(country, {
        x: x0 + padX, y: y - 8, size: 7, font: fontBold, color: rgb(0.25, 0.25, 0.25),
      });
    }

    // Order ref — bottom-right of label
    const ref = `#${order.number}`;
    const rw = font.widthOfTextAtSize(ref, 6);
    page.drawText(ref, {
      x: x0 + labelW - padX - rw,
      y: yTop - labelH + 4,
      size: 6, font, color: rgb(0.5, 0.5, 0.5),
    });

    slotIndex++;
  }

  return Buffer.from(await pdf.save());
}

function wrapTextFactory(font) {
  return function wrapText(text, maxWidth, size, f = font) {
    if (!text) return [""];
    const words = text.split(/\s+/);
    const lines = [];
    let current = "";
    for (const w of words) {
      const candidate = current ? `${current} ${w}` : w;
      if (f.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        if (f.widthOfTextAtSize(w, size) > maxWidth) {
          let buf = "";
          for (const ch of w) {
            if (f.widthOfTextAtSize(buf + ch, size) > maxWidth) { lines.push(buf); buf = ch; }
            else buf += ch;
          }
          current = buf;
        } else current = w;
      }
    }
    if (current) lines.push(current);
    return lines;
  };
}

async function generateA4Pdf(groups, { mode }) {
  const isPicking = mode === "picking";
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 40;
  const marginY = 50;
  const usableWidth = pageWidth - marginX * 2;
  const colItemW = usableWidth * (isPicking ? 0.42 : 0.62);
  const colAttrW = usableWidth * (isPicking ? 0.43 : 0.23);

  const newPage = () => {
    const p = pdf.addPage([pageWidth, pageHeight]);
    const original = p.drawText.bind(p);
    p.drawText = (text, opts) => original(sanitize(text), opts);
    return p;
  };
  const measure = (text, size, f = font) => f.widthOfTextAtSize(sanitize(text), size);
  const wrapText = wrapTextFactory(font);

  let page = newPage();
  let y = pageHeight - marginY;
  const totalOrders = groups.reduce((s, g) => s + g.orders.length, 0);

  const title = isPicking ? "Picking Slip" : "Packing Slip";
  page.drawText(title, { x: marginX, y, size: 16, font: fontBold });
  const summary = `${totalOrders} orders across ${groups.length} site(s)`;
  const sw = measure(summary, 10);
  page.drawText(summary, {
    x: marginX + usableWidth - sw, y: y + 2, size: 10, font, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 24;

  const ensureSpace = (needed) => {
    if (y - needed < marginY) { page = newPage(); y = pageHeight - marginY; }
  };

  for (const group of groups) {
    if (group.orders.length === 0) continue;

    ensureSpace(40);
    page.drawRectangle({
      x: marginX, y: y - 20, width: usableWidth, height: 24,
      color: rgb(0.15, 0.15, 0.2),
    });
    page.drawText(group.site.name, {
      x: marginX + 8, y: y - 13, size: 13, font: fontBold, color: rgb(1, 1, 1),
    });
    const countLabel = `${group.orders.length} orders`;
    const cw = measure(countLabel, 10);
    page.drawText(countLabel, {
      x: marginX + usableWidth - cw - 8, y: y - 12, size: 10, font, color: rgb(0.85, 0.85, 0.9),
    });
    y -= 32;

    const sortedOrders = [...group.orders].sort((a, b) => Number(a.number) - Number(b.number));

    for (const order of sortedOrders) {
      ensureSpace(60);
      const customer = `${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim();
      page.drawRectangle({
        x: marginX, y: y - 18, width: usableWidth, height: 22,
        color: rgb(0.93, 0.93, 0.96),
      });
      page.drawText(`Order #${order.number}`, {
        x: marginX + 6, y: y - 12, size: 12, font: fontBold,
      });
      if (customer) {
        const cWidth = measure(customer, 9);
        page.drawText(customer, {
          x: marginX + usableWidth - cWidth - 6, y: y - 11, size: 9, font, color: rgb(0.3, 0.3, 0.3),
        });
      }
      y -= 28;

      // Header row
      page.drawText("Item", { x: marginX, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      if (isPicking) {
        page.drawText("Attributes", { x: marginX + colItemW, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      } else {
        page.drawText("Options", { x: marginX + colItemW, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      }
      page.drawText("Qty", { x: marginX + colItemW + colAttrW, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      y -= 4;
      page.drawLine({
        start: { x: marginX, y }, end: { x: marginX + usableWidth, y },
        thickness: 0.5, color: rgb(0.7, 0.7, 0.7),
      });
      y -= 14;

      for (const item of order.line_items) {
        // Picking: include SKU. Packing: hide SKU.
        const nameRaw = isPicking && item.sku ? `${item.name}  [${item.sku}]` : item.name;
        const nameLines = wrapText(sanitize(nameRaw), colItemW - 6, 10);
        const attrLines = wrapText(sanitize(extractAttributes(item)), colAttrW - 6, 9);
        const lineCount = Math.max(nameLines.length, attrLines.length, 1);
        const lineHeight = 13;
        const topPad = 4;
        const bottomPad = 7;
        const rowHeight = topPad + lineCount * lineHeight + bottomPad;
        ensureSpace(rowHeight);

        const firstBaseline = y - topPad - 10;
        nameLines.forEach((l, idx) =>
          page.drawText(l, { x: marginX, y: firstBaseline - idx * lineHeight, size: 10, font })
        );
        attrLines.forEach((l, idx) =>
          page.drawText(l, { x: marginX + colItemW, y: firstBaseline - idx * lineHeight, size: 9, font, color: rgb(0.25, 0.25, 0.25) })
        );
        page.drawText(`x ${item.quantity}`, {
          x: marginX + colItemW + colAttrW, y: firstBaseline, size: 11, font: fontBold,
        });

        y -= rowHeight;
        page.drawLine({
          start: { x: marginX, y }, end: { x: marginX + usableWidth, y },
          thickness: 0.25, color: rgb(0.88, 0.88, 0.88),
        });
      }

      // Address block
      const addrLines = formatAddress(order);
      if (addrLines.length) {
        const addrHeight = addrLines.length * 11 + 18;
        ensureSpace(addrHeight);
        page.drawText("Ship to:", { x: marginX, y: y - 2, size: 8, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
        y -= 12;
        for (const line of addrLines) {
          page.drawText(sanitize(line), { x: marginX, y, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
          y -= 11;
        }
      }

      // Packing slip extras: shipping method
      if (!isPicking) {
        const ship = shippingMethodTitle(order);
        if (ship) {
          ensureSpace(14);
          page.drawText(`Shipping: ${ship}`, {
            x: marginX, y: y - 2, size: 8, font, color: rgb(0.4, 0.4, 0.4),
          });
          y -= 12;
        }
      }

      y -= 14;
    }
  }

  const totalPages = pdf.getPageCount();
  pdf.getPages().forEach((p, idx) => {
    const label = `Page ${idx + 1} of ${totalPages}`;
    const w = font.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: pageWidth - marginX - w, y: 24, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
  });

  return Buffer.from(await pdf.save());
}

/**
 * One order per 4x6" page. Used for packing slips (no SKUs).
 */
async function generate4x6Pdf(groups, { mode }) {
  const isPicking = mode === "picking"; // currently unused (packing only) but supports future
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const wrapText = wrapTextFactory(font);

  const pageWidth = 288;
  const pageHeight = 432;
  const margin = 12;
  const usableWidth = pageWidth - margin * 2;

  const flat = [];
  for (const group of groups) {
    const sortedOrders = [...group.orders].sort((a, b) => Number(a.number) - Number(b.number));
    for (const order of sortedOrders) flat.push({ site: group.site, order });
  }

  const drawHeader = (page, site, order, continued) => {
    let y = pageHeight - margin;
    page.drawText(sanitize(site.name), {
      x: margin, y: y - 10, size: 9, font, color: rgb(0.4, 0.4, 0.4),
    });
    y -= 14;
    const title = `#${order.number}${continued ? "  (cont.)" : ""}`;
    page.drawText(sanitize(title), {
      x: margin, y: y - 16, size: 18, font: fontBold,
    });
    y -= 22;
    const addrLines = continued ? [] : formatAddress(order);
    if (addrLines.length) {
      page.drawText(sanitize(addrLines[0]), {
        x: margin, y: y - 10, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.1),
      });
      y -= 13;
      for (let i = 1; i < addrLines.length; i++) {
        const wrapped = wrapText(sanitize(addrLines[i]), usableWidth, 9);
        for (const wl of wrapped) {
          page.drawText(wl, { x: margin, y: y - 9, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
          y -= 11;
        }
      }
      y -= 2;
    } else {
      const customer = `${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim();
      if (customer) {
        page.drawText(sanitize(customer), {
          x: margin, y: y - 10, size: 10, font, color: rgb(0.2, 0.2, 0.2),
        });
        y -= 14;
      }
    }
    const itemTotal = order.line_items.reduce((s, li) => s + li.quantity, 0);
    const ship = shippingMethodTitle(order);
    const meta = ship
      ? `${order.line_items.length} lines  -  ${itemTotal} items  -  ${ship}`
      : `${order.line_items.length} lines  -  ${itemTotal} items`;
    page.drawText(sanitize(meta), {
      x: margin, y: y - 9, size: 8, font, color: rgb(0.5, 0.5, 0.5),
    });
    y -= 14;
    page.drawLine({
      start: { x: margin, y }, end: { x: margin + usableWidth, y },
      thickness: 0.6, color: rgb(0.7, 0.7, 0.7),
    });
    y -= 12;
    return y;
  };

  for (const { site, order } of flat) {
    let page = pdf.addPage([pageWidth, pageHeight]);
    let y = drawHeader(page, site, order, false);
    const bottomLimit = margin + 8;
    const itemColW = usableWidth - 36;

    for (const item of order.line_items) {
      const nameRaw = isPicking && item.sku ? `${item.name}  [${item.sku}]` : item.name;
      const attrRaw = extractAttributes(item);
      const nameLines = wrapText(sanitize(nameRaw), itemColW, 9);
      const attrLines = attrRaw ? wrapText(sanitize(attrRaw), itemColW, 8) : [];
      const rowHeight = nameLines.length * 11 + attrLines.length * 10 + 6;

      if (y - rowHeight < bottomLimit) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = drawHeader(page, site, order, true);
      }

      nameLines.forEach((l, idx) => {
        page.drawText(sanitize(l), { x: margin, y: y - idx * 11, size: 9, font: fontBold });
      });
      const afterName = y - nameLines.length * 11;
      attrLines.forEach((l, idx) => {
        page.drawText(sanitize(l), {
          x: margin, y: afterName - idx * 10 + 2, size: 8, font, color: rgb(0.3, 0.3, 0.3),
        });
      });
      const qtyText = `x ${item.quantity}`;
      const qtyW = fontBold.widthOfTextAtSize(qtyText, 12);
      page.drawText(qtyText, {
        x: margin + usableWidth - qtyW, y, size: 12, font: fontBold,
      });

      y -= rowHeight;
      page.drawLine({
        start: { x: margin, y: y + 2 }, end: { x: margin + usableWidth, y: y + 2 },
        thickness: 0.25, color: rgb(0.9, 0.9, 0.9),
      });
    }
  }

  return Buffer.from(await pdf.save());
}
