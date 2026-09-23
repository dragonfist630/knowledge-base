import { randomUUID } from "node:crypto";

import { ThrottlerStorageService } from "@nestjs/throttler";
import { afterAll, describe, expect, it } from "vitest";

import { RedisThrottlerStorage } from "./redis-throttler-storage.js";

/**
 * Runs against a REAL local Redis (127.0.0.1:6379, the default `redis-cli`
 * would also use) rather than a mock — this project's established
 * preference for real infrastructure over mocks wherever feasible (see
 * apps/api/test/*.e2e-spec.ts's real Postgres+PostgREST harness). Unlike
 * that harness, a bare Redis needs no schema, no auth, and starts in
 * under a second, so it's treated as a `*.spec.ts` (unit-tier) dependency
 * rather than pulled into the heavier e2e tier — see the CI job comment in
 * .github/workflows/ci.yml's `checks` job for where this Redis instance
 * comes from in CI, and README.md's prerequisites for running locally.
 *
 * Every test uses its own random key prefix so tests can run in any order
 * without clearing the whole database between them.
 */
describe("RedisThrottlerStorage", () => {
  const storage = new RedisThrottlerStorage("redis://127.0.0.1:6379");

  afterAll(() => {
    storage.onApplicationShutdown();
  });

  it("counts hits up to the limit, then blocks — a fresh key starts unblocked", async () => {
    const key = randomUUID();
    const first = await storage.increment(key, 5000, 3, 10_000, "default");
    expect(first).toEqual({ totalHits: 1, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });

    const second = await storage.increment(key, 5000, 3, 10_000, "default");
    expect(second.totalHits).toBe(2);
    expect(second.isBlocked).toBe(false);

    const third = await storage.increment(key, 5000, 3, 10_000, "default");
    expect(third.totalHits).toBe(3);
    expect(third.isBlocked).toBe(false);

    // The 4th hit exceeds limit=3 — this is the actual moment ThrottlerGuard
    // throws ThrottlerException (see throttler.guard.js's handleRequest:
    // `if (isBlocked) { ...; await this.throwThrottlingException(...) }`).
    const fourth = await storage.increment(key, 5000, 3, 10_000, "default");
    expect(fourth.isBlocked).toBe(true);
    expect(fourth.timeToBlockExpire).toBeGreaterThan(0);
    expect(fourth.timeToBlockExpire).toBeLessThanOrEqual(10);
  });

  it("a still-blocked key does not keep incrementing hits, and reports a shrinking timeToBlockExpire", async () => {
    const key = randomUUID();
    for (let i = 0; i < 2; i++) {
      await storage.increment(key, 5000, 1, 10_000, "default");
    }
    // The 2nd call above already exceeded limit=1 and set the block.
    const whileBlocked1 = await storage.increment(key, 5000, 1, 10_000, "default");
    expect(whileBlocked1.isBlocked).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const whileBlocked2 = await storage.increment(key, 5000, 1, 10_000, "default");
    expect(whileBlocked2.isBlocked).toBe(true);
    // Time strictly decreased (at least the ~1.1s this test just slept) —
    // proving the block window isn't being reset/extended by later hits
    // while already blocked, which is exactly the "don't keep counting
    // further hits while blocked" behavior the in-memory implementation
    // also has (see throttler.service.js's own `!this.storage.get(key).isBlocked`
    // guard before firing a new hit).
    expect(whileBlocked2.timeToBlockExpire).toBeLessThan(whileBlocked1.timeToBlockExpire);
  });

  it("returns timeToExpire/timeToBlockExpire in SECONDS, not milliseconds", async () => {
    const key = randomUUID();
    const result = await storage.increment(key, 60_000, 100, 60_000, "default");
    // A 60_000ms ttl should read back as ~60 (seconds), never ~60000 —
    // this is the exact unit ThrottlerGuard's Retry-After/X-RateLimit-Reset
    // headers expect (confirmed against throttler.service.js's own
    // Math.ceil(msRemaining / 1000)).
    expect(result.timeToExpire).toBeGreaterThan(0);
    expect(result.timeToExpire).toBeLessThanOrEqual(60);
  });

  it("many concurrent increments on the same key never observe a duplicate hit number", async () => {
    // The actual reason this needs an atomic Lua script rather than a
    // separate GET-then-INCR-then-maybe-SET sequence of ioredis calls:
    // fire 50 concurrent increments at one key with a limit high enough
    // that none of them block, and confirm every totalHits value handed
    // back is unique — a non-atomic read-modify-write would let two
    // concurrent callers both read the same starting count and hand back
    // the same "next" number.
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.increment(key, 10_000, 1000, 10_000, "default")),
    );
    const totalHitsValues = results.map((r) => r.totalHits);
    expect(new Set(totalHitsValues).size).toBe(50);
    expect(Math.max(...totalHitsValues)).toBe(50);
  });

  it("fails OPEN (allows the request) when Redis is unreachable, instead of throwing or hanging", async () => {
    // An address nothing listens on in this sandbox — maxRetriesPerRequest:1
    // (set in the constructor) is what keeps this from hanging on ioredis's
    // default indefinite reconnect/retry behavior.
    const unreachable = new RedisThrottlerStorage("redis://127.0.0.1:1");
    try {
      const result = await unreachable.increment(randomUUID(), 5000, 3, 10_000, "default");
      expect(result).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
    } finally {
      unreachable.onApplicationShutdown();
    }
  });

  it(
    "two independent RedisThrottlerStorage instances sharing one Redis enforce ONE combined limit — " +
      "the actual bug docs/SCALING.md item 2 describes, fixed",
    async () => {
      const key = randomUUID();
      // Simulates two apps/api replicas, each with its own RedisThrottlerStorage
      // instance (as app.module.ts would construct once per process), pointed
      // at the same Redis.
      const replicaA = new RedisThrottlerStorage("redis://127.0.0.1:6379");
      const replicaB = new RedisThrottlerStorage("redis://127.0.0.1:6379");
      try {
        const limit = 3;
        // 3 requests to replica A, then 3 to replica B — a correctly shared
        // store must block partway through replica B's batch, not give it
        // a fresh budget of its own.
        const aResults = [];
        for (let i = 0; i < 3; i++) aResults.push(await replicaA.increment(key, 5000, limit, 10_000, "default"));
        const bResults = [];
        for (let i = 0; i < 3; i++) bResults.push(await replicaB.increment(key, 5000, limit, 10_000, "default"));

        const allBlockedFlags = [...aResults, ...bResults].map((r) => r.isBlocked);
        // All 3 of replica A's calls succeed (totalHits 1, 2, 3). Replica
        // B's FIRST call is the 4th hit against the same shared key — it's
        // the one that pushes totalHits past limit=3 and blocks; replica
        // B's remaining 2 calls then see that shared block too. If each
        // replica had its own counter (the pre-fix bug), replica B would
        // get a fresh budget of its own and none of its 3 calls would block.
        expect(allBlockedFlags).toEqual([false, false, false, true, true, true]);

        // Contrast with the pre-D9.15 behavior: two independent in-memory
        // ThrottlerStorageService instances (what two real apps/api
        // processes actually had before this fix — each one is its own
        // process with its own Node heap) do NOT share state, so the same
        // 6-call sequence against DIFFERENT storages never blocks at all —
        // this is the literal bug docs/SCALING.md item 2 describes
        // ("effective limit becomes (configured limit) × (instance count)").
        const inMemoryA = new ThrottlerStorageService();
        const inMemoryB = new ThrottlerStorageService();
        const inMemoryResults = [];
        for (let i = 0; i < 3; i++) inMemoryResults.push(await inMemoryA.increment(key, 5000, limit, 10_000, "default"));
        for (let i = 0; i < 3; i++) inMemoryResults.push(await inMemoryB.increment(key, 5000, limit, 10_000, "default"));
        expect(inMemoryResults.some((r) => r.isBlocked)).toBe(false);
        inMemoryA.onApplicationShutdown();
        inMemoryB.onApplicationShutdown();
      } finally {
        replicaA.onApplicationShutdown();
        replicaB.onApplicationShutdown();
      }
    },
  );
});
