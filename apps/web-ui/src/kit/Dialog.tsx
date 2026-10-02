import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { cx } from "@/lib/cx.ts";
import { Button } from "./Button.tsx";

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button and a click on the backdrop (when `dismissible`). */
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  /** `false` removes the close button and ignores Escape/backdrop clicks: the user must choose. */
  dismissible?: boolean;
  size?: "sm" | "md" | "lg";
  /** Element that gets focus when the dialog opens; defaults to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
}

const WIDTHS = { sm: "sm:max-w-md", md: "sm:max-w-xl", lg: "sm:max-w-3xl" } as const;

/**
 * Modal dialog on the native `<dialog>` element: focus is trapped, the page behind is inert, Escape
 * works and focus returns to the opener, all by the browser. On phones it is a bottom sheet.
 * The dialog is controlled: it closes only when the parent sets `open` to false.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  size = "md",
  initialFocus,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocus]);

  // A click on the dialog element itself (not on its content) hit the backdrop: the dialog has no
  // padding, so its content fills the whole box. Native listener: <dialog> is not an interactive
  // element for the JSX lint rules, and keyboard users close it with Escape (onCancel above).
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !dismissible) return;
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose();
    };
    dialog.addEventListener("click", onClick);
    return () => dialog.removeEventListener("click", onClick);
  }, [dismissible, onClose]);

  // Closing the page (route change) while open must not leave the page inert.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Keep React in charge: ask the parent to close instead of letting the browser do it.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      className={cx(
        "m-auto w-full max-w-none rounded-xl border border-line bg-surface p-0 text-ink shadow-xl",
        "backdrop:bg-black/50 max-sm:mb-0 max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
        WIDTHS[size],
        className,
      )}
    >
      {open ? (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description ? (
                <div id={descriptionId} className="mt-1 text-sm text-ink-muted">
                  {description}
                </div>
              ) : null}
            </div>
            {dismissible ? (
              <Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onClose}>
                <X aria-hidden="true" className="size-5" />
              </Button>
            ) : null}
          </div>
          {children ? <div className="overflow-y-auto px-5 py-4">{children}</div> : null}
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4 max-sm:flex-col max-sm:*:w-full">
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
