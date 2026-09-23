import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Runs BEFORE AuthGuard (see app.module.ts's provider order comment) and
 * rate-limits by IP alone, checking only its own "preauth" bucket.
 *
 * Without this, an unauthenticated flood — no `Authorization` header, or a
 * garbage bearer token, thrown against any protected route in an unbounded
 * loop — was never rate-limited at all: AuthGuard throws UnauthorizedException
 * before UserThrottlerGuard's own canActivate ever runs (a Nest guard chain
 * stops at the first guard that throws), so the per-user "default"/"chat"
 * buckets, which only exist to keep *authenticated* traffic sane, never got
 * a chance to count the request. Each such request was still real, billable
 * work (AuthGuard.verify() makes a network round trip to Supabase's
 * auth/JWKS endpoint before it can even determine the token is invalid) —
 * exactly the traffic pattern a rate limiter exists to stop. See
 * docs/DECISIONS.md.
 *
 * A separate, independent bucket rather than reusing "default"/"chat":
 * this guard runs on every request regardless of whether auth later
 * succeeds, so folding it into the same named buckets UserThrottlerGuard
 * already enforces per-user would mean legitimate authenticated traffic
 * also gets counted against an IP-shared ceiling — a real cost for users
 * behind a shared/NAT IP. Keeping "preauth" separate (and deliberately
 * generous — see THROTTLE_PREAUTH_LIMIT/TTL — well above any plausible
 * legitimate per-IP volume) means it only ever engages at flood-level
 * volume, leaving the per-user buckets' own behavior completely unchanged.
 */
@Injectable()
export class PreAuthThrottlerGuard extends ThrottlerGuard {
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    // Only ever check this guard's own "preauth" bucket — without this,
    // the base class's generic multi-throttler canActivate would also
    // re-check "default"/"chat" here (under an IP tracker instead of
    // UserThrottlerGuard's user tracker), duplicating checks that guard
    // already makes.
    this.throttlers = this.throttlers.filter((throttler) => throttler.name === "preauth");
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return typeof req.ip === "string" && req.ip.length > 0 ? req.ip : "unknown";
  }
}
