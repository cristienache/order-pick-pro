## How to remove a Sale Price (today, and how to make it easier)

### Current behaviour

Removing a sale price is already wired end-to-end — it just isn't discoverable:

- **Per row**: clear the **Sale price** input cell on the product row, then click **Save locally**, then **Push to WooCommerce**. The empty cell is sent to WC as `sale_price: ""`, which is the WC REST convention for "no sale price". WC also clears `date_on_sale_from/to` automatically.
- **Variable products**: clearing the parent's sale_price field cascades into every variation via the existing "Copy to variations" flow. You then push the parent (variations come along automatically because they're now dirty).

But the **Bulk edit** popover only has Set / +% / −% / +amt / −amt / Round — there's no "Clear" mode. So there's no one-click way to remove sale prices across many selected rows. That's the gap.

### Plan

#### 1. Add a "Clear sale price" bulk operation

In `src/components/inventory/wc-bulk-panel.tsx`:

- Add a new mode `"clear"` to the price tab's Operation dropdown, labelled **Clear sale price** (only selectable when Field = Sale price; auto-switches Field to `sale_price` if user picked it while on Regular price, or hide the option for Regular price since clearing a regular price isn't valid in WC).
- When `mode === "clear"`, hide the Value input and change the Apply button to **Clear sale price on N rows**.
- Emit `{ kind: "price", field: "sale_price", mode: "clear", value: 0 }`.

In `src/routes/inventory.woo.tsx`, extend the bulk apply switch to handle `mode === "clear"` by setting the draft's `sale_price` to `""` (the existing diff logic already turns `""` into `null` → WC `""`).

#### 2. Add a small inline "×" clear affordance on the per-row Sale price cell

In the inventory grid (`inventory.woo.tsx`, row Sale price cell ~line 812), when the cell has a non-empty value, render a tiny ✕ button inside the input that one-clicks the field back to `""`. Keeps the row workflow obvious without touching the rest of the editor.

#### 3. Tooltip / helper text

Add a short helper under the Sale price column header (or a tooltip on the new ✕): "Empty = no sale price. Save locally then Push to WooCommerce to remove the sale on WC."

#### 4. No backend changes needed

`server/oms-woo.js` already:
- Stores `null` when an empty sale_price is saved locally (PATCH `/products/bulk`).
- On push, sends `sale_price: ""` to WC when the local value is `null`, which is exactly what WC expects to clear a sale.
- Includes `sale_price` in `dirty_fields`, so the row will actually push (no "already in sync" error).

So the entire fix is UI-only.

### Files touched

- `src/components/inventory/wc-bulk-panel.tsx` — add `clear` mode, conditional UI, restrict to sale_price field.
- `src/routes/inventory.woo.tsx` — handle `mode === "clear"` in the bulk apply reducer; add inline ✕ on the per-row Sale price input.

### Result

Three ways to remove a sale price, in order of speed:

1. **One row** — click the ✕ inside the Sale price cell → Save locally → Push.
2. **Many rows** — select rows → Bulk edit → Price tab → Field: Sale price → Operation: **Clear sale price** → Apply → Save locally → Push.
3. **All variations of a product** — clear the variable parent's Sale price field → use Copy to variations → Save locally → Push the parent (children come along).
