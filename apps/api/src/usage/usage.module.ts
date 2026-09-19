import { Module } from "@nestjs/common";

import { UsageController } from "./usage.controller.js";
import { UsageRepository } from "./usage.repository.js";
import { UsageService } from "./usage.service.js";

@Module({
  controllers: [UsageController],
  providers: [UsageService, UsageRepository],
})
export class UsageModule {}
