import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { setCsrfToken } from "../src/lib/csrf.ts";
import { resetLoginRedirect } from "../src/lib/navigation.ts";

// jsdom does not implement the modal parts of <dialog>. This mirrors the behaviour the kit relies
// on: showModal() opens it, close() closes it and fires "close". (Real focus trapping and the top
// layer are browser features, covered by the Playwright suites.)
function openDialog(this: HTMLDialogElement) {
  this.setAttribute("open", "");
}

function closeDialog(this: HTMLDialogElement) {
  if (!this.hasAttribute("open")) return;
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
}

function noMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as MediaQueryList;
}

// The node-environment suites (test/node) run without a DOM.
const hasDom = typeof window !== "undefined";

if (hasDom) {
  if (typeof HTMLDialogElement !== "undefined") {
    HTMLDialogElement.prototype.show = openDialog;
    HTMLDialogElement.prototype.showModal = openDialog;
    HTMLDialogElement.prototype.close = closeDialog;
  }
  // jsdom has no matchMedia; the chart wrapper listens for colour-scheme changes.
  if (typeof window.matchMedia !== "function") window.matchMedia = noMatchMedia;
}

beforeEach(() => {
  setCsrfToken(undefined);
  resetLoginRedirect();
  if (hasDom) document.title = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
