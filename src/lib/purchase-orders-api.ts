// HeyShop Purchase Orders client — talks to /api/oms/{suppliers,purchase-orders}.
import { api, apiBlob } from "./api";

export type Supplier = {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SupplierInput = Omit<
  Supplier, "id" | "created_at" | "updated_at"
> & { id?: string };

export type PoStatus = "draft" | "sent" | "partial" | "received" | "cancelled";

export type PoLine = {
  id: string;
  po_id: string;
  product_id: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  received_quantity: number;
  unit_cost: number;
  sort_order: number;
};

export type PoLineInput = {
  id?: string;
  product_id?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  unit_cost: number;
};

export type PoTotals = {
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
};

export type PurchaseOrder = {
  id: string;
  user_id: number;
  po_number: string;
  supplier_id: string;
  warehouse_id: string | null;
  status: PoStatus;
  currency: string;
  expected_at: string | null;
  notes: string | null;
  shipping_cost: number;
  tax_rate: number;
  created_at: string;
  updated_at: string;
  supplier: Supplier | null;
  warehouse: { id: string; name: string; code: string; address: string | null } | null;
  lines: PoLine[];
  totals: PoTotals;
};

export type PoListItem = {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_name: string;
  status: PoStatus;
  currency: string;
  expected_at: string | null;
  warehouse_id: string | null;
  shipping_cost: number;
  tax_rate: number;
  line_count: number;
  subtotal: number;
  total: number;
  created_at: string;
  updated_at: string;
};

export type CreatePoInput = {
  supplier_id: string;
  warehouse_id?: string | null;
  currency?: string;
  expected_at?: string | null;
  notes?: string | null;
  shipping_cost?: number;
  tax_rate?: number;
  lines?: PoLineInput[];
};

export type ReceiveInput = {
  warehouse_id?: string;
  receipts: { line_id: string; quantity: number }[];
};

export const poApi = {
  suppliers: {
    list: () => api<Supplier[]>("/api/oms/suppliers"),
    create: (body: SupplierInput) =>
      api<Supplier>("/api/oms/suppliers", { method: "POST", body }),
    update: (id: string, body: Partial<SupplierInput>) =>
      api<Supplier>(`/api/oms/suppliers/${id}`, { method: "PUT", body }),
    remove: (id: string) =>
      api<{ ok: true }>(`/api/oms/suppliers/${id}`, { method: "DELETE" }),
  },
  pos: {
    list: () => api<PoListItem[]>("/api/oms/purchase-orders"),
    get: (id: string) => api<PurchaseOrder>(`/api/oms/purchase-orders/${id}`),
    create: (body: CreatePoInput) =>
      api<PurchaseOrder>("/api/oms/purchase-orders", { method: "POST", body }),
    update: (id: string, body: Partial<CreatePoInput>) =>
      api<PurchaseOrder>(`/api/oms/purchase-orders/${id}`, { method: "PUT", body }),
    send: (id: string) =>
      api<PurchaseOrder>(`/api/oms/purchase-orders/${id}/send`, { method: "POST" }),
    cancel: (id: string) =>
      api<PurchaseOrder>(`/api/oms/purchase-orders/${id}/cancel`, { method: "POST" }),
    receive: (id: string, body: ReceiveInput) =>
      api<PurchaseOrder>(`/api/oms/purchase-orders/${id}/receive`, {
        method: "POST", body,
      }),
    pdfBlob: (id: string) => apiBlob(`/api/oms/purchase-orders/${id}/pdf`),
  },
};

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  partial: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};
