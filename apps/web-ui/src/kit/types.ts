import type { ComponentType } from "react";

/** What the kit needs from an icon component; every `lucide-react` icon satisfies it. */
export type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;
