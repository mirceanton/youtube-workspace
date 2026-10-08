import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "@/lib/cx.ts";
import { useDocumentTitle } from "@/lib/useDocumentTitle.ts";

export interface PageHeaderProps {
  /** The page's `<h1>`; also becomes the browser tab title. */
  title: string;
  description?: ReactNode;
  /** Buttons aligned to the right (stacked under the title on phones). */
  actions?: ReactNode;
  /** A link back to the parent screen, for detail pages. */
  back?: { to: string; label: string };
  className?: string;
}

/** Top of every screen: optional back link, the one `<h1>`, a description and actions. */
export function PageHeader({ title, description, actions, back, className }: PageHeaderProps) {
  useDocumentTitle(title);
  return (
    <header className={cx("mb-4 flex flex-col gap-3 sm:mb-6", className)}>
      {back ? (
        <Link
          to={back.to}
          className="-ms-2 inline-flex min-h-11 items-center gap-1 self-start rounded-lg px-2 text-sm font-medium text-link hover:bg-subtle"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description ? <p className="mt-1 text-ink-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
