import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistedState } from "../../src/lib/persisted-state.ts";

const KEY = "ytw.test-preference";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

describe("usePersistedState", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts from the fallback and remembers a change for the next visit", () => {
    const first = renderHook(() => usePersistedState(KEY, false, isBoolean));
    expect(first.result.current[0]).toBe(false);

    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    const second = renderHook(() => usePersistedState(KEY, false, isBoolean));
    expect(second.result.current[0]).toBe(true);
  });

  it("ignores a stored value that is not valid", () => {
    window.localStorage.setItem(KEY, JSON.stringify("yes"));
    expect(renderHook(() => usePersistedState(KEY, false, isBoolean)).result.current[0]).toBe(
      false,
    );

    window.localStorage.setItem(KEY, "{not json");
    expect(renderHook(() => usePersistedState(KEY, false, isBoolean)).result.current[0]).toBe(
      false,
    );
  });

  it("still works as plain state when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    const { result } = renderHook(() => usePersistedState(KEY, false, isBoolean));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
