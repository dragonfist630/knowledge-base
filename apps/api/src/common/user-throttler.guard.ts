import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

import type { AuthedRequest } from "../auth/auth-request.js";

/**
 * Rate-limits by user ID, not IP — the brief calls this out explicitly
 * ("rate limiting is a first-class concern at scale"). Falls back to IP for
 * the handful of @Public() routes that never get req.auth populated
 * (/health, /meta/ai) so those still throttle sanely.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as AuthedRequest;
    return request.auth?.userId ?? request.ip ?? "unknown";
  }
}
