import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ThrottlerException, ThrottlerStorageService } from "@nestjs/throttler";
import { beforeEach, describe, expect, it } from "vitest";

import { PreAuthThrottlerGuard } from "./preauth-throttler.guard.js";

/**
 * Builds a minimal fake ExecutionContext — just enough surface for
 * ThrottlerGuard's own canActivate/getRequestResponse/getTracker/
 * generateKey to run against, same pattern the rest of this codebase uses
 * for lightweight guard/service unit tests rather than a full Nest app +
 * real HTTP server (see chat.controller.spec.ts).
 */
function fakeContext(ip: string): ExecutionContext {
  const req: Record<string, unknown> = { ip, headers: {} };
  const res = { header: () => undefined };
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

describe("PreAuthThrottlerGuard", () => {
  let guard: PreAuthThrottlerGuard;

  beforeEach(async () => {
    // Same shape app.module.ts registers: an array of named throttlers,
    // "preauth" alongside two others this guard must NOT also enforce
    // (see its own onModuleInit override) — a low limit here so the test
    // doesn't need hundreds of iterations.
    const options = [
      { name: "default", ttl: 60_000, limit: 120 },
      { name: "chat", ttl: 60_000, limit: 20 },
      { name: "preauth", ttl: 60_000, limit: 3 },
    ];
    guard = new PreAuthThrottlerGuard(options, new ThrottlerStorageService(), new Reflector());
    await guard.onModuleInit();
  });

  it("tracks by IP, not by (missing) auth — the whole point of running before AuthGuard", async () => {
    // Every one of these "requests" is unauthenticated (no req.auth is
    // ever set on the fake request), yet the guard must still track and
    // eventually block them — proving it works independently of whether
    // auth has run yet at all.
    const ctx = fakeContext("203.0.113.5");
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    // The 4th request from the same IP within the window exceeds the
    // preauth bucket's limit of 3 — this is the actual bug fix: before
    // PreAuthThrottlerGuard existed, an unauthenticated flood against a
    // protected route was never rate-limited at all (AuthGuard throws
    // UnauthorizedException before UserThrottlerGuard's canActivate ever
    // runs, so no guard in the chain ever counted the request). See
    // docs/DECISIONS.md.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException);
  });

  it("does not let one IP's flood affect a different IP", async () => {
    const floodedIp = fakeContext("203.0.113.9");
    const otherIp = fakeContext("203.0.113.10");
    await guard.canActivate(floodedIp);
    await guard.canActivate(floodedIp);
    await guard.canActivate(floodedIp);
    await expect(guard.canActivate(floodedIp)).rejects.toBeInstanceOf(ThrottlerException);
    // A different IP has its own, untouched budget.
    expect(await guard.canActivate(otherIp)).toBe(true);
  });

  it("only ever enforces its own preauth bucket, not default/chat too", async () => {
    // Internal, but this is exactly the behavior the guard's own doc
    // comment promises: onModuleInit must have filtered `throttlers` down
    // to the single "preauth" entry, or this guard would double-count
    // every authenticated request against "default"/"chat" a second time
    // (under an IP tracker instead of UserThrottlerGuard's user tracker).
    const throttlers = (guard as unknown as { throttlers: { name: string }[] }).throttlers;
    expect(throttlers.map((t) => t.name)).toEqual(["preauth"]);
  });
});
