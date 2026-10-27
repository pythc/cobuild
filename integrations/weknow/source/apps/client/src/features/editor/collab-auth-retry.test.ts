import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabAuthRetry, IDENTITY_UNAVAILABLE } from "./collab-auth-retry";

describe("collaboration authentication recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("coalesces repeated failures and backs off to a bounded interval", () => {
    const callback = vi.fn();
    const retry = new CollabAuthRetry(callback);
    retry.failed(IDENTITY_UNAVAILABLE);
    retry.failed(IDENTITY_UNAVAILABLE);
    vi.advanceTimersByTime(1999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    retry.failed(IDENTITY_UNAVAILABLE);
    vi.advanceTimersByTime(3999);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(2);
    retry.dispose();
  });
  it("cancels pending retries immediately when access is explicitly denied", () => {
    const callback = vi.fn();
    const retry = new CollabAuthRetry(callback);
    retry.failed(IDENTITY_UNAVAILABLE);
    retry.failed("permission-denied");
    vi.advanceTimersByTime(60_000);
    expect(callback).not.toHaveBeenCalled();
    retry.dispose();
  });
  it("does not retry after a successful handshake or unmount", () => {
    const callback = vi.fn();
    const retry = new CollabAuthRetry(callback);
    retry.failed(IDENTITY_UNAVAILABLE);
    retry.reset();
    vi.advanceTimersByTime(60_000);
    expect(callback).not.toHaveBeenCalled();
    retry.failed(IDENTITY_UNAVAILABLE);
    retry.dispose();
    retry.failed(IDENTITY_UNAVAILABLE);
    vi.advanceTimersByTime(60_000);
    expect(callback).not.toHaveBeenCalled();
  });
});
