import { Module } from "@nestjs/common";

import { AuthGuard } from "./auth.guard.js";

/**
 * AuthGuard is exported, not bound as APP_GUARD here: it must run *before*
 * UserThrottlerGuard (registered in app.module.ts) so requests are already
 * throttled by user ID, not just IP, by the time the throttler guard runs.
 * Multiple APP_GUARD providers only have a deterministic order when they're
 * registered together, in order, in the same module's `providers` array —
 * see app.module.ts and docs/DECISIONS.md Phase 3.
 */
@Module({
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
