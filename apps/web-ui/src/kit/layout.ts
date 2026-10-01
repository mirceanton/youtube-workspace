import { createContext, useContext, useEffect } from "react";

/** Set by the shell; `true` lets the content use the full width instead of the readable maximum. */
export const WideLayoutContext = createContext<(wide: boolean) => void>(() => {});

/**
 * Call from a screen that needs the whole width (a kanban board with many columns). The shell goes
 * back to the readable maximum width when the screen unmounts.
 */
export function useWideLayout(wide = true): void {
  const setWide = useContext(WideLayoutContext);
  useEffect(() => {
    setWide(wide);
    return () => setWide(false);
  }, [setWide, wide]);
}
