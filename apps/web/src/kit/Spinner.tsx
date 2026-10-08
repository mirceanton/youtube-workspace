import { Loader2 } from "lucide-react";
import { cx } from "@/lib/cx.ts";

/** Decorative spinner (hidden from assistive technology); pair it with text or a `role="status"` label. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden="true"
      className={cx("animate-spin motion-reduce:animate-none", className)}
    />
  );
}
