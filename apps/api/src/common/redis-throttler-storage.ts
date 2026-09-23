import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { Redis } from "ioredis";

/**
 * `ThrottlerStorageRecord` is the shape `ThrottlerStorage.increment()` must
 * return, but it isn't exported from @nestjs/throttler's public root —
 * checked directly against the installed package
 * (node_modules/@nestjs/throttler/dist/index.d.ts only re-exports
 * `throttler-storage.interface`, which *imports* `ThrottlerStorageRecord`
 * for its own signature but never re-exports it). Re-declared here to match
 * node_modules/@nestjs/throttler/dist/throttler-storage-record.interface.d.ts
 * exactly.
 */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * A single atomic EVAL implementing a standard fixed-window counter with a
 * separate block flag — NOT a byte-for-byte port of @nestjs/throttler's
 * built-in `ThrottlerStorageService` (which decrements each hit
 * individually, one `setTimeout` per hit, once *that hit's own* ttl
 * elapses — read directly from throttler.service.js). That per-hit-decrement
 * behavior is judged to be an implementation detail of the in-memory
 * storage, not part of the `ThrottlerStorage` contract itself, which only
 * promises "at most `limit` hits per `ttl` window, then blocked for
 * `blockDuration`" (see docs/DECISIONS.md D9.15 for the full reasoning).
 *
 * Two Redis keys per storage `key` (itself already unique per
 * class+handler+throttlerName+tracker — see `ThrottlerGuard.generateKey`,
 * read directly from the installed package's throttler.guard.js, so this
 * storage doesn't need to further namespace by throttlerName itself):
 *
 *   - `throttle:<key>` — a hit counter, `INCR`'d every call, `PEXPIRE`'d
 *     only on the very first increment of a window (`totalHits == 1`) —
 *     later hits don't keep pushing the window's expiry back.
 *   - `throttle:<key>:blocked` — `SET ... PX blockDuration`, only the
 *     moment hits first exceeds `limit`. Its own TTL IS the remaining block
 *     time, so checking "still blocked" is a single `PTTL`, not separate
 *     stored timestamps compared against `now()` the way the in-memory
 *     version does.
 *
 * Both paths (check-if-blocked, and increment-and-maybe-block) run inside
 * one Lua script — the actual reason this needs a script rather than a few
 * separate ioredis calls: two concurrent requests for the same key (two
 * apps/api replicas, or two in-flight requests from the same user) must
 * never both observe "this is hit number N" for the same N, or the limit
 * becomes exactly as racy as the multi-replica problem this whole class
 * exists to fix (docs/SCALING.md item 2).
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl > 0 then
  return {limit + 1, 0, 1, blockPttl}
end

local totalHits = redis.call('INCR', hitsKey)
if totalHits == 1 then
  redis.call('PEXPIRE', hitsKey, ttl)
end

local hitsPttl = redis.call('PTTL', hitsKey)
if hitsPttl < 0 then
  hitsPttl = ttl
  redis.call('PEXPIRE', hitsKey, ttl)
end

if totalHits > limit then
  redis.call('SET', blockKey, 1, 'PX', blockDuration)
  return {totalHits, hitsPttl, 1, blockDuration}
end

return {totalHits, hitsPttl, 0, 0}
`;

/**
 * Wired into ThrottlerModule.forRootAsync's `storage` option
 * (app.module.ts) only when `REDIS_URL` is set — see env.ts. Unset, Nest
 * falls back to its own built-in in-memory `ThrottlerStorageService`
 * exactly as before this class existed (`ThrottlerStorageProvider`'s own
 * factory does that fallback — see throttler.providers.js — this class
 * doesn't need to reimplement it).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      // A rate limiter must never make every request slower — or hang —
      // just because Redis is unreachable. ioredis's default retry
      // strategy queues commands and keeps retrying a connection
      // indefinitely; capping per-command retries means a down Redis
      // surfaces as a fast rejected promise (caught in increment() below)
      // instead of a request hanging until some internal retry budget is
      // exhausted.
      maxRetriesPerRequest: 1,
    });
    this.redis.on("error", (error: Error) => {
      this.logger.error(`redis throttler storage connection error: ${error.message}`);
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const result = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        `throttle:${key}`,
        `throttle:${key}:blocked`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      const [totalHits, hitsPttlMs, isBlockedFlag, blockPttlMs] = result;
      return {
        totalHits,
        // ThrottlerStorageRecord's timeToExpire/timeToBlockExpire are
        // SECONDS, not ms — confirmed against the in-memory
        // implementation's own getExpirationTime/getBlockExpirationTime
        // (Math.ceil(msRemaining / 1000)) in throttler.service.js, so
        // ThrottlerGuard's Retry-After/X-RateLimit-Reset headers get the
        // same units regardless of which storage is active.
        timeToExpire: Math.ceil(hitsPttlMs / 1000),
        isBlocked: isBlockedFlag === 1,
        timeToBlockExpire: Math.ceil(blockPttlMs / 1000),
      };
    } catch (error) {
      // Fail OPEN, not closed: a Redis outage must never turn into every
      // request being rejected (which is what `isBlocked: true` here would
      // do, for every replica, for every user, simultaneously) — a rate
      // limiter that's down is a much smaller problem than an API that's
      // down. Logged, not thrown: ThrottlerGuard.handleRequest has no
      // fallback of its own around this call, so throwing here would 500
      // every request instead of just skipping rate-limiting for this one.
      this.logger.error(
        `redis throttler storage increment failed — allowing request through: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  /**
   * Nest calls this on every provider that implements it when
   * `app.enableShutdownHooks()` is active (see main.ts) — including
   * instances returned from a factory, like this one (see
   * `ThrottlerStorageProvider` in @nestjs/throttler's throttler.providers.js:
   * `provide: ThrottlerStorage, useFactory: (options) => options.storage ?? ...`
   * — the returned object is still a first-class DI instance as far as
   * Nest's lifecycle-hook scanning is concerned).
   */
  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}
