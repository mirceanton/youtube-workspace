import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core on `container` and fails on any violation. jsdom has no layout engine, so the
 * colour-contrast rule is off here (contrast is asserted on the design tokens in tokens.test.ts and
 * checked in a real browser by the Playwright suites).
 */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  ${node.html}`).join("\n")}`,
  );
  // One string to compare, so a failure prints every violation with its markup.
  expect(summary.join("\n\n")).toBe("");
}
