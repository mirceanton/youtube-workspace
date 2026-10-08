import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const getSnapshot = (): boolean => navigator.onLine;
// Server snapshot is unused in a client-only SPA, but React requires the argument when rendering to a string.
const getServerSnapshot = (): boolean => true;

/** `false` while the browser reports no network connection. Updates on the online/offline events. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
