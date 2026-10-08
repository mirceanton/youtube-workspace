import { RESOURCE_LABELS, type Resource } from "@ytw/shared/constants";
import { useCan } from "@/lib/session.ts";
import { useOnlineStatus } from "./useOnlineStatus.ts";

export type WriteBlockReason = "no-access" | "offline";

export interface WriteGuardState {
  /** True when the user may write `resource` and the browser is online. */
  allowed: boolean;
  /** Why not, when `allowed` is false. Offline wins: it is the one the user can fix. */
  reason: WriteBlockReason | null;
  /** A sentence explaining `reason` (null when allowed). */
  message: string | null;
}

/** Same decision as `<WriteGuard>`, for custom UI (a drag handler, a keyboard shortcut). */
export function useWriteGuard(resource: Resource): WriteGuardState {
  const canWrite = useCan(resource, "write");
  const online = useOnlineStatus();
  if (!online) {
    return {
      allowed: false,
      reason: "offline",
      message: "You are offline. Changes cannot be saved until you reconnect.",
    };
  }
  if (!canWrite) {
    return {
      allowed: false,
      reason: "no-access",
      message: `You have read-only access to ${RESOURCE_LABELS[resource].toLowerCase()}, so changes are turned off.`,
    };
  }
  return { allowed: true, reason: null, message: null };
}
