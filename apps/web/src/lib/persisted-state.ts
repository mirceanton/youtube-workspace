import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

function read<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * `useState` that remembers its value in this browser (localStorage, JSON). A stored value that
 * `isValid` rejects, or storage that is unavailable, falls back to `fallback`; the state still
 * works for the current page. For per-device display preferences, never for data.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(() => read(key, fallback, isValid));

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be disabled; the preference lasts until the page is closed.
    }
  }, [key, value]);

  return [value, setValue];
}
