

## Packeta Phase 2 — Carrier sync + country routing + label creation

### 1. Carrier catalog synced from Packeta

Packeta exposes a public JSON feed of all available carriers (home delivery + pickup-point chains) per country. The WC plugin pulls this once a day. We'll do the same.

- **New table** `packeta_carriers` (global, not per-user — it's a shared catalog):
  - `id` (Packeta carrier ID, integer PK), `name`, `country` (ISO-2), `currency`, `is_pickup_points` (bool), `supports_cod`, `supports_age_verification`, `max_weight_kg`, `disallows_cod`, `last_synced_at`
- **New module** `server/packetaCarriers.js`:
  - `fetchPacketaCarriers(apiPassword)` → calls Packeta's carrier feed (`https://www.zasilkovna.cz/api/v4/{apiPassword}/branch.json` for pickup chains, plus the carriers-list endpoint for home delivery), normalises into the table shape
  - `syncPacketaCarriers(userId)` → upserts into `packeta_carriers`, records `last_synced_at`
- **New routes**:
  - `POST /api/packeta/carriers/sync` → manual "Refresh now" button trigger; returns `{ count, last_synced_at }`
  - `GET /api/packeta/carriers?country=XX` → list carriers (optionally filtered by country) for the routing UI dropdowns
- **Daily auto-sync**: lightweight cron-on-request — when any user loads `/packeta` and the catalog is >24h old, kick off a background sync. (No real cron infrastructure needed for SQLite/Express; we just check `last_synced_at` on each request.)

### 2. Country routing (now driven by the synced catalog)

- **New table** `packeta_country_routes` (per-user):
  - `id`, `user_id`, `country` (ISO-2), `carrier_id` (FK into `packeta_carriers.id`), `default_weight_kg` (default 0.5), `default_value`, `sort_order`, `updated_at`
  - Unique on `(user_id, country)`
- **UI** on `/packeta`: a "Country routing" card with table + add/edit dialog. The carrier dropdown is populated from the synced catalog and filtered by the selected country. A "Refresh carrier list" button + "Last synced X minutes ago" status sits at the top of the card.
- CRUD routes: `GET/POST/PUT/DELETE /api/packeta/country-routes`

### 3. Per-order label creation (4×6" thermal)

- **New columns on `orders`** (idempotent migration): `packeta_tracking_number`, `packeta_packet_id`, `packeta_label_pdf_b64`, `packeta_label_created_at`
- **Server**: extend `packeta.js` with `createPacketaPacket(...)` → calls `createPacket` XML method; `getPacketaLabelPdf(...)` → calls `packetLabelPdf` with `format=A6 on A6` (≈ 4×6" thermal); `pickPacketaPickupPointId(order)` → reads WC Packeta plugin meta (`packetery_point_id`)
- **Routes**: `POST /api/packeta/orders/:orderId/label`, `GET /api/packeta/orders/:orderId/label.pdf`
- **UI**: "Create Packeta label (4×6")" button in the order drawer next to Royal Mail. Disabled with a tooltip when destination country isn't routed, or pickup-mode but no pickup point on the order. After creation: shows tracking + "Reprint" link.

### 4. Bulk label creation

- **Route**: `POST /api/packeta/orders/bulk-labels` → takes `{ orderIds: number[] }`, creates a packet for each, fetches the PDF for each, merges them into one PDF (using the existing `pdf-lib` dep already in `server/package.json`), returns the merged PDF.
- **UI**: extend the existing bulk-action bar on `/orders` (the one that already has bulk Royal Mail) with a **"Create Packeta labels"** option. Same merged-PDF flow, opens in a new tab.
- Skips orders that aren't routable and reports them in a toast summary ("Created 7, skipped 2: missing pickup point").

### Out of scope (future)
- Tracking number sync back to WooCommerce
- COD / insurance / weight overrides per order
- Pickup-point picker UI for orders that don't have one yet

Approve and I'll implement it as one batch (carrier sync table + module → country routes table → label columns → server module additions → routes → settings page UI → drawer button → bulk action).

