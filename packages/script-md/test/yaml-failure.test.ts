import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("yaml");
  vi.resetModules();
});

describe("when the YAML parser itself throws", () => {
  it("surfaces a typed front_matter_invalid error and never partial data", async () => {
    vi.resetModules();
    vi.doMock("yaml", async (importOriginal) => ({
      ...(await importOriginal<typeof import("yaml")>()),
      parseDocument: () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
    }));
    const { parseScriptFile, ScriptMdError } = await import("../src/index.js");

    let caught: unknown;
    try {
      parseScriptFile("---\nkind: script\n---\nbody");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptMdError);
    expect(caught).toMatchObject({ code: "front_matter_invalid", httpStatus: 400 });
  });
});
