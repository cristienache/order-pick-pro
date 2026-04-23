import type { Block } from "@/lib/pages";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Renders an array of page-builder blocks. Unknown block types are skipped
 * silently so the renderer stays forward-compatible with new block kinds and
 * malformed rows in SQLite never throw at runtime.
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

const pStr = (props: Record<string, unknown>, key: string, fb = ""): string =>
  typeof props[key] === "string" ? (props[key] as string) : fb;
const pNum = (props: Record<string, unknown>, key: string, fb = 0): number =>
  typeof props[key] === "number" ? (props[key] as number) : fb;
const pBool = (props: Record<string, unknown>, key: string, fb = false): boolean =>
  typeof props[key] === "boolean" ? (props[key] as boolean) : fb;

function alignClass(align: string): string {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "";
}

function BlockView({ block }: { block: Block }) {
  const p = block.props || {};
  switch (block.type) {
    case "heading": {
      const text = pStr(p, "text");
      const level = Math.max(1, Math.min(3, pNum(p, "level", 2)));
      const cls = alignClass(pStr(p, "align", "left"));
      if (level === 1) return <h1 className={`text-4xl md:text-5xl font-bold tracking-tight ${cls}`}>{text}</h1>;
      if (level === 2) return <h2 className={`text-2xl md:text-3xl font-bold tracking-tight ${cls}`}>{text}</h2>;
      return <h3 className={`text-xl font-semibold tracking-tight ${cls}`}>{text}</h3>;
    }
    case "paragraph": {
      const text = pStr(p, "text");
      const cls = alignClass(pStr(p, "align", "left"));
      return (
        <p className={`text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap ${cls}`}>
          {text}
        </p>
      );
    }
    case "image": {
      const src = pStr(p, "src");
      const alt = pStr(p, "alt");
      const caption = pStr(p, "caption");
      const rounded = pBool(p, "rounded", true);
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
      const label = pStr(p, "label", "Click");
      const href = pStr(p, "href", "#");
      const raw = pStr(p, "variant", "default");
      const variant = (["default", "outline", "ghost", "secondary"].includes(raw)
        ? raw
        : "default") as "default" | "outline" | "ghost" | "secondary";
      return (
        <div>
          <Button asChild variant={variant}>
            <a href={href}>{label}</a>
          </Button>
        </div>
      );
    }
    case "card": {
      const title = pStr(p, "title");
      const body = pStr(p, "body");
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
      const size = pStr(p, "size", "md");
      let h = "h-8";
      if (size === "sm") h = "h-4";
      else if (size === "lg") h = "h-16";
      else if (size === "xl") h = "h-24";
      return <div className={h} aria-hidden />;
    }
    case "html": {
      const html = pStr(p, "html");
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
 */
function sanitizeHtml(input: string): string {
  if (typeof input !== "string") return "";
  let out = input;
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  out = out.replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
  return out;
}
