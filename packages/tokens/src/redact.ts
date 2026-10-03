/** Removing token secrets from text that may be logged or shown. */
export const REDACTED_TOKEN = "ytw_[REDACTED]";

/** Replaces anything that looks like a token secret (`ytw_` and 8 or more token characters). */
export function redactTokens(text: string): string {
  return text.replace(/ytw_[A-Za-z0-9_-]{8,}/g, REDACTED_TOKEN);
}
