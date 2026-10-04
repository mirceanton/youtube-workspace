import { focusManager, QueryObserver } from "@tanstack/react-query";
import { LIVE_UPDATE_INTERVAL_MS } from "@ytw/shared/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ForbiddenError,
  NetworkError,
  ResponseShapeError,
} from "../../src/lib/errors.ts";
import { createQueryClient, shouldRetry } from "../../src/lib/query-client.ts";

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe("createQueryClient defaults", () => {
  it("polls every 12 seconds to meet the PRD 6 fifteen-second SLA and pauses in a hidden tab", () => {
    const { queries } = createQueryClient().getDefaultOptions();
    expect(LIVE_UPDATE_INTERVAL_MS).toBe(12_000);
    expect(queries?.refetchInterval).toBe(12_000);
    expect(queries?.refetchIntervalInBackground).toBe(false);
    expect(queries?.refetchOnWindowFocus).toBe(true);
    expect(queries?.refetchOnReconnect).toBe(true);
  });

  it("never queues mutations offline (v1 has no offline writes)", () => {
    const { mutations } = createQueryClient().getDefaultOptions();
    expect(mutations?.networkMode).toBe("always");
    expect(mutations?.retry).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("retries network failures and server errors twice", () => {
    expect(shouldRetry(0, new NetworkError())).toBe(true);
    expect(shouldRetry(1, new ApiError("boom", 500))).toBe(true);
    expect(shouldRetry(2, new ApiError("boom", 500))).toBe(false);
  });

  it("does not retry answers that retrying cannot change", () => {
    expect(shouldRetry(0, new ForbiddenError("no"))).toBe(false);
    expect(shouldRetry(0, new ApiError("missing", 404))).toBe(false);
    expect(shouldRetry(0, new ResponseShapeError("/api/me", new Error("x")))).toBe(false);
  });
});

function observe(fn: () => Promise<number>) {
  const client = createQueryClient();
  client.mount(); // what <QueryClientProvider> does: subscribe to focus and online events
  const observer = new QueryObserver(client, { queryKey: ["live"], queryFn: fn });
  const stop = observer.subscribe(() => undefined);
  return {
    client,
    unsubscribe: () => {
      stop();
      client.unmount();
    },
  };
}

describe("live updates", () => {
  it("refetches an active query every 12 seconds", async () => {
    vi.useFakeTimers();
    const fn = vi.fn<() => Promise<number>>(() => Promise.resolve(1));
    const { unsubscribe } = observe(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fn).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("pauses while the tab is hidden and catches up when it is shown again", async () => {
    vi.useFakeTimers();
    const fn = vi.fn<() => Promise<number>>(() => Promise.resolve(1));
    const { unsubscribe } = observe(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);

    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});
