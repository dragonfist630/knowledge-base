import { Controller, Get, Query } from "@nestjs/common";
import { UsageQuerySchema, type UsageQuery, type UsageSummaryResponse } from "@kb/shared";

import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { AuthContext } from "../auth/auth-request.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
// Must stay a value import (constructor-injected) — see docs/DECISIONS.md
// Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsageService } from "./usage.service.js";

@Controller("usage")
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get()
  async summarize(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(UsageQuerySchema)) query: UsageQuery,
  ): Promise<UsageSummaryResponse> {
    return this.usageService.summarize(auth, query);
  }
}
