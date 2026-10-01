import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_VERSION, parseBaseVersion, parseVersionText } from "../src/index.js";
import { catchScriptMdError } from "./helpers.js";

describe("parseVersionText (shared by the ?base_version= parsers of the MCP service and the web server)", () => {
  it.each([
    ["0", 0],
    ["1", 1],
    ["3", 3],
    ["10", 10],
    ["2147483647", MAX_SCRIPT_VERSION],
  ])("accepts %s", (text, expected) => {
    expect(parseVersionText(text)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "03",
    "00",
    "+3",
    "-3",
    "-0",
    "1e3",
    "1E3",
    "0x3",
    "0b11",
    "3.0",
    "3.",
    ".5",
    "3,000",
    "1_000",
    " 3",
    "3 ",
    "3\n",
    "\n3",
    "\t3",
    "3 4",
    "2147483648",
    "99999999999999999999",
    "Infinity",
    "NaN",
    "three",
    "\uFF13", // full-width digit three
    "\u0663", // Arabic-indic digit three
    "3\u0000",
  ])("rejects %j", (text) => {
    expect(parseVersionText(text)).toBeNull();
  });

  it("rejects values that are not strings", () => {
    for (const value of [3, 0, undefined, null, ["3"], { toString: () => "3" }, true]) {
      expect(parseVersionText(value)).toBeNull();
    }
  });
});

describe("parseBaseVersion", () => {
  it("returns the number for valid text, including 0", () => {
    expect(parseBaseVersion("0")).toBe(0);
    expect(parseBaseVersion("42")).toBe(42);
  });

  it.each(["03", "+3", "1e3", "-1", " 3", "", "abc"])(
    "throws invalid_argument (400) for %j with a usable message",
    (text) => {
      const error = catchScriptMdError(() => parseBaseVersion(text), "invalid_argument");
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain("Invalid base_version");
      expect(error.message).toContain("0 to 2147483647");
    },
  );

  it("throws for a missing or repeated query parameter", () => {
    expect.hasAssertions();
    catchScriptMdError(() => parseBaseVersion(undefined), "invalid_argument");
    catchScriptMdError(() => parseBaseVersion(["1", "2"]), "invalid_argument");
  });
});
