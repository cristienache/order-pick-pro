/**
 * Phase 2 of the page builder — custom content pages.
 *
 * A page is a slug, some metadata and an ordered array of blocks. Each block
 * has a stable string `type` and a free-form `props` bag. The renderer in
 * src/components/page-renderer.tsx whitelists which `type` values it knows;
 * unknown types are dropped silently so old database rows never crash the UI
 * and new block types can ship as a pure frontend change.
 */

export type BlockType =
  | "heading"
  | "paragraph"
  | "image"
  | "button"
  | "divider"
  | "spacer"
  | "card"
  | "html";

export type Block = {
  /** Stable, generated client-side. Used as React key + drag handle later. */
  id: string;
  type: BlockType | string;
  props: Record<string, unknown>;
};

export type Page = {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  blocks: Block[];
  published: boolean;
  show_in_nav: boolean;
  created_at: string;
  updated_at: string;
};

export type PageNavItem = { id: number; slug: string; title: string };

/** Catalogue used by the admin editor — drives the "Add block" menu and
 *  initial defaults for each block kind. Keep this in sync with the renderer. */
export const BLOCK_CATALOGUE: Array<{
  type: BlockType;
  label: string;
  description: string;
  defaults: Record<string, unknown>;
}> = [
  {
    type: "heading",
    label: "Heading",
    description: "Large title — H1, H2 or H3.",
    defaults: { text: "Section heading", level: 2, align: "left" },
  },
  {
    type: "paragraph",
    label: "Paragraph",
    description: "A block of body text.",
    defaults: {
      text: "Write something descriptive here. Plain text is fine; line breaks are preserved.",
      align: "left",
    },
  },
  {
    type: "image",
    label: "Image",
    description: "Picture by URL with optional caption.",
    defaults: { src: "", alt: "", caption: "", rounded: true },
  },
  {
    type: "button",
    label: "Button",
    description: "Call-to-action that links somewhere.",
    defaults: { label: "Learn more", href: "/", variant: "default" },
  },
  {
    type: "card",
    label: "Card",
    description: "Title + body inside a soft card.",
    defaults: { title: "Card title", body: "Card body content." },
  },
  {
    type: "divider",
    label: "Divider",
    description: "Thin horizontal rule.",
    defaults: {},
  },
  {
    type: "spacer",
    label: "Spacer",
    description: "Vertical breathing room.",
    defaults: { size: "md" },
  },
  {
    type: "html",
    label: "Raw HTML (sanitised)",
    description: "Inline HTML — tags whitelisted to a safe subset.",
    defaults: { html: "<p>Hello <strong>world</strong>.</p>" },
  },
];

/** Generate a short, unique-enough id for a block. */
export function newBlockId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Build a block with sensible defaults for a given type. */
export function makeBlock(type: BlockType): Block {
  const entry = BLOCK_CATALOGUE.find((b) => b.type === type);
  return { id: newBlockId(), type, props: { ...(entry?.defaults || {}) } };
}

/** Slugify a free-form string for the slug input. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
