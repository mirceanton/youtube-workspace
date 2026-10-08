const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);
const SAME_PAGE_FRAGMENT = /^#[\w.:%-]*$/;

/**
 * Returns a URL that is safe to put in an `href`, or null. Used for every link and image address in
 * agent-written markdown.
 *
 * The decision is made on the browser's own URL parser, and the parser's normalised output is what
 * gets returned, so tricks the browser would see through (leading spaces, tabs or newlines inside
 * the scheme, mixed case, entity-decoded characters) cannot slip past a string check. Only `http`,
 * `https` and `mailto` pass, plus plain same-page fragments. Everything else is refused:
 * `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, app-specific schemes, relative and
 * protocol-relative addresses (`//host`), and links with embedded credentials
 * (`https://trusted.example@evil.example`).
 */
export function sanitizeHref(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  if (SAME_PAGE_FRAGMENT.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** True for addresses that leave the app, which open in a new tab with `noopener`. */
export function isExternalHref(href: string): boolean {
  return !href.startsWith("#") && !href.startsWith("mailto:");
}
