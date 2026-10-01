import { expect } from "vitest";
import { ScriptMdError, type ScriptMdErrorCode } from "../src/index.js";

export const IDEA_ID = "0190f3a2-7c1e-7b52-9d0e-3f4a5b6c7d8e";
export const OTHER_IDEA_ID = "0190f3a2-7c1e-7b52-9d0e-aaaaaaaaaaaa";

/** Runs `fn`, asserts it throws a ScriptMdError with `code`, and returns the error. */
export function catchScriptMdError(fn: () => unknown, code: ScriptMdErrorCode): ScriptMdError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code} to be thrown`).toBeInstanceOf(ScriptMdError);
  const error = caught as ScriptMdError;
  expect(error.code).toBe(code);
  return error;
}

/** A complete exported file as agents see it. */
export function exportedFile(
  parts: { body?: string; version?: number; status?: string; kind?: string; ideaId?: string } = {},
): string {
  const { body = "# Hook\n\nHello.\n", version = 3, status = "draft", kind = "script" } = parts;
  const ideaId = parts.ideaId ?? IDEA_ID;
  return `---\nidea_id: ${ideaId}\nkind: ${kind}\nversion: ${version}\nstatus: ${status}\n---\n\n${body}`;
}

/** Small deterministic PRNG (mulberry32) so randomized tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
