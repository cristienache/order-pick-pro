// Loader + thin wrapper around the official Packeta Widget v6.
// Docs: https://docs.packeta.com/v6/docs/widget-v6
//
// The widget is a vanilla JS library hosted by Packeta. It pops up a map +
// search UI and, on selection, returns a `Point` object describing the
// chosen pickup place (id, name, full address, carrier id, opening hours…).
// We need just the `id` (= addressId for createPacket) and `carrierId` so
// the rest of HeyShop's label flow keeps working.

const WIDGET_SRC = "https://widget.packeta.com/v6/www/js/library.js";

type PacketaPoint = {
  id: string | number;
  name?: string;
  street?: string;
  city?: string;
  zip?: string;
  country?: string;
  carrierId?: string | null;
  carrierPickupPointId?: string | null;
  // Many other fields exist; we only consume what we need.
};

type PacketaPickOptions = {
  appIdentity?: string;
  language?: string;
  country?: string; // ISO-2 — restrict to this country
  vendors?: { country: string; group?: string }[];
};

declare global {
  interface Window {
    Packeta?: {
      Widget?: {
        pick: (
          apiKey: string,
          callback: (point: PacketaPoint | null) => void,
          options?: PacketaPickOptions,
        ) => void;
      };
    };
  }
}

let loadPromise: Promise<void> | null = null;

function loadPacketaWidget(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Not in browser"));
  if (window.Packeta?.Widget?.pick) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGET_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Packeta widget")));
      return;
    }
    const s = document.createElement("script");
    s.src = WIDGET_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loadPromise = null;
      reject(new Error("Failed to load Packeta widget"));
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}

export type PickedPacketaPoint = {
  id: string;
  name: string | null;
  carrierId: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
};

/**
 * Open the Packeta pickup-point picker. Resolves to the chosen point, or
 * `null` if the user closed the widget without selecting one.
 *
 * `apiKey` is the user's Packeta Widget API key (NOT the API password).
 */
export async function openPacketaPicker(
  apiKey: string,
  options: { country?: string; language?: string } = {},
): Promise<PickedPacketaPoint | null> {
  await loadPacketaWidget();
  const pick = window.Packeta?.Widget?.pick;
  if (!pick) throw new Error("Packeta widget failed to initialise");

  return new Promise((resolve) => {
    pick(
      apiKey,
      (point) => {
        if (!point || point.id == null) return resolve(null);
        resolve({
          id: String(point.id),
          name: point.name ?? null,
          carrierId: point.carrierId ? String(point.carrierId) : null,
          street: point.street ?? null,
          city: point.city ?? null,
          zip: point.zip ?? null,
          country: point.country ?? null,
        });
      },
      {
        appIdentity: "heyshop-inventory",
        language: options.language || "en",
        ...(options.country
          ? { country: options.country.toLowerCase() }
          : {}),
      },
    );
  });
}
