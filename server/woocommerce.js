import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function authHeader(key, secret) {
  const token = Buffer.from(`${key}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

export async function fetchProcessingOrders(site) {
  const orders = [];
  let page = 1;
  const perPage = 100;
  const base = normalizeUrl(site.store_url);

  while (page <= 5) {
    const url = `${base}/wp-json/wc/v3/orders?status=processing&per_page=${perPage}&page=${page}&orderby=date&order=asc`;
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
 * Generate a picklist PDF.
 * @param {Array<{site: object, orders: Array}>} groups - one entry per site
 * @param {{format?: "a4" | "label4x6"}} [opts]
 */
export async function generatePicklistPdf(groups, opts = {}) {
  const format = opts.format || "a4";
  if (format === "label4x6") return generateLabelPdf(groups);
  return generateA4Pdf(groups);
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

async function generateA4Pdf(groups) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 40;
  const marginY = 50;
  const usableWidth = pageWidth - marginX * 2;
  const colItemW = usableWidth * 0.42;
  const colAttrW = usableWidth * 0.43;

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
  const generatedAt = new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short",
  });

  page.drawText("Picklist", { x: marginX, y, size: 16, font: fontBold });
  page.drawText(`Generated ${generatedAt}  -  ${totalOrders} orders across ${groups.length} site(s)`, {
    x: marginX, y: y - 16, size: 9, font, color: rgb(0.35, 0.35, 0.35),
  });
  y -= 36;

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

      page.drawText("Item", { x: marginX, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      page.drawText("Attributes", { x: marginX + colItemW, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      page.drawText("Qty", { x: marginX + colItemW + colAttrW, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      y -= 4;
      page.drawLine({
        start: { x: marginX, y }, end: { x: marginX + usableWidth, y },
        thickness: 0.5, color: rgb(0.7, 0.7, 0.7),
      });
      y -= 10;

      for (const item of order.line_items) {
        const nameRaw = item.sku ? `${item.name}  [${item.sku}]` : item.name;
        const nameLines = wrapText(sanitize(nameRaw), colItemW - 6, 10);
        const attrLines = wrapText(sanitize(extractAttributes(item)), colAttrW - 6, 9);
        const lineCount = Math.max(nameLines.length, attrLines.length, 1);
        const rowHeight = lineCount * 12 + 6;
        ensureSpace(rowHeight);

        nameLines.forEach((l, idx) => page.drawText(l, { x: marginX, y: y - idx * 12, size: 10, font }));
        attrLines.forEach((l, idx) => page.drawText(l, { x: marginX + colItemW, y: y - idx * 12, size: 9, font, color: rgb(0.25, 0.25, 0.25) }));
        page.drawText(`x ${item.quantity}`, { x: marginX + colItemW + colAttrW, y, size: 11, font: fontBold });

        y -= rowHeight;
        page.drawLine({
          start: { x: marginX, y: y + 2 }, end: { x: marginX + usableWidth, y: y + 2 },
          thickness: 0.25, color: rgb(0.88, 0.88, 0.88),
        });
      }
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
 * One order per 4x6" page (288 x 432 pt).
 * If an order has too many items to fit, it overflows onto additional 4x6 pages
 * with a "(cont.)" header.
 */
async function generateLabelPdf(groups) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const wrapText = wrapTextFactory(font);

  const pageWidth = 288;   // 4 inch
  const pageHeight = 432;  // 6 inch
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
    const meta = `${order.line_items.length} lines  -  ${itemTotal} items`;
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
    const itemColW = usableWidth - 36; // reserve right gutter for qty

    for (const item of order.line_items) {
      const nameRaw = item.sku ? `${item.name}  [${item.sku}]` : item.name;
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
