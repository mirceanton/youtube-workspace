import { ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { meetsRequirement, useSession, type FeatureAccess } from "@/lib/session.ts";
import { EmptyState } from "./states.tsx";

export interface RequireAccessProps {
  requires: FeatureAccess;
  /** Rendered when the user qualifies. Omitted, the matching child route (`<Outlet />`) is rendered. */
  children?: ReactNode;
  /** What to show otherwise. Defaults to a "no access" message. */
  fallback?: ReactNode;
}

/**
 * Shows its content only when the user's stored levels satisfy `requires`. The shell wraps every
 * feature's routes in this using the feature's `requires`; use it directly for a part of a screen
 * (an admin-only tab). It is cosmetic: the server checks every request again.
 */
export function RequireAccess({ requires, children, fallback }: RequireAccessProps) {
  const { levels } = useSession();
  if (meetsRequirement(levels, requires)) return children ?? <Outlet />;
  return (
    fallback ?? (
      <EmptyState
        icon={ShieldOff}
        title="You do not have access to this"
        description="Ask the workspace owner to change your access levels if you need it."
      />
    )
  );
}
