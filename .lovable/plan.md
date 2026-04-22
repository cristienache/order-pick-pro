

## Fixes for orders workspace

Five distinct issues, all in the orders flow. Brief and tightly scoped.

### 1. "Print unprinted" stuck in loading state

**Cause**: `printPdfBlob` only resolves when the user closes the print dialog (`afterprint`) or after a 10-minute safety timeout. Because `printUnprinted` awaits it before clearing `printingUnprinted`, the button spins until then.

**Fix** (`src/routes/orders.tsx`):
- Reset `setPrintingUnprinted(false)` immediately after `apiBlob` returns and the print dialog has been triggered — don't await `printPdfBlob`'s settle.
- Run `markShipmentsPrinted` + `refreshShipments` + `loadOrders(true)` in parallel without holding the spinner.
- Apply the same fix in `bulk-royal-mail-dialog.tsx` `printIds` (same bug pattern with `busy`).

### 2. & 5. Printed orders not marked Completed in UI

**Cause**: After `markShipmentsPrinted`, the server PUTs WooCommerce to `status: "completed"`, but `loadOrders(true)` re-fetches with the current `statuses` filter (default `["processing"]`). The completed order either drops out of view or shows stale `processing` from cache before refresh finishes.

Additionally, individual WC `updateOrder` failures are only returned in `completionErrors` and silently warned about. We need surfaced visibility.

**Fix**:
- After `markShipmentsPrinted` resolves, if `completionErrors.length > 0`, toast the first error message (not just a count) so the user knows which order failed and why.
- In `loadOrders` after a print: temporarily union `["completed"]` into the fetch statuses so the just-completed orders re-appear with their new status. Implementation: pass an optional `extraStatuses` arg to `loadOrders`, called as `loadOrders(true, ["completed"])` from the print handlers. The user-facing status filter UI is unchanged.
- The "Completed" badge already renders when `o.status === "completed"`, so the row will visibly flip once reloaded.

### 3. "Europe" badge for EU orders

**Cause**: `OrderRow` doesn't carry the recipient country.

**Fix**:
- `server/index.js` `/api/sites/:id/orders`: add `shipping_country: o.shipping?.country || o.billing?.country || ""` to the row mapper.
- `src/lib/orders.ts`: add `shipping_country: string` to `OrderRow`. Add an `EU_COUNTRIES` set (27 ISO-2 codes) and `isEuropeOrder(o)` helper. Domestic GB excluded.
- `src/routes/orders.tsx`: render an indigo "Europe" badge next to the Printed/Label-ready badges when `isEuropeOrder(o)` is true, with tooltip "Print this label outside Ultrax".

### 4. Today's revenue must include Completed orders

**Cause**: Stats are computed from `ordersBySite`, which only contains the statuses the user loaded (default processing).

**Fix**:
- Add a dedicated lightweight endpoint `GET /api/stats/today` in `server/index.js` that, for every site the user owns, fetches today's processing + completed orders (date-bounded, current day), returns `{ count, revenue_by_currency }`.
- `src/routes/orders.tsx`: fetch this on mount and after every `loadOrders` / `markShipmentsPrinted` call. Convert each currency to GBP via existing `toGbp` and feed the "Today's orders" + "Today's revenue" stat cards from this dataset instead of the in-view rows.
- "Backlog" and "Aging > 24h" stay sourced from the in-view processing rows (they're queue indicators, not historical totals).

### Files touched

- `server/index.js` — add `shipping_country` to orders mapper; add `/api/stats/today`; surface first completion error message.
- `src/lib/orders.ts` — `shipping_country` field, EU helper.
- `src/lib/api.ts` — type the new stats endpoint response.
- `src/routes/orders.tsx` — fix spinner, EU badge, stats wiring, post-print reload includes completed.
- `src/components/bulk-royal-mail-dialog.tsx` — same spinner fix in `printIds`.

### Acceptance

- Click "Print unprinted" → print dialog opens, button stops spinning within ~1s, table reloads showing those orders as Completed (green badge).
- Bulk create + auto-print → same behaviour.
- An order shipping to FR/DE/IT shows an indigo "Europe" badge.
- Today's revenue card shows the sum of today's processing + completed orders even when the status filter is "processing only".
- If WC fails to mark an order completed, the toast shows the actual error (not just a count).

