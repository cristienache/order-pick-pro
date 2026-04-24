

## Why the numbers differ from WooCommerce

HeyShop is currently using its **fallback "order scan"** path (the warnings on the page confirm this). That path sums each order's `total` field, which is what the customer actually paid — **including shipping and tax**. WooCommerce's native Analytics page reports **Gross sales** and **Net sales** using a different definition: line-item subtotals **excluding shipping, tax, and refunds** (Net sales also excludes coupons).

That definition mismatch is the main reason your MTD reads as £5,413 in HeyShop but £2,944 / £2,848 in WooCommerce. A second contributor: the fallback also includes `on-hold` and `refunded` orders, which Woo Analytics excludes from headline revenue.

## Plan — make HeyShop revenue match WooCommerce Analytics

### 1. Use the same calculation Woo uses (in `server/wc-analytics.js`)

Replace the current `summarizeOrders` + revenue bucketing with a Woo-Analytics-equivalent breakdown. For every order, compute these fields by walking `line_items`, `shipping_lines`, `tax_lines`, `fee_lines`, `coupon_lines`, plus the order's refunds:

| Field | Formula | Matches Woo column |
|---|---|---|
| Gross sales | Σ `line_item.subtotal` (pre-discount, ex tax/shipping) | Gross sales |
| Coupons | Σ `coupon_lines.discount` | Coupons |
| Refunds | Σ refunded line-item amounts (fetch from `wc/v3/orders/{id}/refunds`) | Returns |
| Net sales | Gross − Coupons − Refunds | Net sales |
| Shipping | Σ `shipping_lines.total` | Shipping |
| Taxes | Σ `tax_lines.tax_total` + `shipping_tax_total` | Taxes |
| Total sales | Net + Shipping + Taxes + Fees | Total sales |

Switch the displayed "Revenue" KPI to **Net sales** by default (this is what Woo's Revenue tab shows as the headline). Show Gross / Refunds / Coupons / Shipping / Taxes / Total alongside it as Woo does.

### 2. Match Woo's status filter

Restrict revenue calculation to orders in `processing` and `completed` only (Woo's `actionable_statuses` default). Drop `on-hold` and `refunded` from the revenue scan. Keep them visible in the Orders-by-status donut, but they don't count toward revenue.

### 3. Fetch refunds correctly

`order.total_refund` is unreliable. Add `wc/v3/orders/{id}/refunds` lookups for orders that have `refunds.length > 0` in the listing payload, and sum those refund line-item amounts. Cached per order so re-loads are cheap.

### 4. Prefer wc-analytics' own breakdown when available

When `wc-analytics/reports/revenue/stats` works, read `totals.gross_sales`, `totals.net_revenue`, `totals.coupons`, `totals.refunds`, `totals.shipping`, `totals.taxes`, `totals.total_sales` directly — these already match the Woo UI exactly. Only fall through to the order scan when wc-analytics truly isn't available.

### 5. UI updates (`src/routes/analytics.tsx`)

- Re-label the headline KPI **Net sales** (was "Revenue").
- Add a **Revenue breakdown card** mirroring Woo's layout: Gross sales, Returns, Coupons, Net sales / Taxes, Shipping, Total sales — each with the period-over-period delta chip.
- Add a small `(?)` tooltip next to each metric explaining the formula, so users can reconcile against Woo.
- Keep the warning banner, but only show it when the breakdown actually came from the fallback path.

### 6. Cache invalidation

Bump the in-memory cache key in `server/index.js` for the analytics endpoints (e.g. `v2:` prefix) so the existing 60-second cached `£5,413` value is dropped immediately on deploy.

### Files touched

- `server/wc-analytics.js` — rewrite revenue calc per the table above; add refunds fetch; restrict statuses; expose breakdown fields.
- `server/index.js` — extend `/api/analytics/overview` response shape with the breakdown; bump cache key.
- `src/lib/analytics-api.ts` — add the new breakdown fields to the `Overview` type.
- `src/routes/analytics.tsx` — rename KPI, add breakdown card, add tooltips, gate the warning banner.

### Result

With these changes, HeyShop's MTD Net sales for the same store should read **£2,848.87** (matching Woo's Net sales) and Gross sales should read **£2,944.66**, with Returns / Coupons / Shipping / Taxes / Total sales all matching the WooCommerce Revenue report row-for-row.

