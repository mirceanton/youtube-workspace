// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// WCAG 2.1 AA for the design tokens in src/styles/tokens.css, in both colour schemes (PRD 6).

type Palette = Record<string, string>;

function parseBlock(block: string): Palette {
  const palette: Palette = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    palette[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return palette;
}

function loadPalettes(): { light: Palette; dark: Palette } {
  const css = readFileSync(
    resolve(import.meta.dirname, "../../src/styles/tokens.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const mediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
  expect(mediaStart, "tokens.css needs a prefers-color-scheme: dark block").toBeGreaterThan(-1);
  const light = parseBlock(css.slice(0, mediaStart));
  const dark = { ...light, ...parseBlock(css.slice(mediaStart)) };
  return { light, dark };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const UI = 3;

/** [foreground, background, minimum ratio]: text needs 4.5:1, borders/focus rings of controls 3:1. */
const PAIRS: [string, string, number][] = [
  ["ink", "canvas", TEXT],
  ["ink", "surface", TEXT],
  ["ink", "subtle", TEXT],
  ["ink-muted", "canvas", TEXT],
  ["ink-muted", "surface", TEXT],
  ["ink-muted", "subtle", TEXT],
  ["brand-ink", "brand", TEXT],
  ["brand", "canvas", TEXT],
  ["brand", "surface", TEXT],
  ["link", "canvas", TEXT],
  ["link", "surface", TEXT],
  ["link", "subtle", TEXT],
  ["danger", "canvas", TEXT],
  ["danger", "surface", TEXT],
  ["danger", "danger-soft", TEXT],
  ["ok", "canvas", TEXT],
  ["ok", "surface", TEXT],
  ["ok", "ok-soft", TEXT],
  ["warn", "canvas", TEXT],
  ["warn", "surface", TEXT],
  ["warn", "warn-soft", TEXT],
  ["info", "canvas", TEXT],
  ["info", "surface", TEXT],
  ["info", "info-soft", TEXT],
  ["ink", "danger-soft", TEXT],
  ["ink", "ok-soft", TEXT],
  ["ink", "warn-soft", TEXT],
  ["ink", "info-soft", TEXT],
  ["line-strong", "canvas", UI],
  ["line-strong", "surface", UI],
  ["focus", "canvas", UI],
  ["focus", "surface", UI],
  ["focus", "subtle", UI],
];

describe.each(["light", "dark"] as const)("design tokens, %s scheme", (scheme) => {
  const palette = loadPalettes()[scheme];

  it.each(PAIRS)("%s on %s is at least %s:1", (fg, bg, minimum) => {
    const foreground = palette[fg];
    const background = palette[bg];
    expect(foreground, `--${fg} is defined`).toBeDefined();
    expect(background, `--${bg} is defined`).toBeDefined();
    const ratio = contrast(foreground as string, background as string);
    expect(
      ratio,
      `${fg} ${foreground} on ${bg} ${background} = ${ratio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(minimum);
  });

  it("keeps the chart colours distinguishable from the surface (3:1) or relies on the text alternative", () => {
    // The data-viz palette is validated as a set; slots 3 and 4 sit under 3:1 on the light surface,
    // which is why every chart ships a summary and a data table. Slots 1 and 2 must clear 3:1.
    for (const slot of ["chart-1", "chart-2"]) {
      expect(contrast(palette[slot] as string, palette.surface as string)).toBeGreaterThanOrEqual(
        UI,
      );
    }
  });
});

describe("the two schemes", () => {
  it("define exactly the same tokens", () => {
    const { light, dark } = loadPalettes();
    expect(Object.keys(dark).toSorted()).toEqual(Object.keys(light).toSorted());
  });

  it("differ (dark is not a copy of light)", () => {
    const { light, dark } = loadPalettes();
    expect(dark.canvas).not.toBe(light.canvas);
    expect(luminance(dark.canvas as string)).toBeLessThan(luminance(light.canvas as string));
  });
});
