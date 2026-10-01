import type { ReactNode } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@/lib/cx.ts";
import { isExternalHref, sanitizeHref } from "@/lib/safe-url.ts";
import { remarkHeadingLevels } from "./markdown-headings.ts";

// The real renderer behind <MarkdownView>; loaded lazily so react-markdown (and its unified
// toolchain) stays out of the initial bundle.
//
// Safety, in layers:
//  1. react-markdown builds React elements; it never uses dangerouslySetInnerHTML. Raw HTML in the
//     source is not parsed, it is shown as literal text.
//  2. Every link and image address goes through `sanitizeHref` (http, https, mailto, same-page
//     fragments only) both in `urlTransform` and again in the component that renders it.
//  3. Images are never loaded: an image becomes a link to its address, so agent-written markdown
//     cannot make the browser fetch a tracking pixel or exfiltrate data through an image URL.
//  4. External links open in a new tab with rel="noopener noreferrer nofollow ugc".

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
type PluggableList = NonNullable<Options["remarkPlugins"]>;

export interface MarkdownViewImplProps {
  markdown: string;
  className?: string;
  /**
   * The level of the document's shallowest heading (default 3, below the page's h1 and h2); the
   * others keep their relative depth, never skip a level and stop at h6.
   */
  headingStart?: HeadingLevel;
}

function safeUrl(url: string): string {
  return sanitizeHref(url) ?? "";
}

function SafeLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const safe = href ? sanitizeHref(href) : null;
  if (!safe) return <span>{children}</span>;
  if (!isExternalHref(safe)) return <a href={safe}>{children}</a>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow ugc" title={safe}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function buildComponents(): Components {
  return {
    a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
    img: ({ src, alt }) => {
      const label = alt ? `Image: ${alt}` : "Image";
      return src ? <SafeLink href={src}>{label}</SafeLink> : <span>{label}</span>;
    },
    table: ({ children }) => (
      <div className="markdown-table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

const COMPONENTS = buildComponents();

const PLUGINS_BY_START = new Map<HeadingLevel, PluggableList>();
function pluginsFor(start: HeadingLevel): PluggableList {
  let plugins = PLUGINS_BY_START.get(start);
  if (!plugins) {
    plugins = [remarkGfm, remarkHeadingLevels(start)];
    PLUGINS_BY_START.set(start, plugins);
  }
  return plugins;
}

export default function MarkdownViewImpl({
  markdown,
  className,
  headingStart = 3,
}: MarkdownViewImplProps) {
  return (
    <div className={cx("markdown", className)}>
      <Markdown
        remarkPlugins={pluginsFor(headingStart)}
        urlTransform={safeUrl}
        components={COMPONENTS}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
