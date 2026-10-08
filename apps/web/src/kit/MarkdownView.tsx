import { lazy, Suspense } from "react";
import { cx } from "@/lib/cx.ts";
import type { MarkdownViewImplProps } from "./MarkdownViewImpl.tsx";

// Dynamic import: react-markdown and remark-gfm are fetched when the first markdown is shown.
const MarkdownViewImpl = lazy(() => import("./MarkdownViewImpl.tsx"));

export type MarkdownViewProps = MarkdownViewImplProps;

/**
 * Renders agent- or human-written markdown (GitHub-flavoured) as sanitised React elements.
 *
 * - Raw HTML is never rendered: it appears as literal text.
 * - Links only keep http, https, mailto and same-page fragments, open in a new tab with
 *   `rel="noopener noreferrer nofollow ugc"`; any other address becomes plain text.
 * - Images are never loaded; they are shown as a link to the image.
 *
 * While the renderer loads, the raw text is shown (as text, never as HTML), so there is no layout
 * jump to nothing. Spacing is in `em`, so a parent that sets `font-size` scales the whole block.
 * `headingStart` is the level a markdown `#` becomes (default `h3`, below the page's `h1`/`h2`).
 */
export function MarkdownView({ markdown, className, headingStart }: MarkdownViewProps) {
  return (
    <Suspense
      fallback={
        <div className={cx("markdown whitespace-pre-wrap", className)} data-markdown-loading="">
          {markdown}
        </div>
      }
    >
      <MarkdownViewImpl
        markdown={markdown}
        {...(className ? { className } : {})}
        {...(headingStart ? { headingStart } : {})}
      />
    </Suspense>
  );
}
