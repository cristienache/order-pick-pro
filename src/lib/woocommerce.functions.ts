import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// NOTE: must include www — the apex domain redirects, and fetch drops auth headers on redirects.
const STORE_URL = "https://www.ultraskins.co.uk";

function authHeader() {
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error("WooCommerce API credentials are not configured.");
  }
  const token = Buffer.from(`${key}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

export type WooLineItem = {
  id: number;
  name: string;
  quantity: number;
  sku: string;
  meta_data: Array<{ key: string; value: string; display_key?: string; display_value?: string }>;
};

export type WooOrder = {
  id: number;
  number: string;
  status: string;
  date_created: string;
  total: string;
  currency: string;
  billing: { first_name: string; last_name: string };
  line_items: WooLineItem[];
};

export const fetchProcessingOrders = createServerFn({ method: "GET" }).handler(async () => {
  const orders: WooOrder[] = [];
  let page = 1;
  const perPage = 100;

  // Fetch up to 5 pages (500 orders) defensively
  while (page <= 5) {
    const url = `${STORE_URL}/wp-json/wc/v3/orders?status=processing&per_page=${perPage}&page=${page}&orderby=date&order=asc`;
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WooCommerce API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const batch = (await res.json()) as WooOrder[];
    orders.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }

  // Strip down payload sent to client
  return {
    orders: orders.map((o) => ({
      id: o.id,
      number: o.number,
      date_created: o.date_created,
      total: o.total,
      currency: o.currency,
      customer: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim(),
      itemCount: o.line_items.reduce((sum, li) => sum + li.quantity, 0),
      lineCount: o.line_items.length,
    })),
  };
});

const PicklistInput = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(500),
});

function extractAttributes(item: WooLineItem): string {
  if (!item.meta_data || item.meta_data.length === 0) return "";
  const visible = item.meta_data.filter(
    (m) => !m.key.startsWith("_") && (m.display_key || m.key) && (m.display_value ?? m.value),
  );
  return visible
    .map((m) => {
      const k = (m.display_key || m.key).replace(/^pa_/, "");
      const v = String(m.display_value ?? m.value).replace(/<[^>]+>/g, "");
      return `${k}: ${v}`;
    })
    .join(" | ");
}

export const generatePicklistPdf = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => PicklistInput.parse(input))
  .handler(async ({ data }) => {
    // Fetch each selected order in parallel (chunked to avoid hammering)
    const orders: WooOrder[] = [];
    const chunkSize = 5;
    for (let i = 0; i < data.orderIds.length; i += chunkSize) {
      const chunk = data.orderIds.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (id) => {
          const res = await fetch(`${STORE_URL}/wp-json/wc/v3/orders/${id}`, {
            headers: { Authorization: authHeader(), Accept: "application/json" },
          });
          if (!res.ok) {
            throw new Error(`Failed to fetch order ${id}: ${res.status}`);
          }
          return (await res.json()) as WooOrder;
        }),
      );
      orders.push(...results);
    }

    // Sort by order number ascending
    orders.sort((a, b) => Number(a.number) - Number(b.number));

    // Build PDF
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 595.28; // A4
    const pageHeight = 841.89;
    const marginX = 40;
    const marginY = 50;
    const usableWidth = pageWidth - marginX * 2;

    // Column layout: Item / Attributes / Qty
    const colItemW = usableWidth * 0.42;
    const colAttrW = usableWidth * 0.43;
    const colQtyW = usableWidth * 0.15;

    let page = pdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - marginY;

    const generatedAt = new Date().toLocaleString("en-GB", {
      timeZone: "Europe/London",
      dateStyle: "medium",
      timeStyle: "short",
    });

    const drawHeader = () => {
      page.drawText("Ultraskins Picklist", { x: marginX, y, size: 16, font: fontBold, color: rgb(0, 0, 0) });
      page.drawText(`Generated ${generatedAt}  •  ${orders.length} orders`, {
        x: marginX,
        y: y - 16,
        size: 9,
        font,
        color: rgb(0.35, 0.35, 0.35),
      });
      y -= 36;
    };
    drawHeader();

    const ensureSpace = (needed: number) => {
      if (y - needed < marginY) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - marginY;
      }
    };

    // Word-wrap helper
    const wrapText = (text: string, maxWidth: number, size: number, f = font): string[] => {
      if (!text) return [""];
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let current = "";
      for (const w of words) {
        const candidate = current ? `${current} ${w}` : w;
        if (f.widthOfTextAtSize(candidate, size) <= maxWidth) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          // Word itself too long? hard split
          if (f.widthOfTextAtSize(w, size) > maxWidth) {
            let buf = "";
            for (const ch of w) {
              if (f.widthOfTextAtSize(buf + ch, size) > maxWidth) {
                lines.push(buf);
                buf = ch;
              } else {
                buf += ch;
              }
            }
            current = buf;
          } else {
            current = w;
          }
        }
      }
      if (current) lines.push(current);
      return lines;
    };

    for (const order of orders) {
      ensureSpace(60);

      // Order header bar
      const customer = `${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim();
      page.drawRectangle({
        x: marginX,
        y: y - 18,
        width: usableWidth,
        height: 22,
        color: rgb(0.93, 0.93, 0.96),
      });
      page.drawText(`Order #${order.number}`, {
        x: marginX + 6,
        y: y - 12,
        size: 12,
        font: fontBold,
      });
      if (customer) {
        const cText = customer;
        const cWidth = font.widthOfTextAtSize(cText, 9);
        page.drawText(cText, {
          x: marginX + usableWidth - cWidth - 6,
          y: y - 11,
          size: 9,
          font,
          color: rgb(0.3, 0.3, 0.3),
        });
      }
      y -= 28;

      // Column headers
      page.drawText("Item", { x: marginX, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      page.drawText("Attributes", { x: marginX + colItemW, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      page.drawText("Qty", {
        x: marginX + colItemW + colAttrW,
        y,
        size: 9,
        font: fontBold,
        color: rgb(0.4, 0.4, 0.4),
      });
      y -= 4;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: marginX + usableWidth, y },
        thickness: 0.5,
        color: rgb(0.7, 0.7, 0.7),
      });
      y -= 10;

      for (const item of order.line_items) {
        const nameText = item.sku ? `${item.name}  [${item.sku}]` : item.name;
        const attrText = extractAttributes(item);
        const nameLines = wrapText(nameText, colItemW - 6, 10);
        const attrLines = wrapText(attrText, colAttrW - 6, 9);
        const lineCount = Math.max(nameLines.length, attrLines.length, 1);
        const rowHeight = lineCount * 12 + 6;

        ensureSpace(rowHeight);

        // Item name
        nameLines.forEach((l, idx) => {
          page.drawText(l, {
            x: marginX,
            y: y - idx * 12,
            size: 10,
            font,
          });
        });
        // Attributes
        attrLines.forEach((l, idx) => {
          page.drawText(l, {
            x: marginX + colItemW,
            y: y - idx * 12,
            size: 9,
            font,
            color: rgb(0.25, 0.25, 0.25),
          });
        });
        // Qty
        page.drawText(`× ${item.quantity}`, {
          x: marginX + colItemW + colAttrW,
          y,
          size: 11,
          font: fontBold,
        });

        y -= rowHeight;
        // Light divider
        page.drawLine({
          start: { x: marginX, y: y + 2 },
          end: { x: marginX + usableWidth, y: y + 2 },
          thickness: 0.25,
          color: rgb(0.88, 0.88, 0.88),
        });
      }

      y -= 14;
    }

    // Page numbers
    const totalPages = pdf.getPageCount();
    pdf.getPages().forEach((p, idx) => {
      const label = `Page ${idx + 1} of ${totalPages}`;
      const w = font.widthOfTextAtSize(label, 8);
      p.drawText(label, {
        x: pageWidth - marginX - w,
        y: 24,
        size: 8,
        font,
        color: rgb(0.5, 0.5, 0.5),
      });
    });

    const bytes = await pdf.save();
    const base64 = Buffer.from(bytes).toString("base64");
    return { base64, filename: `picklist-${new Date().toISOString().slice(0, 10)}.pdf` };
  });
