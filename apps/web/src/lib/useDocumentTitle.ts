import { useEffect } from "react";

export const APP_NAME = "YouTube Workspace";

/** Sets `document.title` to "<title> · YouTube Workspace" while the component is mounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · ${APP_NAME}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
