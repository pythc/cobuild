import { describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => options,
}));
vi.mock("../services/auth-service", () => ({
  getCollabToken: vi.fn(),
  verifyUserToken: vi.fn(),
}));
import { useCollabToken } from "./auth-query";

describe("collaboration token request retry policy", () => {
  const options = () => useCollabToken() as any;
  const error = (status: number) =>
    new AxiosError("fixture", undefined, undefined, undefined, {
      status,
    } as any);
  it("never retries an explicit authentication or permission denial", () => {
    for (const status of [400, 401, 403, 404])
      expect(options().retry(0, error(status))).toBe(false);
  });
  it("bounds retries for server outage, throttling and missing network response", () => {
    for (const e of [error(503), error(429), new AxiosError("offline")]) {
      expect(options().retry(0, e)).toBe(true);
      expect(options().retry(6, e)).toBe(false);
    }
  });
  it("caps exponential retry delay instead of leaving the page waiting for hours", () => {
    expect(options().retryDelay(0)).toBe(1000);
    expect(options().retryDelay(5)).toBe(30_000);
    expect(options().retryDelay(20)).toBe(30_000);
  });
});
