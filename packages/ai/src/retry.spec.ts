import { describe, expect, it, vi } from "vitest";

import { AiError } from "./errors.js";
import { withRetry } from "./retry.js";

describe("withRetry", () => {
  it("returns the result immediately when the function succeeds first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable AiErrors up to maxRetries, then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new AiError("unavailable", "down");
      }
      return "ok";
    });
    const sleep = vi.fn(async () => {});
    const result = await withRetry(fn, { maxRetries: 5, sleep, random: () => 0.5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops retrying and rethrows once maxRetries is exhausted", async () => {
    const fn = vi.fn(async () => {
      throw new AiError("rate_limit", "too many requests");
    });
    await expect(
      withRetry(fn, { maxRetries: 2, sleep: async () => {}, random: () => 0.5 }),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry non-retryable AiErrors (e.g. bad_request)", async () => {
    const fn = vi.fn(async () => {
      throw new AiError("bad_request", "nope");
    });
    await expect(withRetry(fn, { maxRetries: 5, sleep: async () => {} })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-AiError at all", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withRetry(fn, { maxRetries: 5, sleep: async () => {} })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backoff delay grows and stays within the configured cap (with jitter)", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) {
        throw new AiError("timeout", "slow");
      }
      return "ok";
    });
    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      random: () => 1, // no randomness — exercises the upper bound of each window
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    // full-jitter caps: min(1000, 100*2^0)=100, min(1000,100*2^1)=200, min(1000,100*2^2)=400
    expect(delays).toEqual([100, 200, 400]);
  });

  it("aborts immediately via signal instead of sleeping through backoff", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new AiError("unavailable", "down");
    });
    controller.abort();
    await expect(
      withRetry(fn, { maxRetries: 3, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
