import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";

// GET /meta/ai (provider descriptors for the frontend badge) lands here in
// Phase 3, once packages/ai exists (Phase 2).
@Module({
  controllers: [HealthController],
})
export class MetaModule {}
