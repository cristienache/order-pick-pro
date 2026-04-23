import type { Block } from "@/lib/pages";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Renders an array of page-builder blocks. Unknown block types are skipped
 * silently so the renderer stays forward-compatible with new block kinds.
 *
 * Block prop access uses a small `prop()` helper that coerces unknowns to
 * strings/numbers/booleans with sane fallbacks. Keeps the JSX readable while
 * making sure a malformed row in SQLite never throws at runtime.
 */
export function PageRenderer({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-6">
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} />
      ))}
    </div>
  );
}

function prop<T extends string | number | boolean>(
  props: Record<string, unknown>,
  key: string,
  fallback: T,
): T {
  const v = props[key];
  if (typeof v === typeof fallback) return v as T;
  return fallback;
}

function BlockView({ block }: { block: Block }) {
  const p = block.props || {};
  switch (block.type) {
    case "heading": {
      const text = prop(p, "text", "");
      const level = Math.max(1, Math.min(3, prop(p, "level", 2)));
      const align = prop(p, "align", "left");
      const cls = align === "center" ? "text-center" : align === "right" ? "text-right" : "";
      if (level === 1) return <h1 className={`text-4xl md:text-5xl font-bold tracking-tight ${cls}`}>{text}</h1>;
      if (level === 2) return <h2 className={`text-2xl md:text-3xl font-bold tracking-tight ${cls}`}>{text}</h2>;
      return <h3 className={`text-xl font-semibold tracking-tight ${cls}`}>{text}</h3>;
    }
    case "paragraph": {
      const text = prop(p, "text", "");
      const align = prop(p, "align", "left");
      const cls = align === "center" ? "text-center" : align === "right" ? "text-right" : "";
      return (
        <p className={`text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap ${cls}`}>
          {text}
        </p>
      );
    }
    case "image": {
      const src = prop(p, "src", "");
      const alt = prop(p, "alt", "");
      const caption = prop(p, "caption", "");
      const rounded = prop(p, "rounded", true);
      if (!src) return null;
      return (
        <figure className="space-y-2">
          <img
            src={src}
            alt={alt}
            loading="lazy"
            className={`w-full h-auto ${rounded ? "rounded-2xl" : ""} border border-border/60`}
          />
          {caption && (
            <figcaption className="text-xs text-muted-foreground text-center">
              {caption}
            </figcaption>
          )}
        </figure>
      );
    }
    case "button": {
      const label = prop(p, "label", "Click");
      const href = prop(p, "href", "#");
      const variant = prop(p, "variant", "default") as
        | "default" | "outline" | "ghost" | "secondary";
      return (
        <div>
          <Button asChild variant={variant}>
            <a href={href}>{label}</a>
          </Button>
        </div>
      );
    }
    case "card": {
      const title = prop(p, "title", "");
      const body = prop(p, "body", "");
      return (
        <Card>
          {title && (
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap">
            {body}
          </CardContent>
        </Card>
      );
    }
    case "divider":
      return <hr className="border-border/60" />;
    case "spacer": {
      const size = prop(p, "size", "md");
      const h = size === "sm" ? "h-4" : size === "lg" ? "h-16" : size === "xl" ? "h-24" : "h-8";
      return <div className={h} aria-hidden />;
    }
    case "html": {
      const html = prop(p, "html", "");
      return (
        <div
          className="prose prose-sm md:prose-base max-w-none dark:prose-invert"
          // eslint-disable-next-line react/no-danger -- sanitized below
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
        />
      );
    }
    default:
      return null;
  }
}

/**
 * Tiny allow-list HTML sanitiser. We only ever render content authored by
 * admins, but defence-in-depth: strip <script>, on* attributes and
 * javascript: URLs so a copy-pasted snippet can't smuggle JS into the page.
 *
 * For richer HTML editing we'd swap to DOMPurify, but pulling in the lib
 * just for a handful of admin-authored blocks isn't worth the bytes yet.
 */
function sanitizeHtml(input: string): string {
  if (typeof input !== "string") return "";
  let out = input;
  // Remove <script>...</script> entirely.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove on* event-handler attributes: onclick=, onerror=, etc.
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // Neutralise javascript: URLs in href / src.
  out = out.replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
  return out;
}
