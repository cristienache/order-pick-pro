

## Goal
Two improvements to the dashboard area:
1. **Editable, drag-rearrangeable dashboard** with a real schedule (to-do for the day).
2. **New Analytics module** at `/analytics` powered by WooCommerce's `wc-analytics` REST API — proper Reports & Analytics, not placeholder bars.

---

## 1) Rearrangeable & editable dashboard

**Layout system.** Replace the fixed `<section>` grid in `src/routes/index.tsx` with a sortable grid using `@dnd-kit/sortable` (already installed). Each block (KPI Promo, Connected Stores, Orders Today, Total Items, Workspace, Activity, Schedule, Stores Strip, All Tools) becomes a `Panel` with an id.

**Edit mode.** Add an "Edit dashboard" toggle in the header toolbar. When on:
- Each panel shows a drag handle (top-right) and an eye/X to hide it.
- A "+ Add panel" menu lists hidden panels so users can re-add them.
- "Reset layout" restores defaults.
- "Done" exits edit mode and persists.

**Persistence.** Store `{ order: string[], hidden: string[] }` per user in `localStorage` under `ultrax_dashboard_layout_v1`. (Server-side persistence is out of scope for this round — local is fast, private, and matches the per-user model.)

**Schedule panel becomes a real to-do for today.**
- List of tasks with: title, optional time (HH:mm), tag (Orders / Shipping / Inventory / Custom), done checkbox.
- Inline "Add task" input + time picker + tag select.
- Edit (pencil) and delete (X) on each row.
- Auto-sort: incomplete first by time, then completed (struck through) at the bottom.
- "Today" header shows current date and "X of Y done" progress bar.
- Persisted in `localStorage` under `ultrax_today_tasks_YYYY-MM-DD` (rolls over each day; previous days auto-archive client-side).
- Seed defaults on first load (Process new orders, Generate labels, Review low-stock SKUs) — user can delete them.

---

## 2) Analytics module (`/analytics`)

**Backend — new endpoints in `server/index.js`** (per-user, scoped via `loadSiteWithKeys`):

| Endpoint | Wraps WC | Returns |
|---|---|---|
| `GET /api/analytics/overview?from&to&site_ids` | `wc-analytics/reports/performance-indicators` for each site | Aggregated KPIs: revenue, orders, items sold, avg order value, returning customer rate, refunds |
| `GET /api/analytics/revenue?from&to&interval&site_ids` | `wc-analytics/reports/revenue/stats?interval=day\|week\|month` | Time series `[{ date, revenue, orders, items }]` per site + combined |
| `GET /api/analytics/top-products?from&to&limit&site_ids` | `wc-analytics/reports/products?orderby=items_sold` | `[{ product_id, name, items_sold, net_revenue, site_name }]` |
| `GET /api/analytics/orders-stats?from&to&site_ids` | `wc-analytics/reports/orders/stats` | Status breakdown (processing / completed / refunded / cancelled) |
| `GET /api/analytics/customers?from&to&site_ids` | `wc-analytics/reports/customers/stats` | New vs returning, total customers |
| `GET /api/analytics/coupons?from&to&site_ids` | `wc-analytics/reports/coupons` | Top coupons used |

All endpoints:
- Convert non-base currencies into a single display currency (GBP) using existing `getFxRates()` from `server/fx.js`, while also returning the per-currency raw totals.
- Multi-site: fan out in parallel (like `/api/stats/today`), tolerate per-site failures, return a `warnings: [{ site_id, error }]` array.
- Cache the response in-memory for 60 seconds keyed on `(user_id, params)` to avoid hammering WC during quick re-clicks.

**Fallback.** If a store doesn't expose `wc-analytics` (older WooCommerce or disabled), automatically fall back to the legacy `wc/v3/reports/*` namespace (sales, top_sellers, orders/totals) and flag the site as "limited analytics" in the warnings.

**Frontend — new route `src/routes/analytics.tsx`:**

```text
┌─ Analytics ──────────────────────────── [Date range ▼] [Stores ▼] [Compare ▼] [Export CSV] ─┐
│                                                                                              │
│  KPI strip (6 cards):  Revenue · Orders · AOV · Items sold · New customers · Refund rate    │
│  Each card shows: value, currency, % vs previous period (green/red arrow), spark line       │
│                                                                                              │
│  ┌── Revenue over time (area/line chart) ─────────────┐  ┌── Orders by status (donut) ──┐   │
│  │  Toggle: Day / Week / Month                         │  │  Processing · Completed ·    │   │
│  │  Multi-store overlay (color per store)              │  │  Refunded · Cancelled        │   │
│  └─────────────────────────────────────────────────────┘  └──────────────────────────────┘   │
│                                                                                              │
│  ┌── Top products (table, top 10) ────────────────────┐  ┌── Customers (bar) ───────────┐   │
│  │  Product · Store · Items sold · Net revenue · Δ    │  │  New vs Returning over time  │   │
│  └─────────────────────────────────────────────────────┘  └──────────────────────────────┘   │
│                                                                                              │
│  ┌── Top coupons ────────────────────┐  ┌── Sales by store (stacked bar) ───────────────┐    │
│  └────────────────────────────────────┘  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Controls:**
- Date range (popover with Calendar) + quick presets: Today, 7d, 30d, MTD, QTD, YTD, Custom.
- Compare toggle: vs previous period / vs previous year.
- Store multi-select chip filter.
- Interval toggle (Day / Week / Month) for time-series charts.
- "Export CSV" downloads the current view's data.

**Charts.** Use the existing `recharts` setup via `@/components/ui/chart` (`ChartContainer`, `ChartTooltip`, `ChartLegend`). Suspense skeletons while loading; per-card error states (one chart failing doesn't blank the page).

**Navigation.** Add Analytics to:
- Sidebar in `src/components/app-shell.tsx` under "Operate" group with a `BarChart3` icon.
- Workspace tile + All Tools list on the dashboard (`TOOLS` array).
- Tool category gets a new `"Analytics"` entry added to `ALL_CATEGORIES`.

---

## Files touched

**New**
- `src/routes/analytics.tsx` — page + all chart cards.
- `src/lib/analytics-api.ts` — typed client for the 6 endpoints.
- `src/components/dashboard/sortable-panel.tsx` — drag wrapper.
- `src/components/dashboard/edit-toolbar.tsx` — edit-mode controls.
- `src/components/dashboard/today-schedule.tsx` — real to-do panel.
- `src/lib/dashboard-layout.ts` — localStorage helpers + defaults.
- `server/wc-analytics.js` — typed wrappers for `wc-analytics/reports/*` with fallback to `wc/v3/reports/*`.

**Modified**
- `src/routes/index.tsx` — wire panels through `DndContext` + `SortableContext`, gate by edit mode, swap Schedule for `<TodaySchedule />`, add Analytics to TOOLS.
- `src/components/app-shell.tsx` — add Analytics nav item.
- `server/index.js` — mount the 6 analytics routes (after the existing `/api/stats/today` block) with a tiny in-memory `Map`-based 60s cache.

No DB migrations required; no new dependencies.

---

## Risks & mitigations

- **`wc-analytics` namespace missing** on older WC installs → automatic fallback to `wc/v3/reports/*` per-site, surfaced as a warning chip in the UI.
- **Currency mixing** across stores → display in GBP (using cached FX) with a tooltip showing the original currency totals.
- **Slow WC requests** with many stores → per-site parallel fan-out + 60s server-side cache + optimistic skeleton UI.
- **Layout drift across browsers** → localStorage is per-device; "Reset layout" button always available.

