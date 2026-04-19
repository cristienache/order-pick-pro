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
 */
export async function generatePicklistPdf(groups) {
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

  const wrapText = (text, maxWidth, size, f = font) => {
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

  for (const group of groups) {
    if (group.orders.length === 0) continue;

    // Site header
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
