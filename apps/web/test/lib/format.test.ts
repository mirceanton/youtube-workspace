import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent } from "../../src/lib/format.ts";

describe("formatDuration", () => {
  it("steps from seconds to minutes to hours", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(222)).toBe("3m 42s");
    expect(formatDuration(3725)).toBe("1h 02m");
  });

  it("rounds before splitting, so 59.6 s rolls over instead of showing 60s", () => {
    expect(formatDuration(59.6)).toBe("1m 00s");
    expect(formatDuration(3599.7)).toBe("1h 00m");
  });
});

describe("formatPercent", () => {
  it("keeps at most two decimals and drops a trailing zero fraction", () => {
    expect(formatPercent(4.5234)).toBe("4.52%");
    expect(formatPercent(5)).toBe("5%");
  });
});
